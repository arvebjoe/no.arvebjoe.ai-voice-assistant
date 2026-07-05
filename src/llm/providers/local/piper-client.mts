import { wavToPcm, toMonoPcm16 } from '../../../helpers/wav.mjs';
import { createLogger } from '../../../helpers/logger.mjs';

/**
 * HTTP client for a locally hosted Piper TTS server (default port 5000).
 *
 * Two request shapes cover the common deployments (auto-detected, cached):
 *   - POST /synthesize {text}   (OHF-Voice piper1-gpl `python -m piper.http_server`)
 *   - POST /          {text}    (older piper http_server, artibex/piper-http,
 *                                waveoffire/piper-tts-server, wyoming-piper's web UI port)
 * Both return a WAV whose sample rate depends on the voice model (16000 for
 * *-low, 22050 for *-medium/high) — the caller gets raw PCM16 mono plus that
 * rate and resamples to the app contract itself. The voice is whatever the
 * server was started with; no per-request voice selection in this round.
 */

export interface LocalTtsConfig {
    host: string;
    port: number;
}

const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;

type PiperRoute = '/synthesize' | '/';

export class PiperClient {
    private config: LocalTtsConfig;
    private route: PiperRoute | null = null;
    private logger = createLogger('PIPER', true);

    constructor(config: LocalTtsConfig) {
        this.config = { ...config };
    }

    configure(config: LocalTtsConfig): void {
        if (config.host !== this.config.host || config.port !== this.config.port) {
            this.route = null;
        }
        this.config = { ...config };
    }

    get baseUrl(): string {
        return `http://${this.config.host}:${this.config.port}`;
    }

    isConfigured(): boolean {
        return !!this.config.host && !!this.config.port;
    }

    /** Reachability probe — any HTTP answer (even 404) means the server is up. */
    async check(): Promise<void> {
        await fetch(this.baseUrl + '/', { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    }

    /** Synthesize text to PCM16 mono at the voice model's native sample rate. */
    async synthesize(text: string, signal?: AbortSignal): Promise<{ pcm: Buffer; sampleRate: number }> {
        const routes: PiperRoute[] = this.route ? [this.route] : ['/synthesize', '/'];

        let lastError: Error | null = null;
        for (const route of routes) {
            try {
                const result = await this.synthesizeVia(route, text, signal);
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

    private async synthesizeVia(route: PiperRoute, text: string, signal?: AbortSignal): Promise<{ pcm: Buffer; sampleRate: number }> {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const res = await fetch(this.baseUrl + route, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
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
