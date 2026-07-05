import { pcmToWav } from '../../../helpers/wav.mjs';
import { createLogger } from '../../../helpers/logger.mjs';
import { ISttClient } from './stt-client.mjs';
import { normalizeOpenAiBaseUrl, openAiAuthHeaders, checkOpenAiCompatServer } from './openai-compat.mjs';

/**
 * ISttClient for any OpenAI-compatible transcription server.
 *
 * POST {base}/audio/transcriptions — multipart WAV upload, JSON { text }
 * back. Point it at OpenAI itself (model gpt-4o-transcribe / whisper-1),
 * Groq (whisper-large-v3-turbo at https://api.groq.com/openai/v1), or a LAN
 * server like speaches. Differs from WhisperClient's 'openai' flavor in that
 * the URL is free-form (not host:port), a Bearer key is supported, and the
 * model field is configurable (cloud services require it).
 */

export interface OpenAiSttConfig {
    baseUrl: string;
    /** Optional — LAN servers usually need none. */
    apiKey: string;
    /** Model id — required by cloud services, often optional on LAN servers. */
    model: string;
}

const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

export class OpenAiSttClient implements ISttClient {
    private config: OpenAiSttConfig;
    private logger = createLogger('OPENAI_STT', true);

    constructor(config: OpenAiSttConfig) {
        this.config = { ...config };
    }

    configure(config: OpenAiSttConfig): void {
        this.config = { ...config };
    }

    private get baseUrl(): string {
        return normalizeOpenAiBaseUrl(this.config.baseUrl);
    }

    describe(): string {
        return `openai-stt=${this.config.model || 'server-default'}@${this.baseUrl}`;
    }

    isConfigured(): boolean {
        return !!this.config.baseUrl;
    }

    /** The key is optional here — a keyed server rejecting us surfaces via check(). */
    hasCredentials(): boolean {
        return true;
    }

    async check(): Promise<void> {
        await checkOpenAiCompatServer(this.baseUrl, this.config.apiKey, PROBE_TIMEOUT_MS);
    }

    async transcribe(pcm16k: Buffer, languageCode: string): Promise<string> {
        const wav = pcmToWav(pcm16k, 16000, 1);
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
        if (this.config.model) form.append('model', this.config.model);
        if (languageCode) form.append('language', languageCode);
        form.append('response_format', 'json');

        const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: openAiAuthHeaders(this.config.apiKey),
            body: form,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`${this.baseUrl}/audio/transcriptions returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }

        const raw = (await res.text()).trim();
        try {
            const json = JSON.parse(raw);
            return String(json?.text ?? '').trim();
        } catch {
            return raw; // some servers answer text/plain
        }
    }
}
