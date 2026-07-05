import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WhisperClient } from '../src/llm/providers/local/whisper-client.mjs';
import { OllamaClient } from '../src/llm/providers/local/ollama-client.mjs';
import { MistralClient } from '../src/llm/providers/local/mistral-client.mjs';
import { MistralSttClient } from '../src/llm/providers/local/mistral-stt-client.mjs';
import { MistralTtsClient, voxtralVoiceName } from '../src/llm/providers/local/mistral-tts-client.mjs';
import { generateToolCallId, sanitizeToolCallId } from '../src/llm/providers/local/llm-client.mjs';
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
            [{ name: 't', description: '', parameters: {} }],
            (d) => deltas.push(d),
        );
        expect(result.content).toBe('Hello!');
        expect(result.toolCalls).toEqual([]);
        expect(deltas).toEqual(['Hel', 'lo!']);
    });

    it('collects tool calls from the stream (normalized, with generated ids)', async () => {
        const client = new OllamaClient({ host: 'llm.local', port: 11434, model: 'qwen3' });
        fetchImpl = () => streamResponse([
            { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_time', arguments: { zone: 'Office' } } }] }, done: false },
            { message: { role: 'assistant', content: '' }, done: true },
        ]);

        const result = await client.chat([{ role: 'user', content: 'time?' }], []);
        expect(result.toolCalls.length).toBe(1);
        expect(result.toolCalls[0].name).toBe('get_time');
        expect(result.toolCalls[0].args).toEqual({ zone: 'Office' });
        // Ollama sends no ids — a Mistral-safe 9-char id is generated locally.
        expect(result.toolCalls[0].id).toMatch(/^[a-zA-Z0-9]{9}$/);
    });

    it('serializes neutral tool history to the Ollama wire format', async () => {
        const client = new OllamaClient({ host: 'llm.local', port: 11434, model: 'qwen3' });
        fetchImpl = () => streamResponse([{ message: { role: 'assistant', content: 'ok' }, done: true }]);

        await client.chat([
            { role: 'user', content: 'time?' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'abc123XYZ', name: 'get_time', args: { zone: 'Office' } }] },
            { role: 'tool', toolCallId: 'abc123XYZ', toolName: 'get_time', content: '{"now":"12:00"}' },
        ], []);

        const body = JSON.parse(fetchCalls[0].init.body);
        expect(body.messages[1].tool_calls).toEqual([{ function: { name: 'get_time', arguments: { zone: 'Office' } } }]);
        expect(body.messages[2]).toEqual({ role: 'tool', tool_name: 'get_time', content: '{"now":"12:00"}' });
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

/** MistralClient ---------------------------------------------------------------- */

/** SSE body: `data: {...}` events terminated by `data: [DONE]`. */
function sseResponse(events: any[]) {
    const encoder = new TextEncoder();
    return {
        ok: true,
        status: 200,
        text: async () => '',
        body: (async function* () {
            for (const e of events) {
                yield encoder.encode(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
            }
            yield encoder.encode('data: [DONE]\n\n');
        })(),
    };
}

describe('MistralClient', () => {
    it('streams SSE content deltas with the Bearer key and OpenAI-style tools', async () => {
        const client = new MistralClient({ apiKey: 'sk-test', model: 'mistral-small-latest' });
        fetchImpl = (url, init) => {
            expect(url).toBe('https://api.mistral.ai/v1/chat/completions');
            expect(init.headers.Authorization).toBe('Bearer sk-test');
            const body = JSON.parse(init.body);
            expect(body.model).toBe('mistral-small-latest');
            expect(body.stream).toBe(true);
            expect(body.tools[0]).toEqual({ type: 'function', function: { name: 't', description: 'd', parameters: {} } });
            return sseResponse([
                { choices: [{ delta: { role: 'assistant', content: 'Bon' } }] },
                { choices: [{ delta: { content: 'jour!' } }] },
            ]);
        };

        const deltas: string[] = [];
        const result = await client.chat(
            [{ role: 'user', content: 'salut' }],
            [{ name: 't', description: 'd', parameters: {} }],
            (d) => deltas.push(d),
        );
        expect(result.content).toBe('Bonjour!');
        expect(deltas).toEqual(['Bon', 'jour!']);
        expect(result.toolCalls).toEqual([]);
    });

    it('accumulates a tool call fragmented across SSE chunks', async () => {
        const client = new MistralClient({ apiKey: 'sk-test', model: '' });
        fetchImpl = () => sseResponse([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'D681PevKs', function: { name: 'get_time', arguments: '{"zo' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ne":"Office"}' } }] } }] },
        ]);

        const result = await client.chat([{ role: 'user', content: 'time?' }], []);
        expect(result.toolCalls).toEqual([{ id: 'D681PevKs', name: 'get_time', args: { zone: 'Office' } }]);
    });

    it('serializes neutral tool history to the Mistral wire format (sanitized ids)', async () => {
        const client = new MistralClient({ apiKey: 'sk-test', model: '' });
        fetchImpl = () => sseResponse([{ choices: [{ delta: { content: 'ok' } }] }]);

        await client.chat([
            { role: 'assistant', content: '', toolCalls: [{ id: 'not!a-valid-id', name: 'get_time', args: { zone: 'Office' } }] },
            { role: 'tool', toolCallId: 'not!a-valid-id', toolName: 'get_time', content: '{"now":"12:00"}' },
        ], []);

        const body = JSON.parse(fetchCalls[0].init.body);
        const wireCall = body.messages[0].tool_calls[0];
        expect(wireCall.type).toBe('function');
        expect(wireCall.function.name).toBe('get_time');
        expect(wireCall.function.arguments).toBe('{"zone":"Office"}'); // string-encoded
        expect(wireCall.id).toMatch(/^[a-zA-Z0-9]{9}$/);
        // The tool result echoes the SAME sanitized id, keeping the pair linked.
        expect(body.messages[1]).toMatchObject({ role: 'tool', name: 'get_time', tool_call_id: wireCall.id });
    });

    it('defaults the model and reports missing credentials without a key', async () => {
        const noKey = new MistralClient({ apiKey: '', model: '' });
        expect(noKey.isConfigured()).toBe(false);
        expect(noKey.hasCredentials()).toBe(false);

        const client = new MistralClient({ apiKey: 'sk', model: '' });
        fetchImpl = () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }]);
        await client.chat([{ role: 'user', content: 'hi' }], []);
        expect(JSON.parse(fetchCalls[0].init.body).model).toBe('mistral-small-latest');
    });

    it('rejects with a clear message on a 401 health check', async () => {
        const client = new MistralClient({ apiKey: 'bad', model: '' });
        fetchImpl = () => jsonResponse({ message: 'Unauthorized' }, 401);
        await expect(client.check()).rejects.toThrow(/API key was rejected/);
    });
});

