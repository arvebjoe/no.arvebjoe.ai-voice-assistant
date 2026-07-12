import { normalizeOpenAiBaseUrl } from './openai-compat.mjs';
import { LOCAL_DEFAULT_PORTS } from '../local-pipeline-provider.mjs';

/**
 * Context-window lookup for LM Studio, feeding the settings page's budget
 * meter. Ollama's window is whatever the app requests via num_ctx, but LM
 * Studio's is configured in the LM Studio UI at model-load time — the app can
 * only read it back. LM Studio's REST API (GET /api/v0/models) reports per
 * model:
 *   - max_context_length: the model's architectural maximum
 *   - loaded_context_length: the window actually configured for the loaded
 *     instance (present on loaded models in recent LM Studio versions)
 * The verdict wants the loaded value; the max is a fallback upper bound.
 *
 * Runs from the Homey box because the settings webview can't reach LAN
 * services itself (same reason as stage-tester).
 */

/** Flat request shape, straight from the settings form's (unsaved) values. */
export interface LmStudioContextRequest {
    host?: string;
    port?: number | string;
    /** Model id; empty = auto-pick like LmStudioClient (loaded chat model first). */
    model?: string;
}

export interface LmStudioContextResult {
    ok: boolean;
    /** Failure reason when !ok. */
    message?: string;
    model?: string;
    /** 'loaded' | 'not-loaded' as reported by LM Studio. */
    state?: string;
    contextLength?: number;
    /** 'loaded' = the configured window; 'max' = model maximum (older LM Studio or unloaded model). */
    source?: 'loaded' | 'max';
}

const PROBE_TIMEOUT_MS = 5_000;

/** Read the context window from LM Studio. Never throws — failures come back as { ok:false }. */
export async function getLmStudioContext(req: LmStudioContextRequest): Promise<LmStudioContextResult> {
    const host = String(req?.host ?? '').trim();
    if (!host) return { ok: false, message: 'No LM Studio host configured' };
    const port = Number(req?.port) || LOCAL_DEFAULT_PORTS.lmstudio;

    try {
        // normalizeOpenAiBaseUrl adds the scheme (and /v1, which the REST API
        // doesn't live under) — keep only the origin.
        const origin = new URL(normalizeOpenAiBaseUrl(`${host}:${port}`)).origin;
        const res = await fetch(`${origin}/api/v0/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`LM Studio /api/v0/models returned HTTP ${res.status}`);
        const data: any = await res.json();
        const models: any[] = Array.isArray(data?.data) ? data.data : [];

        const wanted = String(req?.model ?? '').trim();
        let entry: any;
        if (wanted) {
            entry = models.find((m) => m?.id === wanted);
            if (!entry) return { ok: false, message: `Model '${wanted}' not found in LM Studio` };
        } else {
            // Mirror LmStudioClient's auto-pick as closely as the v0 API
            // allows: prefer a loaded chat model, then any chat model.
            const chat = models.filter((m) => m?.type === 'llm' || m?.type === 'vlm');
            entry = chat.find((m) => m?.state === 'loaded') ?? chat[0];
            if (!entry) return { ok: false, message: 'LM Studio has no models available' };
        }

        const loadedLen = Number(entry.loaded_context_length) || 0;
        const maxLen = Number(entry.max_context_length) || 0;
        const contextLength = loadedLen || maxLen;
        if (!contextLength) return { ok: false, message: `LM Studio reported no context length for '${entry.id}'` };

        return {
            ok: true,
            model: entry.id,
            state: entry.state,
            contextLength,
            source: loadedLen ? 'loaded' : 'max',
        };
    } catch (err: any) {
        // Surface the underlying cause (ECONNREFUSED etc.) hidden by fetch().
        const cause = err?.cause?.code || err?.cause?.message;
        return { ok: false, message: String(err?.message ?? err) + (cause ? ` (${cause})` : '') };
    }
}
