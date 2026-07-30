// Regression test for the item-29 outage finding (2026-07-30): after a
// reconnect, session.created -> sendSessionUpdate() puts the SERVER back in
// audio mode, but the client-side outputMode cache still said "text" from
// before the drop — so setOutputMode("text") no-opped and every flow-card
// text request timed out waiting for a text.done the audio-mode session
// never sends. No sockets here: ws is stubbed with a sent-frame recorder.
import { describe, it, expect } from 'vitest';
import { OpenAIRealtimeProvider } from '../src/llm/providers/openai-realtime-agent.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

function makeAgent() {
    const toolManager: any = {
        getToolDefinitions: () => [],
        getSttVocabulary: () => [],
    };
    const agent: any = new OpenAIRealtimeProvider(new MockHomey() as any, toolManager, {
        apiKey: 'test-key',
        url: 'wss://example.invalid/realtime',
        voice: 'alloy',
        languageCode: 'en',
        languageName: 'English',
    } as any);
    const sent: any[] = [];
    // WebSocket.OPEN === 1; send() records the JSON frames the agent emits.
    agent.ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) };
    return { agent, sent };
}

describe('output-mode cache vs session reconfiguration', () => {
    it('sendSessionUpdate resyncs the cache to audio (what it just told the server)', () => {
        const { agent, sent } = makeAgent();

        agent.setOutputMode('text');
        expect(sent.at(-1).session.output_modalities).toEqual(['text']);
        expect(agent.outputMode).toBe('text');

        agent.sendSessionUpdate(); // the reconnect path (session.created handler)
        expect(sent.at(-1).session.output_modalities).toEqual(['audio']);
        expect(agent.outputMode).toBe('audio');
    });

    it('a text request after a session reconfigure flips the session back to text mode', () => {
        const { agent, sent } = makeAgent();

        // Pre-outage: a text request put the session in text mode.
        agent.sendTextForTextResponse('ping 1');
        // Reconnect: the fresh session is configured audio-first.
        agent.sendSessionUpdate();
        // Post-outage text request MUST re-send the text-mode session.update —
        // with the stale cache it skipped this and the request hung.
        agent.sendTextForTextResponse('ping 2');

        const modalityUpdates = sent
            .filter((m) => m.type === 'session.update' && Array.isArray(m.session?.output_modalities))
            .map((m) => m.session.output_modalities[0]);
        expect(modalityUpdates).toEqual(['text', 'audio', 'text']);
    });
});