describe('tool-call id helpers', () => {
    it('generates Mistral-valid 9-char ids', () => {
        for (let i = 0; i < 20; i++) {
            expect(generateToolCallId()).toMatch(/^[a-zA-Z0-9]{9}$/);
        }
    });

    it('sanitizes deterministically and passes valid ids through', () => {
        expect(sanitizeToolCallId('D681PevKs')).toBe('D681PevKs');
        const a = sanitizeToolCallId('local-call-1');
        expect(a).toMatch(/^[a-zA-Z0-9]{9}$/);
        expect(sanitizeToolCallId('local-call-1')).toBe(a);
        expect(sanitizeToolCallId('local-call-2')).not.toBe(a);
    });
});

/** MistralSttClient (Voxtral transcription) -------------------------------------- */

describe('MistralSttClient', () => {
    const pcm = Buffer.alloc(3200); // 100 ms of silence @16k

    it('uploads a WAV to /v1/audio/transcriptions with model + language', async () => {
        const client = new MistralSttClient({ apiKey: 'sk-test', model: '' });
        fetchImpl = (url, init) => {
            expect(url).toBe('https://api.mistral.ai/v1/audio/transcriptions');
            expect(init.headers.Authorization).toBe('Bearer sk-test');
            expect(init.headers['x-api-key']).toBe('sk-test');
            const form = init.body as FormData;
            expect(form.get('model')).toBe('voxtral-mini-latest'); // default
            expect(form.get('language')).toBe('no');
            expect(form.get('file')).toBeTruthy();
            return jsonResponse({ text: ' skru på lyset ', language: 'no' });
        };

        expect(await client.transcribe(pcm, 'no')).toBe('skru på lyset');
    });

    it('reports missing credentials without a key', () => {
        const client = new MistralSttClient({ apiKey: '', model: '' });
        expect(client.isConfigured()).toBe(false);
        expect(client.hasCredentials()).toBe(false);
    });

    it('surfaces HTTP errors with detail', async () => {
        const client = new MistralSttClient({ apiKey: 'sk', model: 'voxtral-mini-2507' });
        fetchImpl = () => jsonResponse({ message: 'quota exceeded' }, 429);
        await expect(client.transcribe(pcm, 'en')).rejects.toThrow(/HTTP 429/);
    });
});

