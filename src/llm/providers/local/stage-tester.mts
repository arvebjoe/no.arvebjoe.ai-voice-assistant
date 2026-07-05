import { ISttClient } from './stt-client.mjs';
import { ITtsClient } from './tts-client.mjs';
import { ILlmClient } from './llm-client.mjs';
import { WhisperClient } from './whisper-client.mjs';
import { OllamaClient } from './ollama-client.mjs';
import { PiperClient } from './piper-client.mjs';
import { MistralClient } from './mistral-client.mjs';
import { MistralSttClient } from './mistral-stt-client.mjs';
import { MistralTtsClient } from './mistral-tts-client.mjs';
import { OpenAiLlmClient } from './openai-llm-client.mjs';
import { OpenAiSttClient } from './openai-stt-client.mjs';
import { OpenAiTtsClient } from './openai-tts-client.mjs';
import { WyomingSttClient } from './wyoming-stt-client.mjs';
import { WyomingTtsClient } from './wyoming-tts-client.mjs';
import { LmStudioClient } from './lmstudio-client.mjs';
import { LOCAL_DEFAULT_PORTS } from '../local-pipeline-provider.mjs';

/**
 * Backend tester for the settings page's per-stage "Test" buttons.
 *
 * The settings webview cannot reach LAN services itself (mixed content /
 * CORS), so the page POSTs the CURRENT — possibly unsaved — form values to
 * the app's /test-local-stage endpoint and this module runs the test from
 * the Homey box: build the matching client, health-probe it, then make one
 * real mini-request (transcribe half a second of silence / ask the LLM to
 * reply "OK" / synthesize "OK"). The real request is the point: it surfaces
 * wrong model ids, rejected keys and bad voices, not just unreachable hosts.
 */

/** Flat request shape posted by the settings page. */
export interface StageTestRequest {
    stage: 'stt' | 'llm' | 'tts';
    backend: string;        // whisper|ollama|piper | mistral | openai
    host?: string;          // LAN backends
    port?: number | string;
    model?: string;         // model for the selected backend (LAN or cloud)
    mistralApiKey?: string; // mistral backends
    url?: string;           // openai-compatible backends
    key?: string;
    language?: string;      // stt: transcription language
    voice?: string;         // tts: the Voice dropdown value
    voiceOverride?: string; // tts openai: free-text voice
}

export interface StageTestResult {
    ok: boolean;
    message: string;
    latencyMs?: number;
}

