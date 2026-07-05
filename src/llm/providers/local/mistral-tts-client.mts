import { wavToPcm, toMonoPcm16 } from '../../../helpers/wav.mjs';
import { createLogger } from '../../../helpers/logger.mjs';
import { ITtsClient } from './tts-client.mjs';

/**
 * ITtsClient for Mistral's Voxtral TTS API.
 *
 * POST https://api.mistral.ai/v1/audio/speech — JSON { model, input, voice,
 * response_format:'wav' }, binary WAV back (24 kHz mono, which happens to be
 * the app's reply contract already — the provider's resample is a no-op).
 * Unlike Piper (voice fixed server-side), Voxtral picks a preset voice per
 * request, so the app's `selected_voice` setting flows through setVoice().
 */

export interface MistralTtsConfig {
    apiKey: string;
    /** Model id. Empty = DEFAULT_MISTRAL_TTS_MODEL. */
    model: string;
    /** Preset voice; anything unknown falls back to DEFAULT_MISTRAL_TTS_VOICE. */
    voice: string;
}

export const DEFAULT_MISTRAL_TTS_MODEL = 'voxtral-tts-latest';
export const DEFAULT_MISTRAL_TTS_VOICE = 'neutral_female';

/** Voxtral's 20 built-in preset voices (offered in the settings voice dropdown). */
export const VOXTRAL_TTS_VOICES: { value: string; name: string }[] = [
    { value: 'neutral_female', name: 'Neutral female (English)' },
    { value: 'neutral_male', name: 'Neutral male (English)' },
    { value: 'casual_female', name: 'Casual female (English)' },
    { value: 'casual_male', name: 'Casual male (English)' },
    { value: 'cheerful_female', name: 'Cheerful female (English)' },
    { value: 'fr_female', name: 'French female' },
    { value: 'fr_male', name: 'French male' },
    { value: 'de_female', name: 'German female' },
    { value: 'de_male', name: 'German male' },
    { value: 'es_female', name: 'Spanish female' },
    { value: 'es_male', name: 'Spanish male' },
    { value: 'pt_female', name: 'Portuguese female' },
    { value: 'pt_male', name: 'Portuguese male' },
    { value: 'it_female', name: 'Italian female' },
    { value: 'it_male', name: 'Italian male' },
    { value: 'nl_female', name: 'Dutch female' },
    { value: 'nl_male', name: 'Dutch male' },
    { value: 'ar_male', name: 'Arabic male' },
    { value: 'hi_female', name: 'Hindi female' },
    { value: 'hi_male', name: 'Hindi male' },
];

// OpenAI-style aliases Voxtral also accepts (the app may still hold one in
// `selected_voice` from a previous OpenAI-provider configuration).
const VOXTRAL_VOICE_ALIASES = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
const VOXTRAL_VOICE_IDS = new Set(VOXTRAL_TTS_VOICES.map((v) => v.value));

/** Resolve the configured voice to something Voxtral accepts. */
export function voxtralVoiceName(voice: string | undefined | null): string {
    if (!voice) return DEFAULT_MISTRAL_TTS_VOICE;
    if (VOXTRAL_VOICE_IDS.has(voice) || VOXTRAL_VOICE_ALIASES.has(voice)) return voice;
    return DEFAULT_MISTRAL_TTS_VOICE;
}

const MISTRAL_BASE_URL = 'https://api.mistral.ai';
const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

export class MistralTtsClient implements ITtsClient {
    private config: MistralTtsConfig;
    private logger = createLogger('MISTRAL_TTS', true);

    constructor(config: MistralTtsConfig) {
        this.config = { ...config };
    }

    configure(config: MistralTtsConfig): void {
        this.config = { ...config };
    }

    private get model(): string {
        return this.config.model || DEFAULT_MISTRAL_TTS_MODEL;
    }

    describe(): string {
        return `mistral-tts=${this.model}`;
    }

    isConfigured(): boolean {
        return !!this.config.apiKey;
    }

    hasCredentials(): boolean {
        return !!this.config.apiKey;
    }

    setVoice(voice: string): void {
        this.config.voice = voice;
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

    async synthesize(text: string, signal?: AbortSignal): Promise<{ pcm: Buffer; sampleRate: number }> {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const res = await fetch(`${MISTRAL_BASE_URL}/v1/audio/speech`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                input: text,
                voice: voxtralVoiceName(this.config.voice),
                response_format: 'wav',
            }),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Mistral /v1/audio/speech returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }

        const wav = Buffer.from(await res.arrayBuffer());
        const { pcm, sampleRate, channels } = wavToPcm(wav);
        return { pcm: toMonoPcm16(pcm, channels), sampleRate };
    }
}
