import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// The provider is the only external: every test drives a fake one, built by
// the (mocked) factory so the service's own wiring runs for real.
const created: FakeProvider[] = [];
vi.mock('../src/llm/voice-provider-factory.mjs', async (importOriginal) => ({
    ...(await importOriginal() as object),
    createVoiceProvider: vi.fn((_homey: any, _tm: any, options: any) => {
        const p = new FakeProvider(options);
        created.push(p);
        return p;
    }),
}));
vi.mock('../src/helpers/file-helper.mjs', async (importOriginal) => ({
    ...(await importOriginal() as object),
    scheduleAudioFileDeletion: vi.fn(),
}));

import { FlowAssistant } from '../src/homey/flow-assistant.mjs';
import { pcmToFlacBuffer } from '../src/helpers/audio-encoders.mjs';
import { scheduleAudioFileDeletion } from '../src/helpers/file-helper.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

/** One second of 24 kHz mono FLAC, as every provider's textToSpeech returns. */
async function flacSecond(): Promise<Buffer> {
    const pcm = Buffer.alloc(24_000 * 2);
    for (let i = 0; i < 24_000; i++) {
        pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24_000)), i * 2);
    }
    return pcmToFlacBuffer(pcm, { sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
}

class FakeProvider extends EventEmitter {
    connected = false;
    apiKey = true;
    voicesUsed: string[] = [];
    questions: string[] = [];
    resets = 0;
    closed = 0;
    answer = 'The dishwasher is done.';
    echo = false;

    constructor(public options: any) {
        super();
    }

    hasApiKey() { return this.apiKey; }
    isConnected() { return this.connected; }
    async start() {
        // Asynchronous like the real ones: 'open' arrives after start() resolves.
        setTimeout(() => { this.connected = true; this.emit('open'); }, 1);
    }
    close() { this.connected = false; this.closed++; this.emit('close', 1000, ''); }
    resetConversation() { this.resets++; }
    async updateVoice(v: string) { this.options.voice = v; }
    async textToSpeech(_text: string) {
        this.voicesUsed.push(this.options.voice);
        return flacSecond();
    }
    sendTextForTextResponse(q: string) {
        this.questions.push(q);
        setTimeout(() => this.emit('text.done', { text: this.echo ? `re: ${q}` : this.answer }), 1);
    }
}

describe('FlowAssistant', () => {
    let homey: MockHomey;
    let assistant: FlowAssistant;
    let buildStream: ReturnType<typeof vi.fn>;
    let fetchData: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        created.length = 0;
        settingsManager.reset();
        homey = new MockHomey();
        homey.setMockSetting('selected_voice', 'alloy');
        settingsManager.init(homey);
        buildStream = vi.fn(async (_audio: any) => ({ filename: 'flow_x.mp3', filepath: '/tmp/flow_x.mp3', url: 'http://homey/flow_x.mp3' }));
        fetchData = vi.fn(async () => { });
        const services: any = {
            webServer: { buildStream },
            deviceManager: { fetchData },
            geoHelper: {},
            weatherHelper: {},
        };
        assistant = new FlowAssistant(homey, services);
        assistant.init();
    });

    afterEach(() => {
        assistant.dispose();
        settingsManager.reset();
    });

    it('speaks without connecting: MP3 file, URL and duration come back', async () => {
        const result = await assistant.speak('Hello');

        expect(result).toEqual({ url: 'http://homey/flow_x.mp3', duration: 1 });
        const audio = buildStream.mock.calls[0][0];
        expect(audio.extension).toBe('mp3');
        expect(audio.prefix).toBe('flow');
        expect(audio.data.length).toBeGreaterThan(0);
        // TTS is a plain HTTP call — no realtime session needed.
        expect(created[0].connected).toBe(false);
        // Deletion is pushed out past playback by the Flow grace.
        expect((scheduleAudioFileDeletion as any).mock.calls.at(-1)[2]).toBeGreaterThan(5 * 60_000);
    });

    it('applies a per-call voice and restores the app voice afterwards', async () => {
        await assistant.speak('One', 'nova');
        await assistant.speak('Two');

        expect(created[0].voicesUsed).toEqual(['nova', 'alloy']);
        expect(created[0].options.voice).toBe('alloy');
    });

    it('asks: connects, starts from a clean conversation, refreshes devices, returns the answer', async () => {
        const answer = await assistant.ask('Is the dishwasher done?');

        expect(answer).toBe('The dishwasher is done.');
        const p = created[0];
        expect(p.questions).toEqual(['Is the dishwasher done?']);
        expect(p.resets).toBe(1);
        expect(fetchData).toHaveBeenCalledTimes(1);
    });

    it('serializes concurrent asks so each gets its own answer', async () => {
        await assistant.speak('warm up'); // build the provider
        created[0].echo = true;

        const [a, b] = await Promise.all([assistant.ask('A'), assistant.ask('B')]);

        expect([a, b]).toEqual(['re: A', 're: B']);
        expect(created[0].questions).toEqual(['A', 'B']);
    });

    it('fails an ask clearly when the engine has no API key', async () => {
        await assistant.speak('warm up'); // build the provider
        created[0].apiKey = false;

        await expect(assistant.ask('Hi')).rejects.toThrow(/API key/);
    });

    it('ask-and-speak returns the answer with its audio', async () => {
        const result = await assistant.askAndSpeak('Announce the dishwasher', 'echo');

        expect(result).toEqual({ answer: 'The dishwasher is done.', url: 'http://homey/flow_x.mp3', duration: 1 });
        expect(created[0].voicesUsed).toEqual(['echo']);
    });

    it('rebuilds the provider on the next call after a settings save', async () => {
        await assistant.ask('Q1');
        homey.setMockSetting('selected_voice', 'shimmer');
        settingsManager.flushGlobalsEmit();

        await assistant.speak('After');

        expect(created).toHaveLength(2);
        expect(created[0].closed).toBe(1);
        expect(created[1].voicesUsed).toEqual(['shimmer']);
    });

    it('a failed call does not wedge the queue', async () => {
        await expect(assistant.speak('   ')).rejects.toThrow(/No text/);
        await expect(assistant.speak('ok')).resolves.toMatchObject({ duration: 1 });
    });
});
