import { describe, it, expect, beforeEach, vi } from 'vitest';

// Fake the `ws` package so the client runs with no network.
vi.mock('ws', () => import('./mocks/mock-ws.mjs'));

import { MistralRealtimeSttClient, DEFAULT_MISTRAL_REALTIME_STT_MODEL } from '../src/llm/providers/local/mistral-realtime-stt-client.mjs';
import { createdSockets, __resetSockets } from './mocks/mock-ws.mjs';

describe('MistralRealtimeSttClient (fake WebSocket harness)', () => {
    beforeEach(() => { __resetSockets(); });

    it('configures the session, streams chunked audio and returns the final transcript', async () => {
        const client = new MistralRealtimeSttClient({ apiKey: 'sk-test', model: '' });
        const pcm = Buffer.alloc(200_000, 1); // > 3 × 65536 → four append messages

        const promise = client.transcribe(pcm, 'no');
        const ws = createdSockets[0];
        expect(ws.url).toBe(`wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=${DEFAULT_MISTRAL_REALTIME_STT_MODEL}`);
        expect(ws.opts.headers.Authorization).toBe('Bearer sk-test');

        ws.__message({ type: 'session.created', session: { request_id: 'r1', model: DEFAULT_MISTRAL_REALTIME_STT_MODEL } });

        const sent = ws.parsedSent();
        expect(sent[0]).toEqual({
            type: 'session.update',
            session: { audio_format: { encoding: 'pcm_s16le', sample_rate: 16000 }, target_streaming_delay_ms: 480 },
        });
        const appends = sent.filter(m => m.type === 'input_audio.append');
        expect(appends).toHaveLength(4);
        const decoded = appends.map(m => Buffer.from(m.audio, 'base64'));
        expect(decoded.every(b => b.length <= 65_536)).toBe(true);
        expect(decoded.reduce((n, b) => n + b.length, 0)).toBe(pcm.length);
        expect(ws.sentTypes().slice(-2)).toEqual(['input_audio.flush', 'input_audio.end']);

        ws.__message({ type: 'transcription.language', audio_language: 'no' }); // informational
        ws.__message({ type: 'transcription.text.delta', text: 'Hei ' });
        ws.__message({ type: 'transcription.done', text: 'Hei på deg.', model: DEFAULT_MISTRAL_REALTIME_STT_MODEL });

        await expect(promise).resolves.toBe('Hei på deg.');
    });

    it('falls back to accumulated deltas when done carries no text', async () => {
        const client = new MistralRealtimeSttClient({ apiKey: 'sk-test', model: 'custom-rt' });
        const promise = client.transcribe(Buffer.alloc(320), 'en');
        const ws = createdSockets[0];
        expect(ws.url).toContain('model=custom-rt');

        ws.__message({ type: 'session.created', session: { request_id: 'r2', model: 'custom-rt' } });
        ws.__message({ type: 'transcription.text.delta', text: 'turn on ' });
        ws.__message({ type: 'transcription.text.delta', text: 'the lights' });
        ws.__message({ type: 'transcription.done' });

        await expect(promise).resolves.toBe('turn on the lights');
    });

    it('rejects on a server error event', async () => {
        const client = new MistralRealtimeSttClient({ apiKey: 'sk-test', model: '' });
        const promise = client.transcribe(Buffer.alloc(320), 'en');
        const ws = createdSockets[0];

        ws.__message({ type: 'session.created', session: { request_id: 'r3', model: 'm' } });
        ws.__message({ type: 'error', error: { message: 'quota exceeded' } });

        await expect(promise).rejects.toThrow(/quota exceeded/);
    });

    it('rejects when the socket dies before the transcript is done', async () => {
        const client = new MistralRealtimeSttClient({ apiKey: 'sk-test', model: '' });
        const promise = client.transcribe(Buffer.alloc(320), 'en');
        createdSockets[0].__fail();
        await expect(promise).rejects.toThrow(/websocket/i);
    });
});
