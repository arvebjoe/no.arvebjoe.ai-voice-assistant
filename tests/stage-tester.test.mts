import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testLocalStage } from '../src/llm/providers/local/stage-tester.mjs';
import { pcmToWav } from '../src/helpers/wav.mjs';

/** fetch mock (same pattern as local-clients.test) ----------------------------- */

let fetchCalls: { url: string; init?: any }[] = [];
let fetchImpl: (url: string, init?: any) => any;

function jsonResponse(body: any, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        json: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
    };
}

function binaryResponse(buf: Buffer) {
    return {
        ok: true,
        status: 200,
        text: async () => '',
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
}

function sseResponse(events: any[]) {
    const encoder = new TextEncoder();
    return {
        ok: true,
        status: 200,
        text: async () => '',
        body: (async function* () {
            for (const e of events) yield encoder.encode(`data: ${JSON.stringify(e)}\n\n`);
            yield encoder.encode('data: [DONE]\n\n');
        })(),
    };
}

beforeEach(() => {
    fetchCalls = [];
    fetchImpl = () => jsonResponse({});
    vi.stubGlobal('fetch', vi.fn((url: any, init?: any) => {
        fetchCalls.push({ url: String(url), init });
        return Promise.resolve(fetchImpl(String(url), init));
    }));
});

afterEach(() => vi.unstubAllGlobals());

describe('testLocalStage', () => {
    it('LLM (openai backend): real chat round-trip reports the reply', async () => {
        fetchImpl = (url) => {
            if (url.endsWith('/models')) return jsonResponse({ data: [] });
            expect(url).toBe('http://10.0.0.5:1234/v1/chat/completions');
            return sseResponse([{ choices: [{ delta: { content: 'OK' } }] }]);
        };
        const res = await testLocalStage({ stage: 'llm', backend: 'openai', url: '10.0.0.5:1234', key: '', model: 'qwen' });
        expect(res.ok).toBe(true);
        expect(res.message).toContain('Model responded: "OK"');
        expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('LLM (ollama backend): surfaces a connection failure with its cause', async () => {
        fetchImpl = () => {
            const err: any = new Error('fetch failed');
            err.cause = { code: 'ECONNREFUSED' };
            throw err;
        };
        const res = await testLocalStage({ stage: 'llm', backend: 'ollama', host: '10.0.0.9', port: 11434, model: 'qwen3' });
        expect(res.ok).toBe(false);
        expect(res.message).toContain('ECONNREFUSED');
    });

    it('STT (whisper backend): silence clip coming back empty is a pass', async () => {
        fetchImpl = (url) => {
            if (url.endsWith('/asr') || url.includes('/asr?')) return jsonResponse({ text: '' });
            return jsonResponse({}); // reachability probe
        };
        const res = await testLocalStage({ stage: 'stt', backend: 'whisper', host: '10.0.0.9', port: 9000, language: 'no' });
        expect(res.ok).toBe(true);
        expect(res.message).toContain('as expected');
    });

    it('STT: a hallucinated transcript of silence is flagged but still a pass', async () => {
        fetchImpl = (url) => (url.includes('/asr') ? jsonResponse({ text: 'Takk for at du så på' }) : jsonResponse({}));
        const res = await testLocalStage({ stage: 'stt', backend: 'whisper', host: 'h', port: 9000, language: 'no' });
        expect(res.ok).toBe(true);
        expect(res.message).toContain('hallucination');
    });

    it('TTS (piper backend): reports duration and sample rate of the test clip', async () => {
        const wav = pcmToWav(Buffer.alloc(22050), 22050, 1); // 0.5 s
        fetchImpl = (url) => (url.endsWith('/synthesize') ? binaryResponse(wav) : jsonResponse({}));
        const res = await testLocalStage({ stage: 'tts', backend: 'piper', host: '10.0.0.9', port: 5000 });
        expect(res.ok).toBe(true);
        expect(res.message).toContain('500 ms of audio at 22050 Hz');
    });

    it('Mistral backends without a key fail fast with a key message', async () => {
        const res = await testLocalStage({ stage: 'tts', backend: 'mistral', mistralApiKey: '', model: '', voice: 'neutral_female' });
        expect(res.ok).toBe(false);
        expect(res.message).toContain('API key missing');
        expect(fetchCalls.length).toBe(0); // never hit the network
    });

    it('unconfigured LAN backend fails fast with a fill-in message', async () => {
        const res = await testLocalStage({ stage: 'llm', backend: 'ollama', host: '', port: '', model: '' });
        expect(res.ok).toBe(false);
        expect(res.message).toContain('Fill in the connection fields');
        expect(fetchCalls.length).toBe(0);
    });

    it('rejected API key on the health probe is reported as such', async () => {
        fetchImpl = () => jsonResponse({ error: 'bad key' }, 401);
        const res = await testLocalStage({ stage: 'llm', backend: 'openai', url: 'api.openai.com', key: 'sk-bad', model: 'gpt-5-mini' });
        expect(res.ok).toBe(false);
        expect(res.message).toContain('rejected the API key');
    });

    it('the None backends pass without a network call and explain what they do', async () => {
        const llm = await testLocalStage({ stage: 'llm', backend: 'none' });
        expect(llm.ok).toBe(true);
        expect(llm.message).toContain('Heard something');

        const tts = await testLocalStage({ stage: 'tts', backend: 'none' });
        expect(tts.ok).toBe(true);
        expect(tts.message).toContain('silent');

        expect(fetchCalls.length).toBe(0);
    });

    it('unknown stage is rejected without touching the network', async () => {
        const res = await testLocalStage({ stage: 'nope' as any, backend: 'whisper' });
        expect(res.ok).toBe(false);
        expect(fetchCalls.length).toBe(0);
    });

    /* ---------- M5: body validation — every rejection stays off the network ---------- */

    it('M5 — non-object bodies are rejected as malformed', async () => {
        for (const body of [null, 'stt', 42, ['stt']]) {
            const res = await testLocalStage(body as any);
            expect(res.ok).toBe(false);
            expect(res.message).toContain('Malformed request body');
        }
        expect(fetchCalls.length).toBe(0);
    });

    it('M5 — non-string fields are rejected by name', async () => {
        const res = await testLocalStage({ stage: 'llm', backend: 'ollama', host: '10.0.0.9', model: { $ne: '' } } as any);
        expect(res.ok).toBe(false);
        expect(res.message).toBe("Field 'model' must be a string");
        expect(fetchCalls.length).toBe(0);
    });

    it('M5 — oversized fields are rejected', async () => {
        const res = await testLocalStage({ stage: 'llm', backend: 'ollama', host: 'x'.repeat(3000), model: 'qwen3' });
        expect(res.ok).toBe(false);
        expect(res.message).toBe("Field 'host' is too long");
        expect(fetchCalls.length).toBe(0);
    });

    it('M5 — out-of-range and non-numeric ports are rejected; empty port still means default', async () => {
        for (const port of [70000, -1, 'abc', '80.5', {} as any]) {
            const res = await testLocalStage({ stage: 'llm', backend: 'ollama', host: '10.0.0.9', port, model: 'qwen3' });
            expect(res.ok).toBe(false);
            expect(res.message).toMatch(/port/i);
        }
        expect(fetchCalls.length).toBe(0);

        // Empty string keeps the existing "use the backend default" behavior.
        const res = await testLocalStage({ stage: 'llm', backend: 'ollama', host: '', port: '', model: '' });
        expect(res.message).toContain('Fill in the connection fields');
    });

    it('M5 — URLs with embedded credentials or non-http schemes are rejected', async () => {
        const withCreds = await testLocalStage({ stage: 'llm', backend: 'openai', url: 'http://user:pass@10.0.0.5/v1', model: 'm' });
        expect(withCreds.ok).toBe(false);
        expect(withCreds.message).toContain('must not contain credentials');

        const ftp = await testLocalStage({ stage: 'llm', backend: 'openai', url: 'ftp://10.0.0.5/v1', model: 'm' });
        expect(ftp.ok).toBe(false);
        expect(ftp.message).toContain('http(s)');

        expect(fetchCalls.length).toBe(0);
    });
});
