/**
 * Gemini model selection: the built-in defaults, the user's per-role override
 * settings, the live model list for the settings page, and the automatic
 * fallback when Google retires a model.
 *
 * Why this exists: Google turns models off for "new users" with no notice to
 * the app (Nov 2026: `gemini-2.5-flash` started answering generateContent with
 * 404 "no longer available to new users"), which silently broke every
 * Gemini text ask. Hardcoded ids alone are therefore not enough - the user can
 * pick a model in settings, and a 404 on the configured one makes the provider
 * pick the best listed replacement by itself instead of failing every call.
 *
 * Only "flash" models are offered: they are the low-latency tier a voice
 * assistant wants, and the full list (pro, embeddings, image, video, robotics,
 * dated snapshots of all of them) is far too long for a dropdown.
 */

/** The three places the Gemini provider uses a model. */
export type GeminiModelRole = "live" | "text" | "tts";

export const GEMINI_MODEL_ROLES: readonly GeminiModelRole[] = ["live", "text", "tts"];

/** Used when the role's setting is empty. Keep these on current GA/preview ids. */
export const GEMINI_DEFAULT_MODELS: Record<GeminiModelRole, string> = {
    live: "gemini-3.1-flash-live-preview", // realtime audio session (bidiGenerateContent)
    text: "gemini-3.8-flash",              // one-shot text Q&A (ask-as-text)
    tts: "gemini-3.8-flash-tts",           // direct TTS (speak-text)
};

/** Global setting holding each role's override ("" = the default above). */
export const GEMINI_MODEL_SETTINGS: Record<GeminiModelRole, string> = {
    live: "gemini_live_model",
    text: "gemini_text_model",
    tts: "gemini_tts_model",
};

export interface GeminiModelOption {
    value: string;
    name: string;
}

export type GeminiModelOptions = Record<GeminiModelRole, GeminiModelOption[]>;

/** One entry of `GET /v1beta/models`, the fields we read. */
interface RawGeminiModel {
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
}

const LIST_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const LIST_TIMEOUT_MS = 8000;
const MAX_PAGES = 10; // safety stop; one page of 1000 holds the whole catalog today

// The settings page re-asks on every settled key edit - cache per key, like
// the Claude model list does.
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; models: GeminiModelOptions }>();

/** Test hook: forget cached lists. */
export function __clearGeminiModelCache(): void {
    cache.clear();
}

// Families that share the "flash" name but cannot serve any of our roles.
const UNUSABLE = /embedding|image|imagen|veo|robotics|computer-use|aqa/i;
// Live-session models are named for it; a plain text model that merely lists
// bidiGenerateContent is not guaranteed to speak audio.
const LIVE_NAME = /live|native-audio/i;

/** Which role (if any) a listed model can fill. Flash models only. */
export function classifyGeminiModel(raw: RawGeminiModel): GeminiModelRole | null {
    const id = modelId(raw.name ?? "");
    if (!id || !/flash/i.test(id) || UNUSABLE.test(id)) return null;
    const methods = raw.supportedGenerationMethods ?? [];

    if (/tts/i.test(id)) return methods.includes("generateContent") ? "tts" : null;
    if (LIVE_NAME.test(id)) return methods.includes("bidiGenerateContent") ? "live" : null;
    if (/audio/i.test(id)) return null;
    return methods.includes("generateContent") ? "text" : null;
}

