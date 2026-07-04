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
});
