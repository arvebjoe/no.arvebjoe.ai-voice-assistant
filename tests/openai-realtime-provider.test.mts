import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Fake the `ws` package so the provider runs with no network.
vi.mock('ws', () => import('./mocks/mock-ws.mjs'));

import { OpenAIRealtimeProvider } from '../src/llm/providers/openai-realtime-agent.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { createdSockets, __resetSockets, FakeWebSocket } from './mocks/mock-ws.mjs';
import { fakeToolManager } from './mocks/mock-tool-manager.mjs';

const tick = () => new Promise(r => setTimeout(r, 0));

const toolManager = fakeToolManager({ get_time: (_args: any) => ({ ok: true, now: '12:00' }) });

const baseOpts = {
    apiKey: 'test-key',
    voice: 'alloy',
    languageCode: 'en',
    languageName: 'English',
    additionalInstructions: '',
    deviceZone: 'Office',
    supportsTimers: false,
};

let provider: OpenAIRealtimeProvider;

function makeProvider(apiKey = 'test-key'): OpenAIRealtimeProvider {
    const homey = new MockHomey();
    provider = new OpenAIRealtimeProvider(homey as any, toolManager as any, { ...baseOpts, apiKey });
    return provider;
}

/** start() + drive the handshake so the socket is OPEN and the session is ready. */
async function connect(): Promise<InstanceType<typeof FakeWebSocket>> {
    await provider.start();
    const ws = createdSockets[createdSockets.length - 1];
    ws.__open();
    ws.__message({ type: 'session.created' });
    // session.created awaits the instruction load before configuring the
    // session, so wait for the session.update instead of a fixed tick.
    await vi.waitFor(() => expect(ws.sentTypes()).toContain('session.update'));
    ws.__message({ type: 'session.updated' });
    await tick();
    return ws;
}