// Bounded so a hung backend can't spin the settings page forever. Generous
// enough for a cold local model to answer one tiny prompt.
const TEST_TIMEOUT_MS = 30_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s`)), ms);
        work.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

const str = (v: unknown): string => String(v ?? '').trim();
const num = (v: unknown, fallback: number): number => Number(v) || fallback;

function buildSttClient(req: StageTestRequest): ISttClient {
    switch (req.backend) {
        case 'wyoming': return new WyomingSttClient({ host: str(req.host), port: num(req.port, LOCAL_DEFAULT_PORTS.wyomingStt) });
        case 'mistral': return new MistralSttClient({ apiKey: str(req.mistralApiKey), model: str(req.model) });
        case 'openai': return new OpenAiSttClient({ baseUrl: str(req.url), apiKey: str(req.key), model: str(req.model) });
        default: return new WhisperClient({ host: str(req.host), port: num(req.port, LOCAL_DEFAULT_PORTS.stt) });
    }
}

function buildLlmClient(req: StageTestRequest): ILlmClient {
    switch (req.backend) {
        case 'lmstudio': return new LmStudioClient({ host: str(req.host), port: num(req.port, LOCAL_DEFAULT_PORTS.lmstudio), model: str(req.model) });
        case 'mistral': return new MistralClient({ apiKey: str(req.mistralApiKey), model: str(req.model) });
        case 'openai': return new OpenAiLlmClient({ baseUrl: str(req.url), apiKey: str(req.key), model: str(req.model) });
        default: return new OllamaClient({ host: str(req.host), port: num(req.port, LOCAL_DEFAULT_PORTS.llm), model: str(req.model) });
    }
}

function buildTtsClient(req: StageTestRequest): ITtsClient {
    switch (req.backend) {
        case 'wyoming': return new WyomingTtsClient({ host: str(req.host), port: num(req.port, LOCAL_DEFAULT_PORTS.wyomingTts) });
        case 'mistral': return new MistralTtsClient({ apiKey: str(req.mistralApiKey), model: str(req.model), voice: str(req.voice) });
        case 'openai': return new OpenAiTtsClient({
            baseUrl: str(req.url), apiKey: str(req.key), model: str(req.model),
            voice: str(req.voice), voiceOverride: str(req.voiceOverride),
        });
        default: return new PiperClient({ host: str(req.host), port: num(req.port, LOCAL_DEFAULT_PORTS.tts) });
    }
}

async function runSttTest(req: StageTestRequest): Promise<string> {
    const client = buildSttClient(req);
    if (!client.hasCredentials()) throw new Error('API key missing — enter it above first');
    if (!client.isConfigured()) throw new Error('Fill in the connection fields above first');
    await client.check();
    // Half a second of silence: exercises upload, model load and response
    // parsing end-to-end. An empty transcript is the expected answer.
    const silence = Buffer.alloc(16000);
    const text = await client.transcribe(silence, str(req.language) || 'en');
    return text
        ? `Transcription works (heard "${text.slice(0, 60)}" in the silent test clip — that's a hallucination, harmless)`
        : 'Transcription works (test clip of silence came back empty, as expected)';
}

async function runLlmTest(req: StageTestRequest): Promise<string> {
    const client = buildLlmClient(req);
    if (!client.hasCredentials()) throw new Error('API key missing — enter it above first');
    if (!client.isConfigured()) throw new Error('Fill in the connection fields above first');
    await client.check();
    const { content } = await client.chat(
        [{ role: 'user', content: 'Reply with exactly: OK' }],
        [],
    );
    const reply = (content ?? '').trim();
    if (!reply) throw new Error('The model answered with empty text');
    return `Model responded: "${reply.slice(0, 60)}"`;
}

async function runTtsTest(req: StageTestRequest): Promise<string> {
    const client = buildTtsClient(req);
    if (!client.hasCredentials()) throw new Error('API key missing — enter it above first');
    if (!client.isConfigured()) throw new Error('Fill in the connection fields above first');
    await client.check();
    const { pcm, sampleRate } = await client.synthesize('OK');
    if (!pcm.length) throw new Error('The server returned no audio');
    const ms = Math.round((pcm.length / 2 / sampleRate) * 1000);
    return `Synthesized ${ms} ms of audio at ${sampleRate} Hz`;
}

/** Run the test for one stage. Never throws — errors come back as { ok:false }. */
export async function testLocalStage(req: StageTestRequest): Promise<StageTestResult> {
    const started = Date.now();
    try {
        let message: string;
        switch (req?.stage) {
            case 'stt': message = await withTimeout(runSttTest(req), TEST_TIMEOUT_MS); break;
            case 'llm': message = await withTimeout(runLlmTest(req), TEST_TIMEOUT_MS); break;
            case 'tts': message = await withTimeout(runTtsTest(req), TEST_TIMEOUT_MS); break;
            default: return { ok: false, message: `Unknown stage '${req?.stage}'` };
        }
        return { ok: true, message, latencyMs: Date.now() - started };
    } catch (err: any) {
        // fetch() wraps connection failures in an unhelpful "fetch failed" —
        // surface the underlying cause (ECONNREFUSED etc.) when present.
        const cause = err?.cause?.code || err?.cause?.message;
        const message = String(err?.message ?? err) + (cause ? ` (${cause})` : '');
        return { ok: false, message, latencyMs: Date.now() - started };
    }
}
