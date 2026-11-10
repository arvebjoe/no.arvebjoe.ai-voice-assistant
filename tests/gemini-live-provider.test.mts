import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Fake the Google GenAI SDK so the provider runs with no network.
vi.mock('@google/genai', () => import('./mocks/mock-genai.mjs'));

import { GeminiLiveProvider } from '../src/llm/providers/gemini-live-provider.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { geminiSessions, __resetGenai, FakeLiveSession, __setGenerateContent, generateContentCalls } from './mocks/mock-genai.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';
import { __clearGeminiModelCache } from '../src/llm/providers/gemini-models.mjs';
import { fakeToolManager } from './mocks/mock-tool-manager.mjs';

const tick = () => new Promise(r => setTimeout(r, 0));

const toolManager = fakeToolManager(
    { get_time: (_args: any) => ({ ok: true, now: '12:00' }) },
    [{ name: 'get_time', description: 'time', parameters: { type: 'object', properties: {} } }],
);

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

    // Live's input transcription detects the language per utterance, so without a
    // hint a short Dutch command comes back as German while the spoken reply is
    // still correct — the transcript is a sidecar, and it feeds the CONVO log and
    // the assistant-heard Flow trigger.
    describe('language pinning', () => {
        it('hints the configured language to the input transcriber', async () => {
            const homey = new MockHomey();
            provider = new GeminiLiveProvider(homey as any, toolManager as any, { ...baseOpts, languageCode: 'nl', languageName: 'Nederlands' });
            await provider.start();

            const { config } = geminiSessions[0];
            expect(config.inputAudioTranscription).toEqual({ languageHints: { languageCodes: ['nl'] } });
            expect(config.speechConfig.languageCode).toBe('nl');
        });

        it('sends the device vocabulary as adaptation phrases, capped', async () => {
            const many = Array.from({ length: 150 }, (_, i) => `Device number ${i}`);
            const homey = new MockHomey();
            const withVocabulary = { ...toolManager, getSttVocabulary: () => many };
            provider = new GeminiLiveProvider(homey as any, withVocabulary as any, { ...baseOpts, languageCode: 'nl' });
            await provider.start();

            const phrases = geminiSessions[0].config.inputAudioTranscription.adaptationPhrases;
            expect(phrases.length).toBeLessThanOrEqual(100);
            expect(phrases.join('').length).toBeLessThanOrEqual(800);
            expect(phrases[0]).toBe('Device number 0');
        });

        it('omits both fields rather than sending empty ones', async () => {
            const homey = new MockHomey();
            provider = new GeminiLiveProvider(homey as any, toolManager as any, { ...baseOpts, languageCode: '' });
            await provider.start();

            const { config } = geminiSessions[0];
            expect(config.inputAudioTranscription).toEqual({});
            expect(config.speechConfig.languageCode).toBeUndefined();
        });
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

    it('M8 — suppresses response.done for the tool-call turn but emits it after the continuation', async () => {
        makeProvider();
        const session = await connect();
        const done = vi.fn();
        provider.on('response.done', done);

        // Model calls a tool; the turnComplete of the tool-call turn must NOT
        // end the device turn (the spoken answer is still coming).
        session.__message({ toolCall: { functionCalls: [{ id: 'c1', name: 'get_time', args: {} }] } });
        session.__message({ serverContent: { turnComplete: true } });
        await tick();
        await tick();
        expect(done).not.toHaveBeenCalled();
        expect(session.sentOf('sendToolResponse')).toHaveLength(1);

        // Continuation with the spoken answer -> this turnComplete ends the turn.
        session.__message({ data: Buffer.from([1, 2]).toString('base64') });
        session.__message({ serverContent: { turnComplete: true } });
        expect(done).toHaveBeenCalledTimes(1);
    });

    it('M8 — a tool turn without its own turnComplete still ends on the continuation turnComplete', async () => {
        makeProvider();
        const session = await connect();
        const done = vi.fn();
        provider.on('response.done', done);

        session.__message({ toolCall: { functionCalls: [{ id: 'c1', name: 'get_time', args: {} }] } });
        await tick();
        await tick(); // tool response sent

        // Continuation output clears the pending-tool state, so the (single)
        // turnComplete is not swallowed.
        session.__message({ data: Buffer.from([3, 4]).toString('base64') });
        session.__message({ serverContent: { turnComplete: true } });
        expect(done).toHaveBeenCalledTimes(1);
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

    it('backs off while sessions open but are closed before setup; resets only after setupComplete', async () => {
        makeProvider();
        const attempts: number[] = [];
        provider.on('reconnecting', (attempt: number) => attempts.push(attempt));
        await provider.start();

        vi.useFakeTimers();
        // Socket opens, server closes at once (rejected config) - three times.
        for (let i = 0; i < 3; i++) {
            const s = geminiSessions[geminiSessions.length - 1];
            s.__open();
            s.__close({ code: 1007, reason: 'rejected config' });
            await vi.advanceTimersByTimeAsync(10_000);
        }
        expect(attempts).toEqual([1, 2, 3]);      // grows, not "attempt 1" forever

        // A session the server accepts ends the campaign.
        const reconnected = vi.fn();
        provider.on('reconnected', reconnected);
        const good = geminiSessions[geminiSessions.length - 1];
        good.__open();
        good.__message({ setupComplete: {} });
        expect(reconnected).toHaveBeenCalledTimes(1);

        good.__close({ code: 1006, reason: 'dropped' });
        expect(attempts[attempts.length - 1]).toBe(1);
    });

    it('reconnects without the language code when the model refuses it, keeping the transcription hint', async () => {
        makeProvider();
        (provider as any).options.languageCode = 'no';
        await provider.start();
        const first = geminiSessions[0];
        expect(first.config.speechConfig.languageCode).toBe('no');

        vi.useFakeTimers();
        first.__open();
        first.__close({ code: 1007, reason: `Unsupported language code 'no' for model models/${first.model}` });
        await vi.advanceTimersByTimeAsync(5_000);

        const second = geminiSessions[1];
        expect(second.model).toBe(first.model);
        expect(second.config.speechConfig.languageCode).toBeUndefined();
        expect(second.config.inputAudioTranscription.languageHints).toEqual({ languageCodes: ['no'] });
    });

    describe('model selection and retired-model fallback', () => {
        const catalog = {
            models: [
                { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-3.8-flash-lite', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-3.1-flash-live-preview', supportedGenerationMethods: ['bidiGenerateContent'] },
                { name: 'models/gemini-3.9-flash-live', supportedGenerationMethods: ['bidiGenerateContent'] },
            ],
        };
        const retired = (model: string) => Object.assign(
            new Error(`{"error":{"code":404,"message":"This model models/${model} is no longer available to new users.","status":"NOT_FOUND"}}`),
            { status: 404 });

        function withSettings(settings: Record<string, string>): void {
            settingsManager.reset();
            const homey = new MockHomey();
            for (const [k, v] of Object.entries(settings)) homey.setMockSetting(k, v);
            settingsManager.init(homey as any);
        }

        beforeEach(() => {
            __clearGeminiModelCache();
            vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 })));
        });
        afterEach(() => {
            vi.unstubAllGlobals();
            settingsManager.reset();
        });

        it('uses the configured model per role, the default when unset', async () => {
            withSettings({ gemini_text_model: 'gemini-3.8-flash-lite' });
            makeProvider();
            expect(provider.modelFor('text')).toBe('gemini-3.8-flash-lite');
            expect(provider.modelFor('tts')).toBe('gemini-3.8-flash-tts');

            await provider.start();
            expect(geminiSessions[0].model).toBe('gemini-3.1-flash-live-preview');
        });

        it('a retired text model is replaced, the ask still answers, the host is told once', async () => {
            withSettings({ gemini_text_model: 'gemini-2.5-flash' });
            makeProvider();
            __setGenerateContent(async (req) => {
                if (req.model === 'gemini-2.5-flash') throw retired('gemini-2.5-flash');
                return { text: `answer from ${req.model}` };
            });
            const unavailable = vi.fn();
            const done = vi.fn();
            provider.on('model_unavailable', unavailable);
            provider.on('text.done', done);

            await provider.sendTextForTextResponse('hei');

            expect(done).toHaveBeenCalledWith(expect.objectContaining({ text: 'answer from gemini-3.8-flash' }));
            expect(unavailable).toHaveBeenCalledWith({ stage: 'llm', model: 'gemini-2.5-flash', fallback: 'gemini-3.8-flash', reason: 'retired' });

            // Sticky: the next ask goes straight to the replacement.
            generateContentCalls.length = 0;
            await provider.sendTextForTextResponse('igjen');
            expect(generateContentCalls.map(c => c.model)).toEqual(['gemini-3.8-flash']);
            expect(unavailable).toHaveBeenCalledTimes(1);
        });

        it('a different model picked in settings drops the replacement', async () => {
            withSettings({ gemini_text_model: 'gemini-2.5-flash' });
            makeProvider();
            __setGenerateContent(async (req) => {
                if (req.model === 'gemini-2.5-flash') throw retired('gemini-2.5-flash');
                return { text: 'ok' };
            });
            await provider.sendTextForTextResponse('hei');
            expect(provider.modelFor('text')).toBe('gemini-3.8-flash');

            settingsManager.reset();
            const homey = new MockHomey();
            homey.setMockSetting('gemini_text_model', 'gemini-3.8-flash-lite');
            settingsManager.init(homey as any);
            expect(provider.modelFor('text')).toBe('gemini-3.8-flash-lite');
        });

        it('a tool turn is echoed back verbatim, thought signature included', async () => {
            withSettings({});
            makeProvider();
            const modelTurn = { role: 'model', parts: [{ functionCall: { name: 'get_time', args: {} }, thoughtSignature: 'sig-abc' }] };
            let calls = 0;
            __setGenerateContent(async () => (++calls === 1
                ? { functionCalls: [{ name: 'get_time', args: {} }], candidates: [{ content: modelTurn }] }
                : { text: 'It is 12:00.' }));
            const done = vi.fn();
            provider.on('text.done', done);

            await provider.sendTextForTextResponse('what time is it?');

            // The follow-up request carries the model's own turn, not a rebuild.
            expect(generateContentCalls[1].contents[1]).toBe(modelTurn);
            expect(generateContentCalls[1].contents[2].parts[0].functionResponse.name).toBe('get_time');
            expect(done).toHaveBeenCalledWith(expect.objectContaining({ text: 'It is 12:00.' }));
        });

        it('speaks the bare text - no steering preamble for the TTS model to read aloud', async () => {
            withSettings({});
            makeProvider();
            __setGenerateContent(async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: '' } }] } }] }));

            await provider.textToSpeech('Flink du!').catch(() => undefined); // empty PCM may not encode; the request is what matters

            expect(generateContentCalls[0].contents).toEqual([{ role: 'user', parts: [{ text: 'Flink du!' }] }]);
        });

        it('a failed ask is flagged so a consumer can refuse to speak it', async () => {
            withSettings({});
            makeProvider();
            __setGenerateContent(async () => { throw Object.assign(new Error('boom'), { status: 400 }); });
            const done = vi.fn();
            provider.on('text.done', done);

            await provider.sendTextForTextResponse('hei');

            expect(done).toHaveBeenCalledWith({ text: 'Error: boom', error: true });
        });

        it('other errors are neither retried nor treated as a retired model', async () => {
            withSettings({});
            makeProvider();
            __setGenerateContent(async () => { throw Object.assign(new Error('Internal error'), { status: 500 }); });
            const unavailable = vi.fn();
            provider.on('model_unavailable', unavailable);

            await expect(provider.textToSpeech('hei')).rejects.toThrow(/Internal error/);
            expect(unavailable).not.toHaveBeenCalled();
            expect(generateContentCalls).toHaveLength(1);
        });

        describe('overloaded model (503 high demand)', () => {
            const overloaded = () => Object.assign(
                new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'),
                { status: 503 });
            const saved = GeminiLiveProvider.OVERLOAD_RETRY_MS;
            beforeEach(() => { GeminiLiveProvider.OVERLOAD_RETRY_MS = 0; });
            afterEach(() => { GeminiLiveProvider.OVERLOAD_RETRY_MS = saved; });

            it('retries the same model once and succeeds', async () => {
                withSettings({});
                makeProvider();
                let calls = 0;
                __setGenerateContent(async (req) => {
                    if (++calls === 1) throw overloaded();
                    return { text: `answer from ${req.model}` };
                });
                const done = vi.fn();
                provider.on('text.done', done);

                await provider.sendTextForTextResponse('hei');

                expect(generateContentCalls.map(c => c.model)).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash']);
                expect(done).toHaveBeenCalledWith(expect.objectContaining({ text: 'answer from gemini-3.8-flash' }));
            });

            it('still busy: answers from another listed model for this call only, no notification', async () => {
                withSettings({});
                makeProvider();
                __setGenerateContent(async (req) => {
                    if (req.model === 'gemini-3.8-flash') throw overloaded();
                    return { text: `answer from ${req.model}` };
                });
                const done = vi.fn();
                const unavailable = vi.fn();
                provider.on('text.done', done);
                provider.on('model_unavailable', unavailable);

                await provider.sendTextForTextResponse('hei');

                expect(generateContentCalls.map(c => c.model)).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-lite']);
                expect(done).toHaveBeenCalledWith(expect.objectContaining({ text: 'answer from gemini-3.8-flash-lite' }));
                expect(unavailable).not.toHaveBeenCalled();
                // Not sticky: the user's model is still the one in use.
                expect(provider.modelFor('text')).toBe('gemini-3.8-flash');
            });

            it('walks several stand-ins, lite tier first, until one answers', async () => {
                const gen = ['generateContent'];
                vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
                    models: [
                        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: gen },
                        { name: 'models/gemini-3.7-flash', supportedGenerationMethods: gen },
                        { name: 'models/gemini-3.7-flash-lite', supportedGenerationMethods: gen },
                        { name: 'models/gemini-3.1-flash', supportedGenerationMethods: gen },
                    ],
                }), { status: 200 })));
                withSettings({});
                makeProvider();
                __setGenerateContent(async (req) => {
                    if (req.model !== 'gemini-3.1-flash') throw overloaded();
                    return { text: `answer from ${req.model}` };
                });
                const done = vi.fn();
                provider.on('text.done', done);

                await provider.sendTextForTextResponse('hei');

                expect(generateContentCalls.map(c => c.model)).toEqual(
                    ['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.7-flash-lite', 'gemini-3.7-flash', 'gemini-3.1-flash']);
                expect(done).toHaveBeenCalledWith(expect.objectContaining({ text: 'answer from gemini-3.1-flash' }));
            });

            it('keeps the stand-in for the following calls instead of bouncing back to the busy model', async () => {
                withSettings({});
                makeProvider();
                __setGenerateContent(async (req) => {
                    if (req.model === 'gemini-3.8-flash') throw overloaded();
                    return { text: 'ok' };
                });
                await provider.sendTextForTextResponse('hei');
                generateContentCalls.length = 0;

                await provider.sendTextForTextResponse('igjen');

                expect(generateContentCalls.map(c => c.model)).toEqual(['gemini-3.8-flash-lite']);
            });

            it('an empty speech response is an error, not a silent clip', async () => {
                withSettings({});
                makeProvider();
                __setGenerateContent(async () => ({ candidates: [{ finishReason: 'OTHER', content: { parts: [] } }] }));

                await expect(provider.textToSpeech('hei')).rejects.toThrow("returned no audio (OTHER)");
            });

            it('gives up with the error when every model is busy', async () => {
                withSettings({});
                makeProvider();
                __setGenerateContent(async () => { throw overloaded(); });
                const done = vi.fn();
                provider.on('text.done', done);

                await provider.sendTextForTextResponse('hei');

                expect(generateContentCalls).toHaveLength(3);
                expect(done).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/high demand/) }));
            });
        });

        it('a live session closed for a retired model reconnects on the replacement', async () => {
            withSettings({});
            makeProvider();
            const unavailable = vi.fn();
            provider.on('model_unavailable', unavailable);
            await provider.start();
            expect(geminiSessions[0].model).toBe('gemini-3.1-flash-live-preview');

            geminiSessions[0].__close({ code: 1008, reason: 'models/gemini-3.1-flash-live-preview is not found for API version v1beta, or is not supported for bidiGenerateContent' });
            await vi.waitFor(() => expect(unavailable).toHaveBeenCalled());
            await vi.waitFor(() => expect(geminiSessions.length).toBe(2), { timeout: 8000 });

            expect(unavailable).toHaveBeenCalledWith({ stage: 'live', model: 'gemini-3.1-flash-live-preview', fallback: 'gemini-3.9-flash-live', reason: 'retired' });
            expect(geminiSessions[1].model).toBe('gemini-3.9-flash-live');
        }, 10_000);
    });
});
