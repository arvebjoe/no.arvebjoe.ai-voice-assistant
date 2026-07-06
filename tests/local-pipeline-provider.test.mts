import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LocalPipelineProvider, ThinkTagFilter } from '../src/llm/providers/local-pipeline-provider.mjs';
import { MistralClient } from '../src/llm/providers/local/mistral-client.mjs';
import { OllamaClient } from '../src/llm/providers/local/ollama-client.mjs';
import { MistralSttClient } from '../src/llm/providers/local/mistral-stt-client.mjs';
import { MistralTtsClient } from '../src/llm/providers/local/mistral-tts-client.mjs';
import { WhisperClient } from '../src/llm/providers/local/whisper-client.mjs';
import { PiperClient } from '../src/llm/providers/local/piper-client.mjs';
import { OpenAiLlmClient } from '../src/llm/providers/local/openai-llm-client.mjs';
import { OpenAiSttClient } from '../src/llm/providers/local/openai-stt-client.mjs';
import { OpenAiTtsClient } from '../src/llm/providers/local/openai-tts-client.mjs';
import { WyomingSttClient } from '../src/llm/providers/local/wyoming-stt-client.mjs';
import { WyomingTtsClient } from '../src/llm/providers/local/wyoming-tts-client.mjs';
import { LmStudioClient } from '../src/llm/providers/local/lmstudio-client.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { fakeToolManager } from './mocks/mock-tool-manager.mjs';

const RATE = 16000;

function silence(ms: number): Buffer {
    return Buffer.alloc(Math.round(RATE * ms / 1000) * 2);
}

function speech(ms: number, amplitude = 8000): Buffer {
    const samples = Math.round(RATE * ms / 1000);
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        buf.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 300 * i / RATE)), i * 2);
    }
    return buf;
}

function feedAll(provider: LocalPipelineProvider, pcm: Buffer) {
    const chunk = 1024;
    for (let off = 0; off < pcm.length; off += chunk) {
        provider.sendAudioChunk(pcm.subarray(off, Math.min(off + chunk, pcm.length)));
    }
}

function once(provider: LocalPipelineProvider, event: string, timeoutMs = 3000): Promise<any> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
        (provider as any).once(event, (...args: any[]) => {
            clearTimeout(t);
            resolve(args);
        });
    });
}

const baseOpts = {
    apiKey: '',
    voice: 'server-default',
    languageCode: 'en',
    languageName: 'English',
    additionalInstructions: '',
    deviceZone: 'Office',
    supportsTimers: false,
};

let provider: LocalPipelineProvider;
let homey: MockHomey;
let llmChat: ReturnType<typeof vi.fn>;
let sttTranscribe: ReturnType<typeof vi.fn>;
let ttsSynthesize: ReturnType<typeof vi.fn>;

const toolManager = fakeToolManager(
    { get_time: (_args: any) => ({ ok: true, now: '12:00' }) },
    [{ name: 'get_time', description: 'time', parameters: { type: 'object', properties: {} } }],
);

/** Build a provider whose three HTTP clients are stubbed out. */
async function makeProvider(): Promise<LocalPipelineProvider> {
    settingsManager.reset();
    homey = new MockHomey();
    homey.setMockSetting('local_stt_host', '10.0.0.2');
    homey.setMockSetting('local_llm_host', '10.0.0.2');
    homey.setMockSetting('local_llm_model', 'qwen3');
    homey.setMockSetting('local_tts_host', '10.0.0.2');
    settingsManager.init(homey as any);

    provider = new LocalPipelineProvider(homey as any, toolManager as any, { ...baseOpts });

    sttTranscribe = vi.fn(async () => 'turn on the light');
    llmChat = vi.fn(async (_msgs: any[], _tools: any[], onDelta?: (d: string) => void) => {
        onDelta?.('Sure. ');
        onDelta?.('Light is on.');
        return { content: 'Sure. Light is on.', toolCalls: [] };
    });
    // 100 ms of quiet PCM at Piper's typical 22.05 kHz
    ttsSynthesize = vi.fn(async () => ({ pcm: Buffer.alloc(2205 * 2), sampleRate: 22050 }));

    const stub = { configure: () => { }, isConfigured: () => true, hasCredentials: () => true, describe: () => 'stub', check: async () => { } };
    (provider as any).stt = { ...stub, transcribe: sttTranscribe };
    (provider as any).llm = { ...stub, resolveModel: async () => 'qwen3', chat: llmChat };
    (provider as any).tts = { ...stub, synthesize: ttsSynthesize };
    // A settings-driven config change would rebuild this.llm and wipe the stubs;
    // pin the stubbed clients for the duration of the test.
    (provider as any).onGlobalSettings = () => { };

    await provider.start();
    return provider;
}

