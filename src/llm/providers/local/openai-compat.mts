/**
 * Shared bits for the generic "OpenAI-compatible" pipeline backends.
 *
 * Nearly the whole ecosystem speaks OpenAI's API dialect these days — Groq,
 * OpenRouter, DeepSeek, Together (cloud); LM Studio, llama.cpp, vLLM,
 * LocalAI (local LLMs); speaches (STT); kokoro-fastapi (TTS); and OpenAI
 * itself — so one configurable backend per stage covers all of them. Each
 * stage gets its own base URL / API key / model settings, since STT, LLM and
 * TTS may well point at different servers.
 */

/**
 * Normalize a user-entered base URL:
 *   - trims and strips trailing slashes
 *   - defaults a bare host to http:// (LAN servers) — full URLs keep their scheme
 *   - appends `/v1` when no path was given, since every known server roots the
 *     API there (OpenAI api.openai.com/v1, LM Studio localhost:1234/v1, …).
 *     A URL that already has a path (e.g. Groq's /openai/v1) is kept verbatim.
 */
export function normalizeOpenAiBaseUrl(raw: string): string {
    let url = (raw ?? '').trim().replace(/\/+$/, '');
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    try {
        const parsed = new URL(url);
        if (parsed.pathname === '' || parsed.pathname === '/') {
            url = `${url}/v1`;
        }
    } catch {
        // Leave malformed input as-is; the request will fail with a clear error.
    }
    return url;
}

/** Authorization header when a key is configured (many local servers need none). */
export function openAiAuthHeaders(apiKey: string): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Reachability probe for an OpenAI-compatible server: GET {base}/models.
 * 401/403 mean "server is there but the key is wrong/missing" — thrown with a
 * key-shaped message. A 404 is tolerated (some minimal servers skip /models);
 * only an unreachable server rejects otherwise.
 */
export async function checkOpenAiCompatServer(baseUrl: string, apiKey: string, timeoutMs: number): Promise<void> {
    const res = await fetch(`${baseUrl}/models`, {
        headers: openAiAuthHeaders(apiKey),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
        throw new Error(`${baseUrl} rejected the API key (HTTP ${res.status}) — check it in the app settings`);
    }
}

/**
 * OpenAI's standard TTS voices (tts-1 / gpt-4o-mini-tts), offered in the main
 * Voice dropdown when the TTS backend is 'openai'. Custom servers (Kokoro etc.)
 * use the free-text voice override instead.
 */
export const OPENAI_TTS_VOICES: { value: string; name: string }[] = [
    { value: 'alloy', name: 'Alloy' },
    { value: 'ash', name: 'Ash' },
    { value: 'ballad', name: 'Ballad' },
    { value: 'coral', name: 'Coral' },
    { value: 'echo', name: 'Echo' },
    { value: 'fable', name: 'Fable' },
    { value: 'nova', name: 'Nova' },
    { value: 'onyx', name: 'Onyx' },
    { value: 'sage', name: 'Sage' },
    { value: 'shimmer', name: 'Shimmer' },
    { value: 'verse', name: 'Verse' },
];

const OPENAI_TTS_VOICE_IDS = new Set(OPENAI_TTS_VOICES.map((v) => v.value));

/** True when the app's `selected_voice` is a standard OpenAI TTS voice. */
export function isOpenAiTtsVoice(voice: string | undefined | null): boolean {
    return !!voice && OPENAI_TTS_VOICE_IDS.has(voice);
}
