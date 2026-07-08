import { wavToPcm, toMonoPcm16 } from '../../../helpers/wav.mjs';
import { createLogger } from '../../../helpers/logger.mjs';
import { ITtsClient } from './tts-client.mjs';

/**
 * ITtsClient for a locally hosted Piper TTS server (default port 5000).
 *
 * Two request shapes cover the common deployments (auto-detected, cached):
 *   - POST /synthesize {text, voice?}  (OHF-Voice piper1-gpl `python -m piper.http_server`)
 *   - POST /           {text}          (older piper http_server, artibex/piper-http,
 *                                       waveoffire/piper-tts-server, wyoming-piper's web UI port)
 * Both return a WAV whose sample rate depends on the voice model (16000 for
 * *-low, 22050 for *-medium/high) — the caller gets raw PCM16 mono plus that
 * rate and resamples to the app contract itself.
 *
 * Per-request voice selection (piper1-gpl only): the server's installed voices
 * come from `GET /voices` (a dict keyed by voice id, e.g. "no_NO-talesyntese-medium").
 * The app's shared `selected_voice` setting may hold another backend's voice
 * (an OpenAI name, a Voxtral UUID) after a backend switch, so a voice is only
 * sent when the server's own list confirms it — anything else falls back to
 * the server default, matching the pre-voice-selection behavior.
 */

export interface LocalTtsConfig {
    host: string;
    port: number;
    /** Preferred voice id ('' / 'server-default' = the server's own default). */
    voice?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;

/** Sentinel stored while a Piper server exposes no voice list. */
export const PIPER_SERVER_DEFAULT_VOICE = 'server-default';

/**
 * List the voice ids installed on a Piper server (piper1-gpl `GET /voices`).
 * Throws when the server is unreachable or predates the endpoint — callers
 * fall back to the single server-default entry.
 */
export async function listPiperVoices(host: string, port: number): Promise<string[]> {
    const res = await fetch(`http://${host}:${port}/voices`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Piper /voices returned HTTP ${res.status}`);
    const voices = await res.json();
    if (!voices || typeof voices !== 'object' || Array.isArray(voices)) {
        throw new Error('Piper /voices returned an unexpected shape');
    }
    return Object.keys(voices).sort();
}

type PiperRoute = '/synthesize' | '/';

export class PiperClient implements ITtsClient {
    private config: LocalTtsConfig;
    private route: PiperRoute | null = null;
    private voice = '';
    // Voice ids confirmed installed on this server; null until fetched (or
    // unfetchable — older servers have no /voices, then no voice is ever sent).
    private knownVoices: Set<string> | null = null;
    private logger = createLogger('PIPER', true);

    constructor(config: LocalTtsConfig) {
        this.config = { ...config };
        this.setVoice(config.voice ?? '');
    }

    configure(config: LocalTtsConfig): void {
        if (config.host !== this.config.host || config.port !== this.config.port) {
            this.route = null;
            this.knownVoices = null;
        }
        this.config = { ...config };
        if (config.voice !== undefined) this.setVoice(config.voice);
    }

    /** Apply the app's `selected_voice`. Sentinels mean "server default". */
    setVoice(voice: string): void {
        this.voice = voice === PIPER_SERVER_DEFAULT_VOICE ? '' : (voice ?? '');
    }

    get baseUrl(): string {
        return `http://${this.config.host}:${this.config.port}`;
    }

    describe(): string {
        return `piper=${this.baseUrl}`;
    }

    isConfigured(): boolean {
        return !!this.config.host && !!this.config.port;
    }

    /** A LAN Piper server needs no credentials. */
    hasCredentials(): boolean {
        return true;
    }

    /** Reachability probe — any HTTP answer (even 404) means the server is up. */
    async check(): Promise<void> {
        await fetch(this.baseUrl + '/', { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    }

    /**
     * The voice to send with a request: only one the server itself lists.
     * The list is fetched once and cached; a server without /voices (or a
     * fetch error) disables voice selection rather than risking a 4xx on
     * every synthesis.
     */
    private async resolveVoice(): Promise<string> {
        if (!this.voice) return '';
        if (this.knownVoices === null) {
            try {
                this.knownVoices = new Set(await listPiperVoices(this.config.host, this.config.port));
            } catch {
                this.knownVoices = new Set();
            }
        }
        if (this.knownVoices.has(this.voice)) return this.voice;
        if (this.knownVoices.size > 0) {
            this.logger.warn(`Voice '${this.voice}' not installed on ${this.baseUrl} — using the server default`);
        }
        return '';
    }

    /** Synthesize text to PCM16 mono at the voice model's native sample rate. */
    async synthesize(text: string, signal?: AbortSignal): Promise<{ pcm: Buffer; sampleRate: number }> {
        const routes: PiperRoute[] = this.route ? [this.route] : ['/synthesize', '/'];
        const voice = await this.resolveVoice();

        let lastError: Error | null = null;
        for (const route of routes) {
            try {
                const result = await this.synthesizeVia(route, text, voice, signal);
                if (this.route !== route) {
                    this.logger.info(`Detected Piper endpoint '${route}' at ${this.baseUrl}`);
                    this.route = route;
                }
                return result;
            } catch (err: any) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (!this.route && (err?.status === 404 || err?.status === 405)) continue;
                throw lastError;
            }
        }
        throw lastError ?? new Error('No Piper endpoint worked');
    }

    private async synthesizeVia(route: PiperRoute, text: string, voice: string, signal?: AbortSignal): Promise<{ pcm: Buffer; sampleRate: number }> {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const res = await fetch(this.baseUrl + route, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, ...(voice ? { voice } : {}) }),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!res.ok) {
            const err: any = new Error(`Piper ${route} returned HTTP ${res.status}`);
            err.status = res.status;
            throw err;
        }

        const wav = Buffer.from(await res.arrayBuffer());
        const { pcm, sampleRate, channels } = wavToPcm(wav);
        return { pcm: toMonoPcm16(pcm, channels), sampleRate };
    }
}
