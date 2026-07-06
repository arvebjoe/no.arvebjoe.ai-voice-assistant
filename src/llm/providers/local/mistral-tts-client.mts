import { wavToPcm, toMonoPcm16 } from '../../../helpers/wav.mjs';
import { createLogger } from '../../../helpers/logger.mjs';
import { ITtsClient } from './tts-client.mjs';

/**
 * ITtsClient for Mistral's Voxtral TTS API.
 *
 * POST https://api.mistral.ai/v1/audio/speech — JSON { model, input, voice_id,
 * response_format:'wav' }, binary WAV back (24 kHz mono, which happens to be
 * the app's reply contract already — the provider's resample is a no-op).
 * Two things learned against the LIVE server 2026-07-06 (the OpenAPI spec is
 * looser on both): `model` is required (422 "No model provided for speech"
 * without one), and `voice_id` must identify a voice from the account's
 * GET /v1/audio/voices library — the hosted platform serves its own preset
 * voices (30 at the time of writing, UUID ids + slugs like `en_paul_neutral`)
 * and rejects the open-weights model card's preset names (`neutral_female`
 * etc., 404 "Voice not found"). The settings voice dropdown is therefore
 * populated live from /v1/audio/voices (see listMistralTtsVoices); a
 * `selected_voice` that is not from that list (legacy OpenAI/Gemini names)
 * resolves to a neutral-sounding voice at synthesis time. Unlike Piper (voice
 * fixed server-side), Voxtral picks a voice per request, so `selected_voice`
 * flows through setVoice().
 */

export interface MistralTtsConfig {
    apiKey: string;
    /** Model id. Empty = DEFAULT_MISTRAL_TTS_MODEL (the API rejects requests without one). */
    model: string;
    /** Voice UUID (or slug) from /v1/audio/voices; anything else resolves to a live default. */
    voice: string;
}

export const DEFAULT_MISTRAL_TTS_MODEL = 'voxtral-mini-tts-2603';

/** One voice from GET /v1/audio/voices (presets and account customs alike). */
export interface MistralVoice {
    id: string;
    name: string;
    slug: string;
    languages: string[];
}

const MISTRAL_BASE_URL = 'https://api.mistral.ai';
const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const VOICES_PAGE_LIMIT = 100;
const VOICES_CACHE_TTL_MS = 5 * 60_000;

// The platform serves the same voice library to every client instance
// (settings dropdown, running provider, stage tester) — cache it per API key.
const voicesCache = new Map<string, { voices: MistralVoice[]; at: number }>();

/** All voices the account can use, across pagination. Cached briefly per key. */
export async function listMistralTtsVoices(apiKey: string): Promise<MistralVoice[]> {
    const cached = voicesCache.get(apiKey);
    if (cached && Date.now() - cached.at < VOICES_CACHE_TTL_MS) return cached.voices;

    const voices: MistralVoice[] = [];
    for (let offset = 0, total = Infinity; offset < total && offset < 1000;) {
        const res = await fetch(`${MISTRAL_BASE_URL}/v1/audio/voices?limit=${VOICES_PAGE_LIMIT}&offset=${offset}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401) throw new Error('Mistral API key was rejected (401) — check it in the app settings');
        if (!res.ok) throw new Error(`Mistral /v1/audio/voices returned HTTP ${res.status}`);
        const data: any = await res.json();
        const items: any[] = Array.isArray(data?.items) ? data.items : [];
        if (!items.length) break;
        for (const v of items) {
            if (!v?.id) continue;
            voices.push({
                id: String(v.id),
                name: String(v.name || v.slug || v.id),
                slug: String(v.slug || ''),
                languages: Array.isArray(v.languages) ? v.languages.map(String) : [],
            });
        }
        offset += items.length;
        total = Number(data?.total) || voices.length;
    }
    voicesCache.set(apiKey, { voices, at: Date.now() });
    return voices;
}

/** Voice-dropdown entries for the settings page: value = the voice's UUID. */
export function mistralVoiceOptions(voices: MistralVoice[]): { value: string; name: string }[] {
    return voices.map((v) => ({
        value: v.id,
        name: v.languages.length ? `${v.name} (${v.languages.map(prettyLanguage).join(', ')})` : v.name,
    }));
}

function prettyLanguage(code: string): string {
    return code.replace(/_/g, '-').toUpperCase();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MistralTtsClient implements ITtsClient {
    private config: MistralTtsConfig;
    private resolvedVoiceId: string | null = null;
    private logger = createLogger('MISTRAL_TTS', true);

    constructor(config: MistralTtsConfig) {
        this.config = { ...config };
    }

    configure(config: MistralTtsConfig): void {
        this.config = { ...config };
        this.resolvedVoiceId = null;
    }

    describe(): string {
        return `mistral-tts=${this.config.model || DEFAULT_MISTRAL_TTS_MODEL}`;
    }

    isConfigured(): boolean {
        return !!this.config.apiKey;
    }

    hasCredentials(): boolean {
        return !!this.config.apiKey;
    }

    setVoice(voice: string): void {
        if (voice !== this.config.voice) this.resolvedVoiceId = null;
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

    /**
     * The voice_id to send: a UUID from the dropdown passes straight through
     * (no extra request); anything else — empty, a slug, or a leftover
     * OpenAI/Gemini name — is resolved against the live voice list once and
     * cached until the voice changes.
     */
    private async resolveVoiceId(): Promise<string> {
        const v = (this.config.voice || '').trim();
        if (UUID_RE.test(v)) return v;
        if (this.resolvedVoiceId) return this.resolvedVoiceId;

        const voices = await listMistralTtsVoices(this.config.apiKey);
        if (!voices.length) throw new Error('Mistral returned no TTS voices — pick a voice in the app settings');
        const match = voices.find((x) => x.slug === v)
            ?? voices.find((x) => /neutral/i.test(x.slug) || /neutral/i.test(x.name))
            ?? voices[0];
        if (v && match.slug !== v) {
            this.logger.warn(`Voice '${v}' is not in the Voxtral voice library — using '${match.name}' instead`);
        }
        this.resolvedVoiceId = match.id;
        return match.id;
    }

    async synthesize(text: string, signal?: AbortSignal): Promise<{ pcm: Buffer; sampleRate: number }> {
        const body = {
            model: this.config.model || DEFAULT_MISTRAL_TTS_MODEL,
            input: text,
            voice_id: await this.resolveVoiceId(),
            response_format: 'wav',
        };

        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const res = await fetch(`${MISTRAL_BASE_URL}/v1/audio/speech`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Mistral /v1/audio/speech returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }

        let wav = Buffer.from(await res.arrayBuffer());
        if (wav.length >= 4 && wav.toString('ascii', 0, 4) !== 'RIFF') {
            // Mistral's docs show both raw binary and a JSON envelope with
            // base64 audio_data — unwrap the latter if that's what arrived.
            try {
                const parsed = JSON.parse(wav.toString('utf8'));
                if (parsed?.audio_data) wav = Buffer.from(parsed.audio_data, 'base64');
            } catch { /* not JSON — let wavToPcm report the real problem */ }
        }
        const { pcm, sampleRate, channels } = wavToPcm(wav);
        return { pcm: toMonoPcm16(pcm, channels), sampleRate };
    }
}
