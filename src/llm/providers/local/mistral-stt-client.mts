import { pcmToWav } from '../../../helpers/wav.mjs';
import { createLogger } from '../../../helpers/logger.mjs';
import { ISttClient } from './stt-client.mjs';

/**
 * ISttClient for Mistral's Voxtral transcription API.
 *
 * POST https://api.mistral.ai/v1/audio/transcriptions — multipart upload
 * (file + model + optional language), JSON { text } back. The docs' curl
 * authenticates with an `x-api-key` header; the standard `Authorization:
 * Bearer` also works across the Mistral API, so both are sent.
 */

export interface MistralSttConfig {
    apiKey: string;
    /** Model id. Empty = DEFAULT_MISTRAL_STT_MODEL. */
    model: string;
}

export const DEFAULT_MISTRAL_STT_MODEL = 'voxtral-mini-latest';
const MISTRAL_BASE_URL = 'https://api.mistral.ai';
const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

export class MistralSttClient implements ISttClient {
    private config: MistralSttConfig;
    private logger = createLogger('MISTRAL_STT', true);

    constructor(config: MistralSttConfig) {
        this.config = { ...config };
    }

    configure(config: MistralSttConfig): void {
        this.config = { ...config };
    }

    private get model(): string {
        return this.config.model || DEFAULT_MISTRAL_STT_MODEL;
    }

    private authHeaders(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.config.apiKey}`,
            'x-api-key': this.config.apiKey,
        };
    }

    describe(): string {
        return `mistral-stt=${this.model}`;
    }

    isConfigured(): boolean {
        return !!this.config.apiKey;
    }

    hasCredentials(): boolean {
        return !!this.config.apiKey;
    }

    /** Health probe that also validates the key (401 on a bad one). */
    async check(): Promise<void> {
        const res = await fetch(`${MISTRAL_BASE_URL}/v1/models`, {
            headers: { Authorization: `Bearer ${this.config.apiKey}` },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401) throw new Error('Mistral API key was rejected (401) — check it in the app settings');
        if (!res.ok) throw new Error(`Mistral /v1/models returned HTTP ${res.status}`);
    }

    async transcribe(pcm16k: Buffer, languageCode: string): Promise<string> {
        const wav = pcmToWav(pcm16k, 16000, 1);
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
        form.append('model', this.model);
        if (languageCode) form.append('language', languageCode);

        const res = await fetch(`${MISTRAL_BASE_URL}/v1/audio/transcriptions`, {
            method: 'POST',
            headers: this.authHeaders(),
            body: form,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Mistral /v1/audio/transcriptions returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }

        const json: any = await res.json();
        return String(json?.text ?? '').trim();
    }
}