describe('OpenAIRealtimeProvider (fake WebSocket harness)', () => {
    beforeEach(() => { __resetSockets(); });
    afterEach(() => {
        try { (provider as any)?.destroy?.(); } catch { /* ignore */ }
        vi.useRealTimers();
    });

    it('emits missing_api_key and opens no socket without a key', async () => {
        makeProvider('');
        const spy = vi.fn();
        provider.on('missing_api_key', spy);
        await provider.start();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(createdSockets.length).toBe(0);
    });

    it('sends a session.update after session.created and emits open on session.updated', async () => {
        makeProvider();
        const openSpy = vi.fn();
        provider.on('open', openSpy);

        await provider.start();
        const ws = createdSockets[createdSockets.length - 1];
        ws.__open();
        ws.__message({ type: 'session.created' });
        // session.created awaits the instruction load before replying.
        await vi.waitFor(() => expect(ws.sentTypes()).toContain('session.update'));

        ws.__message({ type: 'session.updated' });
        await tick();
        expect(openSpy).toHaveBeenCalled();
    });

    it('connects to the full model by default and feeds device/zone names into the transcription prompt', async () => {
        const homey = new MockHomey();
        const tm = fakeToolManager();
        (tm as any).getSttVocabulary = () => ['Kitchen', 'Taklampe stue'];
        provider = new OpenAIRealtimeProvider(homey as any, tm as any, { ...baseOpts });

        const ws = await connect();
        expect(ws.url).toContain('model=gpt-realtime-2025-08-28');

        const update = ws.parsedSent().find(m => m.type === 'session.update');
        const transcription = update.session.audio.input.transcription;
        expect(transcription.prompt).toContain('Kitchen');
        expect(transcription.prompt).toContain('Taklampe stue');
    });

    it('omits the transcription prompt while the device catalog is empty', async () => {
        makeProvider(); // module-level fake tool manager returns no vocabulary
        const ws = await connect();
        const update = ws.parsedSent().find(m => m.type === 'session.update');
        expect(update.session.audio.input.transcription.prompt).toBeUndefined();
    });

    it('decodes base64 audio deltas into a Buffer', async () => {
        makeProvider();
        const ws = await connect();
        const audioSpy = vi.fn();
        provider.on('audio.delta', audioSpy);

        const pcm = Buffer.from([1, 2, 3, 4, 250]);
        ws.__message({ type: 'response.output_audio.delta', delta: pcm.toString('base64') });
        await tick();

        expect(audioSpy).toHaveBeenCalledTimes(1);
        expect(Buffer.compare(audioSpy.mock.calls[0][0], pcm)).toBe(0);
    });

    it('suppresses response.done for a tool-call response but emits it for a normal one', async () => {
        makeProvider();
        const ws = await connect();
        const doneSpy = vi.fn();
        provider.on('response.done', doneSpy);

        // Tool-call response: a continuation is coming, so no response.done.
        ws.__message({ type: 'response.done', response: { output: [{ type: 'function_call' }] } });
        await tick();
        expect(doneSpy).not.toHaveBeenCalled();

        // Normal response ends the turn.
        ws.__message({ type: 'response.done', response: { output: [{ type: 'message' }] } });
        await tick();
        expect(doneSpy).toHaveBeenCalledTimes(1);
    });

    it('ignores a malformed (non-JSON) message without crashing', async () => {
        makeProvider();
        const ws = await connect();
        expect(() => ws.__message('this is not json {')).not.toThrow();
        await tick();

        // The provider still processes valid messages afterwards.
        const doneSpy = vi.fn();
        provider.on('response.done', doneSpy);
        ws.__message({ type: 'response.done', response: { output: [] } });
        await tick();
        expect(doneSpy).toHaveBeenCalledTimes(1);
    });

    it('executes a tool call and feeds the result back to the model', async () => {
        makeProvider();
        const ws = await connect();
        const called = vi.fn();
        const completed = vi.fn();
        provider.on('tool.called', called);
        provider.on('tool.completed', completed);

        // Seed the call, then complete the item to trigger execution.
        ws.__message({
            type: 'response.output_item.added', output_index: 0,
            item: { type: 'function_call', call_id: 'c1', id: 'i1', name: 'get_time', arguments: '{}' },
        });
        ws.__message({
            type: 'response.output_item.done',
            item: { type: 'function_call', call_id: 'c1', name: 'get_time', arguments: '{}' },
        });
        await tick();
        await tick();

        expect(called).toHaveBeenCalledWith(expect.objectContaining({ name: 'get_time' }));
        expect(completed).toHaveBeenCalled();

        const sent = ws.parsedSent();
        expect(sent.some(m => m.type === 'conversation.item.create' && m.item?.type === 'function_call_output')).toBe(true);
        expect(sent.some(m => m.type === 'response.create')).toBe(true);
    });

    it('H-g — sendAudioChunk on a dead socket drops the frame and schedules a reconnect instead of throwing', async () => {
        vi.useFakeTimers();
        makeProvider();
        await provider.start();
        const ws = createdSockets[0];
        ws.__open();
        await Promise.resolve();

        // Socket dies (Wi-Fi blip). The device keeps pumping mic frames unguarded.
        ws.close();
        const sentBefore = ws.sent.length;
        expect(() => provider.sendAudioChunk(Buffer.from([1, 2, 3, 4]))).not.toThrow();
        expect(ws.sent.length).toBe(sentBefore); // frame dropped, not sent

        // The dropped frame kicked the reconnect campaign.
        await vi.advanceTimersByTimeAsync(6000);
        expect(createdSockets.length).toBe(2);
    });

    it('H-f — socket closing during tool execution does not produce an unhandled rejection', async () => {
        // A tool whose handler closes the socket while running — the classic
        // "turn on the lights" + Wi-Fi drop mid-execution.
        let wsRef: InstanceType<typeof FakeWebSocket>;
        const tm = fakeToolManager({
            slow_tool: async () => { wsRef.close(); return { ok: true }; },
        });
        const homey = new MockHomey();
        provider = new OpenAIRealtimeProvider(homey as any, tm as any, { ...baseOpts });
        const ws = await connect();
        wsRef = ws;

        const rejections: unknown[] = [];
        const onRejection = (err: unknown) => rejections.push(err);
        process.on('unhandledRejection', onRejection);
        try {
            const completed = vi.fn();
            provider.on('tool.completed', completed);

            ws.__message({
                type: 'response.output_item.added', output_index: 0,
                item: { type: 'function_call', call_id: 'c9', id: 'i9', name: 'slow_tool', arguments: '{}' },
            });
            ws.__message({
                type: 'response.output_item.done',
                item: { type: 'function_call', call_id: 'c9', id: 'i9', name: 'slow_tool', arguments: '{}' },
            });
            // Let the async tool run, the socket close, and the guarded send fail.
            await tick();
            await tick();
            await tick();

            expect(completed).toHaveBeenCalledWith(expect.objectContaining({ result: { ok: true } }));
            expect(rejections).toEqual([]);
        } finally {
            process.off('unhandledRejection', onRejection);
        }
    });

    it('H-f — a throwing tool handler still feeds a structured error back to the model', async () => {
        const tm = fakeToolManager({
            broken_tool: async () => { throw new Error('device unreachable'); },
        });
        const homey = new MockHomey();
        provider = new OpenAIRealtimeProvider(homey as any, tm as any, { ...baseOpts });
        const ws = await connect();

        const completed = vi.fn();
        provider.on('tool.completed', completed);

        ws.__message({
            type: 'response.output_item.added', output_index: 0,
            item: { type: 'function_call', call_id: 'c8', id: 'i8', name: 'broken_tool', arguments: '{}' },
        });
        ws.__message({
            type: 'response.output_item.done',
            item: { type: 'function_call', call_id: 'c8', id: 'i8', name: 'broken_tool', arguments: '{}' },
        });
        await tick();
        await tick();

        expect(completed).toHaveBeenCalledWith(expect.objectContaining({
            result: { error: 'device unreachable' },
        }));
        const sent = ws.parsedSent();
        const fnOut = sent.find(m => m.type === 'conversation.item.create' && m.item?.type === 'function_call_output');
        expect(fnOut).toBeDefined();
        expect(JSON.parse(fnOut.item.output)).toEqual({ error: 'device unreachable' });
        // The continuation asks the model to explain the failure.
        const cont = sent.filter(m => m.type === 'response.create').pop();
        expect(cont.response.instructions).toBeTruthy();
    });

    it('C2 — keeps reconnecting after repeated failed attempts', async () => {
        vi.useFakeTimers();
        makeProvider();

        await provider.start();
        expect(createdSockets.length).toBe(1);
        createdSockets[0].__open();
        await Promise.resolve();

        // First drop -> schedule reconnect -> second socket.
        createdSockets[0].close();
        await vi.advanceTimersByTimeAsync(6000);
        expect(createdSockets.length).toBe(2);

        // Second attempt ALSO fails to connect -> must schedule again (the C2 fix).
        // Pre-fix, isReconnecting stayed true and the campaign died here at 2.
        createdSockets[1].close();
        await vi.advanceTimersByTimeAsync(6000);
        expect(createdSockets.length).toBe(3);
    });

    /**
     * Portal report 87154194 (2026-08-22): the user's OpenAI PROJECT was not
     * allowed to use gpt-4o-transcribe. Replies are anchored on that sidecar
     * transcript, so every turn died silently on the thinking ring. The agent now
     * walks a fallback chain and rescues the failed turn from the audio item.
     */
    describe('model_not_found on the sidecar STT — fallback chain + turn rescue', () => {
        const refused = (model: string, item_id = 'item_1') => ({
            type: 'conversation.item.input_audio_transcription.failed',
            item_id,
            content_index: 0,
            error: {
                type: 'invalid_request_error',
                code: 'model_not_found',
                message: `Project \`proj_x\` does not have access to model \`${model}\``,
                param: null,
            },
        });

        it('starts on gpt-4o-transcribe', async () => {
            makeProvider();
            const ws = await connect();
            const update = ws.parsedSent().find(m => m.type === 'session.update');
            expect(update.session.audio.input.transcription.model).toBe('gpt-4o-transcribe');
            expect(provider.sttModel).toBe('gpt-4o-transcribe');
        });

        it('falls back to the next model, tells the host, and answers the failed turn from the audio', async () => {
            makeProvider();
            const ws = await connect();
            const unavailable = vi.fn();
            const transcriptDone = vi.fn();
            const responseError = vi.fn();
            provider.on('model_unavailable', unavailable);
            provider.on('transcript.done', transcriptDone);
            provider.on('response.error', responseError);
            const sentBefore = ws.sent.length;

            ws.__message(refused('gpt-4o-transcribe'));
            await tick();

            // 1. later turns use the next model — a partial session.update.
            const updates = ws.parsedSent().slice(sentBefore).filter(m => m.type === 'session.update');
            expect(updates).toHaveLength(1);
            expect(updates[0].session.audio.input.transcription.model).toBe('gpt-4o-mini-transcribe');
            expect(updates[0].session.audio.input.transcription.language).toBe('en');
            expect(provider.sttModel).toBe('gpt-4o-mini-transcribe');
            // 2. the host is told what was refused and what replaced it.
            expect(unavailable).toHaveBeenCalledWith({ stage: 'stt', model: 'gpt-4o-transcribe', fallback: 'gpt-4o-mini-transcribe' });
            // 3. THIS turn is rescued: placeholder transcript + a bare response.create
            //    (no text anchor — the model answers the committed audio itself).
            expect(transcriptDone).toHaveBeenCalledWith(OpenAIRealtimeProvider.TRANSCRIPT_UNAVAILABLE);
            const after = ws.parsedSent().slice(sentBefore);
            expect(after.map(m => m.type)).toContain('response.create');
            expect(after.map(m => m.type)).not.toContain('conversation.item.create');
            // And it is NOT surfaced as a response.error — that would abort the rescued turn.
            expect(responseError).not.toHaveBeenCalled();
        });

        it('walks the whole chain and keeps rescuing turns once it is exhausted', async () => {
            makeProvider();
            const ws = await connect();
            const unavailable = vi.fn();
            provider.on('model_unavailable', unavailable);

            ws.__message(refused('gpt-4o-transcribe', 'item_1'));
            await tick();
            ws.__message(refused('gpt-4o-mini-transcribe', 'item_2'));
            await tick();
            expect(provider.sttModel).toBe('whisper-1');

            const sentBefore = ws.sent.length;
            ws.__message(refused('whisper-1', 'item_3'));
            await tick();

            // Chain exhausted: no further session.update, fallback reported as null,
            // but the turn is still answered from the audio.
            expect(unavailable).toHaveBeenLastCalledWith({ stage: 'stt', model: 'whisper-1', fallback: null });
            const after = ws.parsedSent().slice(sentBefore);
            expect(after.map(m => m.type)).not.toContain('session.update');
            expect(after.map(m => m.type)).toContain('response.create');
            expect(provider.sttModel).toBe('whisper-1');
        });

        it('does not answer a refused transcription of an idle-timeout commit (room tone)', async () => {
            makeProvider();
            const ws = await connect();
            const transcriptDone = vi.fn();
            provider.on('transcript.done', transcriptDone);
            // Stream long enough that the timeout is genuine, then let it fire.
            (provider as any).audioStreamingSinceMs = Date.now() - 20_000;
            ws.__message({ type: 'input_audio_buffer.timeout_triggered', item_id: 'item_tone' });
            await tick();
            const sentBefore = ws.sent.length;
            transcriptDone.mockClear();

            ws.__message(refused('gpt-4o-transcribe', 'item_tone'));
            await tick();

            // Fallback still happens, but no response is created for room tone.
            expect(provider.sttModel).toBe('gpt-4o-mini-transcribe');
            expect(ws.parsedSent().slice(sentBefore).map(m => m.type)).not.toContain('response.create');
            expect(transcriptDone).not.toHaveBeenCalled();
        });

        it('any OTHER transcription failure is surfaced as response.error so the host ends the turn', async () => {
            makeProvider();
            const ws = await connect();
            const responseError = vi.fn();
            const unavailable = vi.fn();
            provider.on('response.error', responseError);
            provider.on('model_unavailable', unavailable);

            ws.__message({
                type: 'conversation.item.input_audio_transcription.failed',
                item_id: 'item_1',
                error: { type: 'server_error', code: 'internal_error', message: 'transcription backend unavailable' },
            });
            await tick();

            expect(responseError).toHaveBeenCalledTimes(1);
            expect(unavailable).not.toHaveBeenCalled();
            expect(provider.sttModel).toBe('gpt-4o-transcribe');
        });
    });

    describe('textToSpeech — HTTP errors and the TTS model fallback', () => {
        const okFlac = () => new Response(new Uint8Array([0x66, 0x4c, 0x61, 0x43]), { status: 200 });
        const refusedJson = (model: string) => new Response(JSON.stringify({
            error: { type: 'invalid_request_error', code: 'model_not_found', message: `Project \`proj_x\` does not have access to model \`${model}\``, param: null },
        }), { status: 404, headers: { 'content-type': 'application/json' } });

        afterEach(() => vi.unstubAllGlobals());

        it('uses gpt-4o-mini-tts with instructions by default', async () => {
            makeProvider();
            const fetchMock = vi.fn(async () => okFlac());
            vi.stubGlobal('fetch', fetchMock);

            const buf = await provider.textToSpeech('hello');

            expect(buf.toString('latin1')).toBe('fLaC');
            const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
            expect(body.model).toBe('gpt-4o-mini-tts-2025-12-15');
            expect(body.instructions).toBeDefined();
        });

        it('names the configured language and asks for a verbatim read', async () => {
            makeProvider();
            await provider.updateLanguage('no', 'Norwegian');
            const fetchMock = vi.fn(async () => okFlac());
            vi.stubGlobal('fetch', fetchMock);

            await provider.textToSpeech('Flink du!');

            const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
            expect(body.input).toBe('Flink du!');
            expect(body.instructions).toMatch(/Speak Norwegian/);
            expect(body.instructions).toMatch(/exactly as written/);
        });

        it('retries once on tts-1 when the project refuses the model, and tells the host', async () => {
            makeProvider();
            const unavailable = vi.fn();
            provider.on('model_unavailable', unavailable);
            const fetchMock = vi.fn()
                .mockImplementationOnce(async () => refusedJson('gpt-4o-mini-tts-2025-12-15'))
                .mockImplementationOnce(async () => okFlac());
            vi.stubGlobal('fetch', fetchMock);

            const buf = await provider.textToSpeech('hello');

            expect(buf.toString('latin1')).toBe('fLaC');
            expect(fetchMock).toHaveBeenCalledTimes(2);
            const second = JSON.parse((fetchMock.mock.calls[1] as any)[1].body);
            expect(second.model).toBe('tts-1');
            // tts-1 does not take steering instructions.
            expect(second.instructions).toBeUndefined();
            expect(unavailable).toHaveBeenCalledWith({ stage: 'tts', model: 'gpt-4o-mini-tts-2025-12-15', fallback: 'tts-1' });
            // Sticky: the next call goes straight to tts-1.
            expect(provider.ttsModel).toBe('tts-1');
        });

        it('throws with the server message instead of returning an error body as audio', async () => {
            makeProvider();
            vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
                error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Incorrect API key provided' },
            }), { status: 401 })));

            await expect(provider.textToSpeech('hello')).rejects.toThrow(/Incorrect API key provided/);
        });

        it('throws once the TTS chain is exhausted', async () => {
            makeProvider();
            const unavailable = vi.fn();
            provider.on('model_unavailable', unavailable);
            vi.stubGlobal('fetch', vi.fn()
                .mockImplementationOnce(async () => refusedJson('gpt-4o-mini-tts-2025-12-15'))
                .mockImplementationOnce(async () => refusedJson('tts-1')));

            await expect(provider.textToSpeech('hello')).rejects.toThrow(/tts-1/);
            expect(unavailable).toHaveBeenLastCalledWith({ stage: 'tts', model: 'tts-1', fallback: null });
        });
    });
});