/** "models/gemini-3.8-flash" -> "gemini-3.8-flash". */
function modelId(name: string): string {
    return name.replace(/^models\//, "").trim();
}

/** Parsed Gemini generation number ("gemini-3.8-flash" -> 3.8); 0 for aliases. */
function generation(id: string): number {
    const m = /^gemini-(\d+(?:\.\d+)?)/i.exec(id);
    return m ? parseFloat(m[1]) : 0;
}

/**
 * Best first: stable before preview/experimental, newer generation first,
 * full flash before flash-lite, undated before dated snapshots. This order is
 * also what the automatic fallback walks, so it must put the safest pick first.
 */
export function compareGeminiModels(a: string, b: string): number {
    const unstable = (id: string) => (/preview|exp/i.test(id) ? 1 : 0);
    const lite = (id: string) => (/lite/i.test(id) ? 1 : 0);
    const dated = (id: string) => (/-\d{2}-\d{4}$|-\d{3}$|-\d{8}$/.test(id) ? 1 : 0);
    return unstable(a) - unstable(b)
        || generation(b) - generation(a)
        || lite(a) - lite(b)
        || dated(a) - dated(b)
        || a.localeCompare(b);
}

/**
 * The flash models this key can use, per role, best first. Throws on a bad key
 * or an unreachable API - `geminiModelOptions()` is the never-throwing wrapper.
 */
export async function listGeminiModels(apiKey: string): Promise<GeminiModelOptions> {
    const key = apiKey.trim();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.models;

    const raw: RawGeminiModel[] = [];
    let pageToken = "";
    for (let page = 0; page < MAX_PAGES; page++) {
        const url = `${LIST_URL}?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
        // The key rides in a header, never the URL (URLs end up in logs).
        const r = await fetch(url, {
            headers: { "x-goog-api-key": key },
            signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
        });
        const body: any = await r.json().catch(() => null);
        if (!r.ok) {
            const detail = body?.error?.message ? String(body.error.message) : `HTTP ${r.status}`;
            throw new Error(r.status === 400 || r.status === 401 || r.status === 403
                ? `Gemini API key was rejected: ${detail}`
                : `Could not list Gemini models: ${detail}`);
        }
        raw.push(...(body?.models ?? []));
        pageToken = body?.nextPageToken ?? "";
        if (!pageToken) break;
    }

    const models: GeminiModelOptions = { live: [], text: [], tts: [] };
    const seen = new Set<string>();
    for (const m of raw) {
        const role = classifyGeminiModel(m);
        const id = modelId(m.name ?? "");
        if (!role || seen.has(id)) continue;
        seen.add(id);
        models[role].push({ value: id, name: m.displayName ? `${m.displayName} (${id})` : id });
    }
    for (const role of GEMINI_MODEL_ROLES) {
        models[role].sort((a, b) => compareGeminiModels(a.value, b.value));
    }

    cache.set(key, { at: Date.now(), models });
    return models;
}

/** The "" sentinel every dropdown starts with: it is what an unset setting means. */
function defaultOption(role: GeminiModelRole): GeminiModelOption {
    return { value: "", name: `Default (${GEMINI_DEFAULT_MODELS[role]})` };
}

/**
 * The settings page's three dropdowns. Never throws and never returns an empty
 * list: each role always starts with the "" default, so a missing or rejected
 * key still leaves something valid to save.
 */
export async function geminiModelOptions(apiKey: string): Promise<{ options: GeminiModelOptions; message: string }> {
    const defaults: GeminiModelOptions = { live: [defaultOption("live")], text: [defaultOption("text")], tts: [defaultOption("tts")] };
    const key = (apiKey ?? "").trim();
    if (!key) {
        return { options: defaults, message: "Enter your Gemini API key above to list the models your key can use." };
    }
    try {
        const models = await listGeminiModels(key);
        const options = { ...defaults };
        for (const role of GEMINI_MODEL_ROLES) options[role] = [defaultOption(role), ...models[role]];
        return { options, message: "" };
    } catch (err: any) {
        return { options: defaults, message: String(err?.message ?? err) };
    }
}

/**
 * True when Google says the model itself is gone or unknown - the only failure
 * a different model can fix. Matches generateContent's 404 NOT_FOUND ("no
 * longer available to new users", "is not found for API version") and the Live
 * API's close reason ("... is not supported for bidiGenerateContent").
 */
export function isGeminiModelGone(err: any): boolean {
    if (!err) return false;
    const status = err.status ?? err.code;
    const text = `${err.message ?? ""} ${err.reason ?? ""}`;
    if (status === 404 || /NOT_FOUND/.test(text)) return true;
    return /no longer available|is not found|not supported for (bidi)?generateContent/i.test(text);
}

/**
 * True for the Live API's close reason "Unsupported language code 'no' for
 * model models/...": native-audio models choose the spoken language themselves
 * and reject an explicit speechConfig.languageCode. Not a model problem - the
 * fix is to connect without the code.
 */
export function isGeminiSpeechLanguageRejected(err: any): boolean {
    if (!err) return false;
    return /unsupported language code/i.test(`${err.message ?? ""} ${err.reason ?? ""}`);
}

/**
 * True when the model exists but Google is shedding load right now: 503
 * UNAVAILABLE ("experiencing high demand ... try again later") or 429
 * RESOURCE_EXHAUSTED. Temporary - worth a retry, never a reason to switch the
 * model for good. The status words are matched case-sensitively so a 404's
 * "no longer available" can never read as UNAVAILABLE.
 */
export function isGeminiOverloaded(err: any): boolean {
    if (!err) return false;
    const status = err.status ?? err.code;
    const text = String(err.message ?? "");
    if (status === 503 || status === 429) return true;
    return /\bUNAVAILABLE\b|\bRESOURCE_EXHAUSTED\b/.test(text) || /high demand|overloaded/i.test(text);
}

/**
 * The best listed replacement for a role, skipping models already tried.
 * Null when the list can't be loaded or holds nothing else.
 */
export async function pickGeminiFallback(
    apiKey: string, role: GeminiModelRole, tried: ReadonlySet<string>,
    opts: { preferLite?: boolean } = {},
): Promise<string | null> {
    try {
        const models = await listGeminiModels(apiKey);
        const left = models[role].filter((m) => !tried.has(m.value));
        // Capacity stand-in: the lite tier is the one with headroom when the
        // full flash models are shedding load, so try those first.
        const pick = opts.preferLite ? (left.find((m) => /lite/i.test(m.value)) ?? left[0]) : left[0];
        return pick?.value ?? null;
    } catch {
        return null;
    }
}
