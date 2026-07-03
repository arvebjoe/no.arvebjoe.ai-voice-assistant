import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Fake the Google GenAI SDK so the provider runs with no network.
vi.mock('@google/genai', () => import('./mocks/mock-genai.mjs'));

import { GeminiLiveProvider } from '../src/llm/providers/gemini-live-provider.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { geminiSessions, __resetGenai, FakeLiveSession } from './mocks/mock-genai.mjs';

const tick = () => new Promise(r => setTimeout(r, 0));

const toolManager = {
    getToolDefinitions: () => [{ name: 'get_time', description: 'time', parameters: { type: 'object', properties: {} } }],
    getToolHandlers: () => ({ get_time: (_args: any) => ({ ok: true, now: '12:00' }) }),
    setStandardZone: () => { },
};

const baseOpts = {
    apiKey: 'g-key',
    voice: 'Puck',
    languageCode: 'en',
    languageName: 'English',
    additionalInstructions: '',
    deviceZone: 'Office',
    supportsTimers: false,
};

let provider: GeminiLiveProvider;

function makeProvider(apiKey = 'g-key'): GeminiLiveProvider {
    const homey = new MockHomey();
    provider = new GeminiLiveProvider(homey as any, toolManager as any, { ...baseOpts, apiKey });
    return provider;
}

/** start() + drive onopen so the session is live. */
async function connect(): Promise<FakeLiveSession> {
    await provider.start();
    const session = geminiSessions[geminiSessions.length - 1];
    session.__open();
    await tick();
    return session;
}

describe('GeminiLiveProvider (fake GenAI harness)', () => {
    beforeEach(() => { __resetGenai(); });
    afterEach(() => {
        try { provider?.close?.(); } catch { /* ignore */ }
        vi.useRealTimers();
    });

    it('emits missing_api_key and opens no session without a key', async () => {
        makeProvider('');
        const spy = vi.fn();
        provider.on('missing_api_key', spy);
        await provider.start();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(geminiSessions.length).toBe(0);
    });

    it('emits open and Healthy when the live session opens', async () => {
        makeProvider();
        const openSpy = vi.fn();
        const healthySpy = vi.fn();
        provider.on('open', openSpy);
        provider.on('Healthy', healthySpy);

        await provider.start();
        expect(geminiSessions.length).toBe(1);
        geminiSessions[0].__open();

        expect(openSpy).toHaveBeenCalledTimes(1);
        expect(healthySpy).toHaveBeenCalledTimes(1);
        expect(provider.isConnected()).toBe(true);
    });

    it('decodes base64 audio output into a Buffer', async () => {
        makeProvider();
        const session = await connect();
        const audioSpy = vi.fn();
        provider.on('audio.delta', audioSpy);

        const pcm = Buffer.from([9, 8, 7, 6]);
        session.__message({ data: pcm.toString('base64') });
        await tick();

        expect(audioSpy).toHaveBeenCalledTimes(1);
        expect(Buffer.compare(audioSpy.mock.calls[0][0], pcm)).toBe(0);
    });

    it('emits transcript.delta from the output transcription', async () => {
        makeProvider();
        const session = await connect();
        const spy = vi.fn();
        provider.on('transcript.delta', spy);

        session.__message({ serverContent: { outputTranscription: { text: 'hello there' } } });
        await tick();
        expect(spy).toHaveBeenCalledWith('hello there');
    });

    it('emits response.done on turnComplete', async () => {
        makeProvider();
        const session = await connect();
        const spy = vi.fn();
        provider.on('response.done', spy);

        session.__message({ serverContent: { turnComplete: true } });
        await tick();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('executes a tool call and sends the result back via sendToolResponse', async () => {
        makeProvider();
        const session = await connect();
        const called = vi.fn();
        provider.on('tool.called', called);

        session.__message({ toolCall: { functionCalls: [{ id: 'c1', name: 'get_time', args: {} }] } });
        await tick();
        await tick();

        expect(called).toHaveBeenCalledWith(expect.objectContaining({ name: 'get_time' }));
        const toolResponses = session.sentOf('sendToolResponse');
        expect(toolResponses).toHaveLength(1);
        const fr = toolResponses[0].arg.functionResponses[0];
        expect(fr.name).toBe('get_time');
        expect(fr.response).toEqual({ ok: true, now: '12:00' });
    });

    it('does not crash on an empty/odd server message', async () => {
        makeProvider();
        const session = await connect();
        expect(() => session.__message({})).not.toThrow();
        expect(() => session.__message({ serverContent: {} })).not.toThrow();
    });

    it('reconnects after the live session closes unexpectedly', async () => {
        makeProvider();
        await provider.start();          // session 1 created (real timers for the dynamic import)
        geminiSessions[0].__open();

        vi.useFakeTimers();
        // Unexpected close -> schedule reconnect.
        geminiSessions[0].__close({ code: 1006, reason: 'dropped' });
        await vi.advanceTimersByTimeAsync(6000);
        expect(geminiSessions.length).toBe(2);

        // A second unexpected close keeps the campaign going.
        geminiSessions[1].__close({ code: 1006, reason: 'dropped again' });
        await vi.advanceTimersByTimeAsync(6000);
        expect(geminiSessions.length).toBe(3);
    });

    it('stops reconnecting after a manual close()', async () => {
        makeProvider();
        await provider.start();
        geminiSessions[0].__open();

        vi.useFakeTimers();
        provider.close();                // manual close -> no reconnect
        geminiSessions[0].__close({ code: 1000, reason: 'client-close' });
        await vi.advanceTimersByTimeAsync(6000);
        expect(geminiSessions.length).toBe(1);
    });
});
