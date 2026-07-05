import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WhisperClient } from '../src/llm/providers/local/whisper-client.mjs';
import { OllamaClient } from '../src/llm/providers/local/ollama-client.mjs';
import { PiperClient } from '../src/llm/providers/local/piper-client.mjs';
import { pcmToWav } from '../src/helpers/wav.mjs';

/** fetch-mock helpers -------------------------------------------------------- */

type FetchCall = { url: string; init?: any };
let fetchCalls: FetchCall[] = [];
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

function binaryResponse(buf: Buffer, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => '',
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
}

/** NDJSON streaming body: an async-iterable of encoded lines (what undici gives us). */
function streamResponse(lines: any[]) {
    const encoder = new TextEncoder();
    return {
        ok: true,
        status: 200,
        text: async () => '',
        body: (async function* () {
            for (const line of lines) {
                yield encoder.encode(JSON.stringify(line) + '\n');
            }
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

afterEach(() => {
    vi.unstubAllGlobals();
});

/** WhisperClient -------------------------------------------------------------- */

describe('WhisperClient', () => {
    const pcm = Buffer.alloc(3200); // 100 ms of silence @16k

    it('transcribes via the /asr flavor and caches the detected style', async () => {
        const client = new WhisperClient({ host: '10.0.0.2', port: 9000 });
        fetchImpl = (url) => {
            expect(url).toContain('http://10.0.0.2:9000/asr?');
            expect(url).toContain('language=no');
            expect(url).toContain('output=json');
            return jsonResponse({ text: ' skru på lyset ' });
        };

        expect(await client.transcribe(pcm, 'no')).toBe('skru på lyset');
        expect(await client.transcribe(pcm, 'no')).toBe('skru på lyset');
        expect(fetchCalls.length).toBe(2); // no re-probing on the second call
        const form = fetchCalls[0].init.body as FormData;
        expect(form.get('audio_file')).toBeTruthy();
    });

    it('falls back to the OpenAI-compatible flavor when /asr is missing', async () => {
        const client = new WhisperClient({ host: 'stt.local', port: 8000 });
        fetchImpl = (url) => {
            if (url.includes('/asr')) return jsonResponse('not found', 404);
            expect(url).toContain('/v1/audio/transcriptions');
            return jsonResponse({ text: 'turn on the light' });
        };

        expect(await client.transcribe(pcm, 'en')).toBe('turn on the light');

        // Style is cached: the next call goes straight to the OpenAI endpoint.
        fetchCalls = [];
        await client.transcribe(pcm, 'en');
        expect(fetchCalls.length).toBe(1);
        expect(fetchCalls[0].url).toContain('/v1/audio/transcriptions');
    });

    it('accepts a plain-text response body', async () => {
        const client = new WhisperClient({ host: 'stt.local', port: 9000 });
        fetchImpl = () => jsonResponse('just plain text\n');
        expect(await client.transcribe(pcm, 'en')).toBe('just plain text');
    });

    it('forgets the detected style when reconfigured to another server', async () => {
        const client = new WhisperClient({ host: 'a', port: 9000 });
        fetchImpl = () => jsonResponse({ text: 'x' });
        await client.transcribe(pcm, 'en');
        client.configure({ host: 'b', port: 9000 });
        fetchCalls = [];
        fetchImpl = (url) => (url.includes('/asr') ? jsonResponse('nope', 404) : jsonResponse({ text: 'y' }));
        expect(await client.transcribe(pcm, 'en')).toBe('y');
        expect(fetchCalls.some((c) => c.url.includes('b:9000'))).toBe(true);
    });
});

/** OllamaClient ---------------------------------------------------------------- */

describe('OllamaClient', () => {
    it('streams content deltas and returns the full text', async () => {
        const client = new OllamaClient({ host: 'llm.local', port: 11434, model: 'qwen3' });
        fetchImpl = (url, init) => {
            expect(url).toBe('http://llm.local:11434/api/chat');
            const body = JSON.parse(init.body);
            expect(body.model).toBe('qwen3');
            expect(body.stream).toBe(true);
            expect(body.tools.length).toBe(1);
            return streamResponse([
                { message: { role: 'assistant', content: 'Hel' }, done: false },
                { message: { role: 'assistant', content: 'lo!' }, done: false },
                { message: { role: 'assistant', content: '' }, done: true },
            ]);
        };

        const deltas: string[] = [];
        const result = await client.chat(
            [{ role: 'user', content: 'hi' }],
            [{ type: 'function', function: { name: 't', description: '', parameters: {} } }],
            (d) => deltas.push(d),
        );
        expect(result.content).toBe('Hello!');
        expect(result.toolCalls).toEqual([]);
        expect(deltas).toEqual(['Hel', 'lo!']);
    });

    it('collects tool calls from the stream', async () => {
        const client = new OllamaClient({ host: 'llm.local', port: 11434, model: 'qwen3' });
        fetchImpl = () => streamResponse([
            { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_time', arguments: { zone: 'Office' } } }] }, done: false },
            { message: { role: 'assistant', content: '' }, done: true },
        ]);

        const result = await client.chat([{ role: 'user', content: 'time?' }], []);
        expect(result.toolCalls.length).toBe(1);
        expect(result.toolCalls[0].function.name).toBe('get_time');
        expect(result.toolCalls[0].function.arguments).toEqual({ zone: 'Office' });
    });

    it('auto-picks the first installed model when none is configured', async () => {
        const client = new OllamaClient({ host: 'llm.local', port: 11434, model: '' });
        fetchImpl = (url) => {
            if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'llama3.1:8b' }, { name: 'qwen3' }] });
            return streamResponse([{ message: { role: 'assistant', content: 'ok' }, done: true }]);
        };

        await client.chat([{ role: 'user', content: 'hi' }], []);
        const chatCall = fetchCalls.find((c) => c.url.endsWith('/api/chat'))!;
        expect(JSON.parse(chatCall.init.body).model).toBe('llama3.1:8b');
    });

    it('throws a useful error when no models are installed', async () => {
        const client = new OllamaClient({ host: 'llm.local', port: 11434, model: '' });
        fetchImpl = () => jsonResponse({ models: [] });
        await expect(client.chat([], [])).rejects.toThrow(/no models installed/);
    });

    it('surfaces an in-stream error object', async () => {
        const client = new OllamaClient({ host: 'llm.local', port: 11434, model: 'qwen3' });
        fetchImpl = () => streamResponse([{ error: 'model requires more system memory' }]);
        await expect(client.chat([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(/more system memory/);
    });
});

/** PiperClient ------------------------------------------------------------------ */

describe('PiperClient', () => {
    const wav = pcmToWav(Buffer.alloc(22050 * 2), 22050, 1); // 1 s of silence @22.05k

    it('synthesizes via /synthesize and returns PCM + sample rate', async () => {
        const client = new PiperClient({ host: 'tts.local', port: 5000 });
        fetchImpl = (url, init) => {
            expect(url).toBe('http://tts.local:5000/synthesize');
            expect(JSON.parse(init.body)).toEqual({ text: 'Hei på deg.' });
            return binaryResponse(wav);
        };

        const { pcm, sampleRate } = await client.synthesize('Hei på deg.');
        expect(sampleRate).toBe(22050);
        expect(pcm.length).toBe(22050 * 2);
    });

    it('falls back to POST / for older servers and caches the route', async () => {
        const client = new PiperClient({ host: 'tts.local', port: 5000 });
        fetchImpl = (url) => (url.endsWith('/synthesize') ? jsonResponse('nope', 404) : binaryResponse(wav));

        await client.synthesize('test');
        fetchCalls = [];
        await client.synthesize('again');
        expect(fetchCalls.length).toBe(1);
        expect(fetchCalls[0].url).toBe('http://tts.local:5000/');
    });
});