/** MistralTtsClient (Voxtral TTS) ------------------------------------------------ */

describe('MistralTtsClient', () => {
    const wav24k = pcmToWav(Buffer.alloc(24000 * 2), 24000, 1); // 1 s @24k

    it('synthesizes via /v1/audio/speech and returns 24 kHz PCM', async () => {
        const client = new MistralTtsClient({ apiKey: 'sk-test', model: '', voice: 'casual_male' });
        fetchImpl = (url, init) => {
            expect(url).toBe('https://api.mistral.ai/v1/audio/speech');
            expect(init.headers.Authorization).toBe('Bearer sk-test');
            const body = JSON.parse(init.body);
            expect(body).toMatchObject({
                input: 'Hei på deg.',
                voice_id: 'casual_male', // API field is voice_id (per Mistral's OpenAPI spec)
                response_format: 'wav',
            });
            // model is optional — omitted, the server default applies.
            expect(body).not.toHaveProperty('model');
            return binaryResponse(wav24k);
        };

        const { pcm, sampleRate } = await client.synthesize('Hei på deg.');
        expect(sampleRate).toBe(24000);
        expect(pcm.length).toBe(24000 * 2);
    });

    it('pins the model when one is configured', async () => {
        const client = new MistralTtsClient({ apiKey: 'sk-test', model: 'voxtral-mini-tts-2603', voice: 'neutral_male' });
        fetchImpl = (url, init) => {
            expect(JSON.parse(init.body).model).toBe('voxtral-mini-tts-2603');
            return binaryResponse(wav24k);
        };
        await client.synthesize('test');
    });

    it('falls back to the default voice for non-Voxtral voice names', async () => {
        const client = new MistralTtsClient({ apiKey: 'sk', model: '', voice: 'server-default' });
        fetchImpl = (url, init) => {
            expect(JSON.parse(init.body).voice_id).toBe('neutral_female');
            return binaryResponse(wav24k);
        };
        await client.synthesize('test');

        // setVoice flows a valid preset through unchanged.
        client.setVoice('fr_female');
        fetchImpl = (url, init) => {
            expect(JSON.parse(init.body).voice_id).toBe('fr_female');
            return binaryResponse(wav24k);
        };
        await client.synthesize('encore');
    });

    it('voxtralVoiceName accepts presets and OpenAI aliases, rejects the rest', () => {
        expect(voxtralVoiceName('neutral_male')).toBe('neutral_male');
        expect(voxtralVoiceName('alloy')).toBe('alloy'); // legacy OpenAI name still works
        expect(voxtralVoiceName('Kore')).toBe('neutral_female'); // Gemini leftover
        expect(voxtralVoiceName(undefined)).toBe('neutral_female');
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
