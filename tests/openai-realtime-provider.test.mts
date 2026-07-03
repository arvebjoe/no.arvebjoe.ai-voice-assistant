import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Fake the `ws` package so the provider runs with no network.
vi.mock('ws', () => import('./mocks/mock-ws.mjs'));

import { OpenAIRealtimeProvider } from '../src/llm/providers/openai-realtime-agent.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { createdSockets, __resetSockets, FakeWebSocket } from './mocks/mock-ws.mjs';

const tick = () => new Promise(r => setTimeout(r, 0));

// Minimal ToolManager stand-in — the provider only needs tool definitions (for the
// session update) and a handler map (for execution).
const toolManager = {
    getToolDefinitions: () => [],
    getToolHandlers: () => ({ get_time: (_args: any) => ({ ok: true, now: '12:00' }) }),
    setStandardZone: () => { },
};

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
        await tick();
        expect(ws.sentTypes()).toContain('session.update');

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