describe('LocalPipelineProvider', () => {
    beforeEach(async () => {
        await makeProvider();
    });

    afterEach(() => {
        try { (provider as any)?.destroy?.(); } catch { /* ignore */ }
    });

    it('reports connected/healthy after start() and needs no API key', () => {
        expect(provider.isConnected()).toBe(true);
        expect(provider.hasApiKey()).toBe(true);
        expect(provider.inputSampleRate).toBe(16000);
    });

    it('runs a full spoken turn: VAD -> STT -> LLM -> TTS with the seam event order', async () => {
        const events: string[] = [];
        for (const e of ['speech', 'silence', 'transcript.done', 'transcript.delta', 'audio.delta', 'audio.done', 'response.done']) {
            (provider as any).on(e, () => events.push(e));
        }
        const transcriptDone = once(provider, 'transcript.done');
        const responseDone = once(provider, 'response.done');

        feedAll(provider, silence(200));
        feedAll(provider, speech(600));
        feedAll(provider, silence(900));

        const [transcript] = await transcriptDone;
        expect(transcript).toBe('turn on the light');
        await responseDone;

        // STT got the utterance, the LLM got the transcript as the user message.
        expect(sttTranscribe).toHaveBeenCalledTimes(1);
        const messages = llmChat.mock.calls[0][0];
        expect(messages[0].role).toBe('system');
        expect(messages[0].content.length).toBeGreaterThan(0);
        expect(messages[messages.length - 1]).toMatchObject({ role: 'user', content: 'turn on the light' });

        // Piper spoke the reply (sentence-split can make 1..2 clips).
        expect(ttsSynthesize).toHaveBeenCalled();

        // Ordering: speech before silence, silence before transcript.done,
        // transcript.done before the reply stream, response.done last.
        expect(events.indexOf('speech')).toBeLessThan(events.indexOf('silence'));
        expect(events.indexOf('silence')).toBeLessThan(events.indexOf('transcript.done'));
        expect(events.indexOf('transcript.done')).toBeLessThan(events.indexOf('transcript.delta'));
        expect(events.indexOf('audio.delta')).toBeGreaterThan(events.indexOf('transcript.done'));
        expect(events[events.length - 1]).toBe('response.done');
    });

    it('emits audio.delta as PCM16 mono 24 kHz (resampled from Piper rate, padded)', async () => {
        const chunks: Buffer[] = [];
        (provider as any).on('audio.delta', (b: Buffer) => chunks.push(b));
        const done = once(provider, 'response.done');
        feedAll(provider, speech(600));
        feedAll(provider, silence(900));
        await done;

        // 100 ms @22050 -> ~100 ms @24000 (2400 samples) + 350 ms pad (8400 samples)
        const total = chunks.reduce((n, b) => n + b.length, 0) / 2;
        expect(total).toBeGreaterThanOrEqual(2400 + 8400 - 4);
    });

    it('reports an empty transcript without invoking the LLM (device decides retry/end)', async () => {
        sttTranscribe.mockResolvedValueOnce('   ');
        const transcriptDone = once(provider, 'transcript.done');
        feedAll(provider, speech(600));
        feedAll(provider, silence(900));
        const [transcript] = await transcriptDone;
        expect(transcript).toBe('');
        await new Promise((r) => setTimeout(r, 20));
        expect(llmChat).not.toHaveBeenCalled();
    });

    it('filters known Whisper hallucinations to an empty transcript', async () => {
        sttTranscribe.mockResolvedValueOnce('Undertekster av Ai-Media');
        const transcriptDone = once(provider, 'transcript.done');
        feedAll(provider, speech(600));
        feedAll(provider, silence(900));
        const [transcript] = await transcriptDone;
        expect(transcript).toBe('');
    });

    it('emits silence + empty transcript when the user never speaks (VAD timeout)', async () => {
        const silenceSpy = vi.fn();
        (provider as any).on('silence', silenceSpy);
        const transcriptDone = once(provider, 'transcript.done', 5000);
        feedAll(provider, silence(9000)); // default noSpeechTimeoutMs = 8000
        const [transcript] = await transcriptDone;
        expect(transcript).toBe('');
        expect(silenceSpy).toHaveBeenCalled();
        expect(sttTranscribe).not.toHaveBeenCalled();
    });

    it('loops tool calls through the ToolManager and feeds results back', async () => {
        llmChat
            .mockImplementationOnce(async () => ({
                content: '',
                toolCalls: [{ id: 'abc123XYZ', name: 'get_time', args: { zone: 'Office' } }],
            }))
            .mockImplementationOnce(async (_msgs: any[], _tools: any[], onDelta?: (d: string) => void) => {
                onDelta?.('It is noon.');
                return { content: 'It is noon.', toolCalls: [] };
            });

        const called = vi.fn();
        const completed = vi.fn();
        (provider as any).on('tool.called', called);
        (provider as any).on('tool.completed', completed);
        const done = once(provider, 'response.done');

        feedAll(provider, speech(600));
        feedAll(provider, silence(900));
        await done;

        expect(called).toHaveBeenCalledWith(expect.objectContaining({ callId: 'abc123XYZ', name: 'get_time', args: { zone: 'Office' } }));
        expect(completed).toHaveBeenCalledWith(expect.objectContaining({ name: 'get_time', result: { ok: true, now: '12:00' } }));

        // Round 2 saw the assistant tool-calls message and the keyed tool result.
        const round2: any[] = llmChat.mock.calls[1][0];
        const toolMsg = round2.find((m) => m.role === 'tool');
        expect(toolMsg).toBeTruthy();
        expect(toolMsg.toolName).toBe('get_time');
        expect(toolMsg.toolCallId).toBe('abc123XYZ');
        expect(JSON.parse(toolMsg.content)).toEqual({ ok: true, now: '12:00' });
    });

    it('keeps conversation context across turns and clears it on resetConversation()', async () => {
        // response.done is emitted just before the provider returns to 'idle';
        // give the turn's async tail a tick before starting the next one (a real
        // follow-up arrives seconds later, after the device played the reply).
        const settle = () => new Promise((r) => setTimeout(r, 0));

        const done1 = once(provider, 'response.done');
        feedAll(provider, speech(600));
        feedAll(provider, silence(900));
        await done1;
        await settle();

        const done2 = once(provider, 'response.done');
        feedAll(provider, speech(600));
        feedAll(provider, silence(900));
        await done2;
        await settle();

        // Second round carries turn 1's user+assistant messages.
        const messages2: any[] = llmChat.mock.calls[1][0];
        expect(messages2.filter((m) => m.role === 'user').length).toBe(2);
        expect(messages2.filter((m) => m.role === 'assistant').length).toBe(1);

        provider.resetConversation();
        const done3 = once(provider, 'response.done');
        feedAll(provider, speech(600));
        feedAll(provider, silence(900));
        await done3;
        const messages3: any[] = llmChat.mock.calls[2][0];
        expect(messages3.filter((m) => m.role === 'user').length).toBe(1);
    });

    it('answers text questions with text.done and no TTS', async () => {
        const done = once(provider, 'text.done');
        provider.sendTextForTextResponse('what time is it?');
        const [msg] = await done;
        expect(msg.text).toBe('Sure. Light is on.');
        expect(ttsSynthesize).not.toHaveBeenCalled();
    });

    it('speaks text via sendTextForAudioResponse (audio out, response.done)', async () => {
        const done = once(provider, 'response.done');
        provider.sendTextForAudioResponse('say hello');
        await done;
        expect(ttsSynthesize).toHaveBeenCalled();
        const messages = llmChat.mock.calls[0][0];
        expect(messages[messages.length - 1]).toMatchObject({ role: 'user', content: 'say hello' });
    });

    it('emits error (and no response.done) when a pipeline stage fails', async () => {
        sttTranscribe.mockRejectedValueOnce(new Error('whisper down'));
        const err = once(provider, 'error');
        feedAll(provider, speech(600));
        feedAll(provider, silence(900));
        const [e] = await err;
        expect(String(e.message)).toContain('whisper down');
    });

    it('defaults the LLM backend to Ollama and switches to Mistral on a settings change', async () => {
        // makeProvider pins stubs via onGlobalSettings; build a fresh, unpinned one.
        const p = new LocalPipelineProvider(homey as any, toolManager as any, { ...baseOpts });
        try {
            expect((p as any).llm).toBeInstanceOf(OllamaClient);
            homey.setMockSetting('mistral_api_key', 'sk-test');
            homey.setMockSetting('local_llm_provider', 'mistral');
            expect((p as any).llm).toBeInstanceOf(MistralClient);
            expect(p.hasApiKey()).toBe(true);

            homey.setMockSetting('local_llm_provider', 'ollama');
            expect((p as any).llm).toBeInstanceOf(OllamaClient);
        } finally {
            p.destroy();
        }
    });

    it('switches the STT and TTS stages to Voxtral on settings changes', async () => {
        const p = new LocalPipelineProvider(homey as any, toolManager as any, { ...baseOpts });
        try {
            expect((p as any).stt).toBeInstanceOf(WhisperClient);
            expect((p as any).tts).toBeInstanceOf(PiperClient);

            homey.setMockSetting('mistral_api_key', 'sk-test');
            homey.setMockSetting('local_stt_provider', 'mistral');
            homey.setMockSetting('local_tts_provider', 'mistral');
            expect((p as any).stt).toBeInstanceOf(MistralSttClient);
            expect((p as any).tts).toBeInstanceOf(MistralTtsClient);
            expect(p.hasApiKey()).toBe(true);

            // Without a key, any Mistral-backed stage flips hasApiKey false.
            homey.setMockSetting('mistral_api_key', '');
            expect(p.hasApiKey()).toBe(false);

            homey.setMockSetting('local_stt_provider', 'whisper');
            homey.setMockSetting('local_tts_provider', 'piper');
            expect((p as any).stt).toBeInstanceOf(WhisperClient);
            expect((p as any).tts).toBeInstanceOf(PiperClient);
            expect(p.hasApiKey()).toBe(true);
        } finally {
            p.destroy();
        }
    });

    it('switches the STT and TTS stages to the Wyoming backends (keyless LAN)', async () => {
        const p = new LocalPipelineProvider(homey as any, toolManager as any, { ...baseOpts });
        try {
            homey.setMockSetting('wyoming_stt_host', '10.0.0.9');
            homey.setMockSetting('local_stt_provider', 'wyoming');
            homey.setMockSetting('wyoming_tts_host', '10.0.0.9');
            homey.setMockSetting('local_tts_provider', 'wyoming');
            expect((p as any).stt).toBeInstanceOf(WyomingSttClient);
            expect((p as any).tts).toBeInstanceOf(WyomingTtsClient);
            expect(p.hasApiKey()).toBe(true);
            // Wyoming Piper's voice is server-side, same as HTTP Piper.
            expect((await LocalPipelineProvider.getAvailableVoices('wyoming')).map((v) => v.value)).toEqual(['server-default']);

            homey.setMockSetting('local_stt_provider', 'whisper');
            homey.setMockSetting('local_tts_provider', 'piper');
            expect((p as any).stt).toBeInstanceOf(WhisperClient);
            expect((p as any).tts).toBeInstanceOf(PiperClient);
        } finally {
            p.destroy();
        }
    });

    it('switches the LLM stage to LM Studio (keyless LAN, model optional)', async () => {
        const p = new LocalPipelineProvider(homey as any, toolManager as any, { ...baseOpts });
        try {
            homey.setMockSetting('lmstudio_host', '10.0.0.9');
            homey.setMockSetting('local_llm_provider', 'lmstudio');
            expect((p as any).llm).toBeInstanceOf(LmStudioClient);
            expect(p.hasApiKey()).toBe(true);
            expect((p as any).llm.isConfigured()).toBe(true); // host alone suffices

            homey.setMockSetting('local_llm_provider', 'ollama');
            expect((p as any).llm).toBeInstanceOf(OllamaClient);
        } finally {
            p.destroy();
        }
    });

    it('switches all three stages to the generic OpenAI-compatible backend', async () => {
        const p = new LocalPipelineProvider(homey as any, toolManager as any, { ...baseOpts });
        try {
            homey.setMockSetting('local_stt_provider', 'openai');
            homey.setMockSetting('local_llm_provider', 'openai');
            homey.setMockSetting('local_tts_provider', 'openai');
            expect((p as any).stt).toBeInstanceOf(OpenAiSttClient);
            expect((p as any).llm).toBeInstanceOf(OpenAiLlmClient);
            expect((p as any).llm).not.toBeInstanceOf(MistralClient); // generic, not the subclass
            expect((p as any).tts).toBeInstanceOf(OpenAiTtsClient);
            // Keyless is a valid configuration for these backends.
            expect(p.hasApiKey()).toBe(true);
        } finally {
            p.destroy();
        }
    });

    it('routes the selected voice to a Voxtral TTS stage via updateVoice', async () => {
        homey.setMockSetting('mistral_api_key', 'sk-test');
        homey.setMockSetting('local_tts_provider', 'mistral');
        const p = new LocalPipelineProvider(homey as any, toolManager as any, { ...baseOpts });
        try {
            p.updateVoice('fr_female');
            expect(((p as any).tts as any).config.voice).toBe('fr_female');
        } finally {
            p.destroy();
        }
    });

    it('offers voices matching the TTS backend', async () => {
        // Saved setting decides when no override is passed.
        expect((await LocalPipelineProvider.getAvailableVoices()).map((v) => v.value)).toEqual(['server-default']);

        // Voxtral without a saved key: one sentinel entry ('' = client picks), no network.
        homey.setMockSetting('local_tts_provider', 'mistral');
        homey.setMockSetting('mistral_api_key', '');
        expect((await LocalPipelineProvider.getAvailableVoices()).map((v) => v.value)).toEqual(['']);

        // With a key the list comes live from GET /v1/audio/voices.
        homey.setMockSetting('mistral_api_key', 'sk-provider-voices-test');
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                items: [{ id: '530e2e20-58e2-45d8-b0a5-4594f4915944', name: 'Paul - Sad', slug: 'en_paul_sad', languages: ['en_us'] }],
                total: 1,
            }),
        })));
        try {
            expect(await LocalPipelineProvider.getAvailableVoices()).toEqual([
                { value: '530e2e20-58e2-45d8-b0a5-4594f4915944', name: 'Paul - Sad (EN-US)' },
            ]);
        } finally {
            vi.unstubAllGlobals();
        }

        // An explicit override (settings-page preview) wins over the saved setting.
        expect((await LocalPipelineProvider.getAvailableVoices('piper')).map((v) => v.value)).toEqual(['server-default']);
        // The generic backend offers OpenAI's standard voices.
        expect((await LocalPipelineProvider.getAvailableVoices('openai')).map((v) => v.value)).toContain('alloy');
    });

    it('emits missing_api_key on start when Mistral is selected without a key', async () => {
        homey.setMockSetting('local_llm_provider', 'mistral');
        homey.setMockSetting('mistral_api_key', '');
        const p = new LocalPipelineProvider(homey as any, toolManager as any, { ...baseOpts });
        try {
            expect(p.hasApiKey()).toBe(false);
            const spy = vi.fn();
            (p as any).on('missing_api_key', spy);
            await p.start();
            expect(spy).toHaveBeenCalledTimes(1);
            expect(p.isConnected()).toBe(false);
        } finally {
            p.destroy();
        }
    });

    it('marks unconnected and emits Unhealthy when a health probe fails', async () => {
        (provider as any).on('error', () => { }); // 'error' with no listener would throw
        (provider as any).stt.check = async () => { throw new Error('refused'); };
        const unhealthy = once(provider, 'Unhealthy');
        await provider.restart().catch(() => { });
        await unhealthy;
        expect(provider.isConnected()).toBe(false);
    });
});

describe('ThinkTagFilter', () => {
    it('passes plain text through', () => {
        const f = new ThinkTagFilter();
        expect(f.feed('hello world') + f.flush()).toBe('hello world');
    });

    it('strips a think block', () => {
        const f = new ThinkTagFilter();
        expect(f.feed('<think>secret plan</think>Answer.') + f.flush()).toBe('Answer.');
    });

    it('strips think blocks torn across deltas', () => {
        const f = new ThinkTagFilter();
        let out = '';
        out += f.feed('<thi');
        out += f.feed('nk>internal ');
        out += f.feed('monologue</th');
        out += f.feed('ink>The light ');
        out += f.feed('is on.');
        out += f.flush();
        expect(out).toBe('The light is on.');
    });

    it('does not eat text that merely looks like a tag start', () => {
        const f = new ThinkTagFilter();
        let out = '';
        out += f.feed('a < b and <thin');
        out += f.feed('g> is fine');
        out += f.flush();
        expect(out).toBe('a < b and <thing> is fine');
    });
});
