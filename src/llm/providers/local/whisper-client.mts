import { pcmToWav } from '../../../helpers/wav.mjs';
import { createLogger } from '../../../helpers/logger.mjs';
import { ISttClient } from './stt-client.mjs';

/**
 * ISttClient for a locally hosted Whisper STT server.
 *
 * "Whisper in Docker" is not one API, so the client auto-detects among the
 * three common server flavors (first successful call wins, then cached):
 *   - 'openai'     POST /v1/audio/transcriptions  (speaches / faster-whisper-server / LocalAI)
 *   - 'asr'        POST /asr?output=json          (onerahmet/openai-whisper-asr-webservice, port 9000)
 *   - 'whispercpp' POST /inference                (whisper.cpp server)
 * All take a multipart WAV upload and return the transcript (JSON {text} or
 * plain text). No authentication (first round).
 */

export type WhisperEndpointStyle = 'openai' | 'asr' | 'whispercpp';

export interface LocalSttConfig {
    host: string;
    port: number;
}

const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;

export class WhisperClient implements ISttClient {
    private config: LocalSttConfig;
    private style: WhisperEndpointStyle | null = null;
    private logger = createLogger('WHISPER', true);

    constructor(config: LocalSttConfig) {
        this.config = { ...config };
    }

    configure(config: LocalSttConfig): void {
        if (config.host !== this.config.host || config.port !== this.config.port) {
            this.style = null; // a different server may speak a different flavor
        }
        this.config = { ...config };
    }

    get baseUrl(): string {
        return `http://${this.config.host}:${this.config.port}`;
    }

    describe(): string {
        return `whisper=${this.baseUrl}`;
    }

    isConfigured(): boolean {
        return !!this.config.host && !!this.config.port;
    }

    /** A LAN Whisper server needs no credentials. */
    hasCredentials(): boolean {
        return true;
    }

    /** Reachability probe — any HTTP answer (even 404) means the server is up. */
    async check(): Promise<void> {
        await fetch(this.baseUrl + '/', { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    }

    /**
     * Transcribe PCM16 mono 16 kHz mic audio. Returns the transcript text
     * (may be empty when Whisper heard nothing intelligible).
     */
    async transcribe(pcm16k: Buffer, languageCode: string): Promise<string> {
        const wav = pcmToWav(pcm16k, 16000, 1);
        const styles: WhisperEndpointStyle[] = this.style
            ? [this.style]
            : ['asr', 'openai', 'whispercpp'];

        let lastError: Error | null = null;
        for (const style of styles) {
            try {
                const text = await this.transcribeWith(style, wav, languageCode);
                if (this.style !== style) {
                    this.logger.info(`Detected Whisper endpoint style '${style}' at ${this.baseUrl}`);
                    this.style = style;
                }
                return text;
            } catch (err: any) {
                lastError = err instanceof Error ? err : new Error(String(err));
                // Only keep probing other flavors on route-shaped errors; a
                // network failure will fail them all identically.
                if (!this.style && this.isRouteError(err)) continue;
                throw lastError;
            }
        }
        throw lastError ?? new Error('No Whisper endpoint style worked');
    }

    private async transcribeWith(style: WhisperEndpointStyle, wav: Buffer, languageCode: string): Promise<string> {
        const blob = new Blob([new Uint8Array(wav)], { type: 'audio/wav' });
        const form = new FormData();
        let url: string;

        switch (style) {
            case 'asr': {
                const params = new URLSearchParams({
                    task: 'transcribe',
                    output: 'json',
                    encode: 'false', // already WAV — skip the server's ffmpeg pass
                });
                if (languageCode) params.set('language', languageCode);
                url = `${this.baseUrl}/asr?${params.toString()}`;
                form.append('audio_file', blob, 'audio.wav');
                break;
            }
            case 'openai': {
                url = `${this.baseUrl}/v1/audio/transcriptions`;
                form.append('file', blob, 'audio.wav');
                if (languageCode) form.append('language', languageCode);
                form.append('response_format', 'json');
                break;
            }
            case 'whispercpp': {
                url = `${this.baseUrl}/inference`;
                form.append('file', blob, 'audio.wav');
                form.append('response_format', 'json');
                if (languageCode) form.append('language', languageCode);
                break;
            }
        }

        const res = await fetch(url, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
            const err: any = new Error(`Whisper ${style} endpoint returned HTTP ${res.status}`);
            err.status = res.status;
            throw err;
        }

        const raw = (await res.text()).trim();
        try {
            const json = JSON.parse(raw);
            return String(json?.text ?? '').trim();
        } catch {
            return raw; // some servers answer text/plain
        }
    }

    /** 404/405/422 style errors: the flavor doesn't exist on this server. */
    private isRouteError(err: any): boolean {
        const status = err?.status;
        return status === 404 || status === 405 || status === 422 || status === 400;
    }
}
