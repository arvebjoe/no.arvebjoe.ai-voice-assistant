import { wavToPcm, toMonoPcm16 } from '../../../helpers/wav.mjs';
import { createLogger } from '../../../helpers/logger.mjs';
import { ITtsClient } from './tts-client.mjs';
import { normalizeOpenAiBaseUrl, openAiAuthHeaders, checkOpenAiCompatServer, isOpenAiTtsVoice } from './openai-compat.mjs';

/**
 * ITtsClient for any OpenAI-compatible speech server.
 *
 * POST {base}/audio/speech — JSON { model, input, voice,
 * response_format:'wav' }, binary WAV back (rate read from the header).
 * Point it at OpenAI itself (model gpt-4o-mini-tts / tts-1) or a LAN server
 * like kokoro-fastapi. Voice resolution: the free-text `voiceOverride`
 * setting wins verbatim (for custom servers whose voices aren't OpenAI's,
 * e.g. Kokoro's 'af_heart'); otherwise the app's `selected_voice` is used if
 * it is a standard OpenAI voice, else 'alloy'.
 */

export interface OpenAiTtsConfig {
    baseUrl: string;
    /** Optional — LAN servers usually need none. */
    apiKey: string;
    /** Model id — required by cloud services (e.g. 'gpt-4o-mini-tts', 'kokoro'). */
    model: string;
    /** The app's selected_voice (from the Voice dropdown). */
    voice: string;
    /** Free-text override for custom servers; wins over `voice` when set. */
    voiceOverride: string;
}

const DEFAULT_OPENAI_TTS_VOICE = 'alloy';
const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

export class OpenAiTtsClient implements ITtsClient {
    private config: OpenAiTtsConfig;
    private logger = createLogger('OPENAI_TTS', true);

    constructor(config: OpenAiTtsConfig) {
        this.config = { ...config };
    }

    configure(config: OpenAiTtsConfig): void {
        this.config = { ...config };
    }

    private get baseUrl(): string {
        return normalizeOpenAiBaseUrl(this.config.baseUrl);
    }

    describe(): string {
        return `openai-tts=${this.config.model || 'server-default'}@${this.baseUrl}`;
    }

    isConfigured(): boolean {
        return !!this.config.baseUrl;
    }

    /** The key is optional here — a keyed server rejecting us surfaces via check(). */
    hasCredentials(): boolean {
        return true;
    }

    setVoice(voice: string): void {
        this.config.voice = voice;
    }

    /** Override verbatim > standard OpenAI voice from the dropdown > 'alloy'. */
    private voiceName(): string {
        if (this.config.voiceOverride) return this.config.voiceOverride;
        if (isOpenAiTtsVoice(this.config.voice)) return this.config.voice;
        return DEFAULT_OPENAI_TTS_VOICE;
    }

    async check(): Promise<void> {
        await checkOpenAiCompatServer(this.baseUrl, this.config.apiKey, PROBE_TIMEOUT_MS);
    }

    async synthesize(text: string, signal?: AbortSignal): Promise<{ pcm: Buffer; sampleRate: number }> {
        const body: any = {
            input: text,
            voice: this.voiceName(),
            response_format: 'wav',
        };
        if (this.config.model) body.model = this.config.model;

        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const res = await fetch(`${this.baseUrl}/audio/speech`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...openAiAuthHeaders(this.config.apiKey),
            },
            body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`${this.baseUrl}/audio/speech returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }

        const wav = Buffer.from(await res.arrayBuffer());
        const { pcm, sampleRate, channels } = wavToPcm(wav);
        return { pcm: toMonoPcm16(pcm, channels), sampleRate };
    }
}
