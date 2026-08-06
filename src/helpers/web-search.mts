/**
 * Web-search backends for the agent's `web_search` tool (ToolManager).
 *
 * Two providers, selected by the `web_search_provider` global setting:
 *   - 'openai' (default): OpenAI Responses API with the hosted `web_search`
 *     tool — reuses the `openai_api_key` the app already has. The model both
 *     searches and summarizes, so the tool returns a ready answer plus the
 *     cited sources.
 *   - 'brave': Brave Search API (separate `brave_api_key`, free tier at
 *     https://api.search.brave.com). Returns raw result snippets; the voice
 *     agent's own LLM does the summarizing.
 *
 * ## Answer verification and retry (openai backend)
 *
 * A single shallow search is the usual failure mode: the model comes back with
 * something merely *related* to the question ("the cinema is open today")
 * instead of the specifics that were asked for ("Dune 3 at 18:00 and 21:00").
 * Three things counteract that, in increasing order of cost:
 *
 *  1. Depth knobs on every call — `search_context_size: 'high'` and an explicit
 *     reasoning effort. Both directly control how many pages the model consults.
 *  2. Self-assessment in the SAME call: the search model returns a structured
 *     verdict ({ answer, sufficient, missing, refined_query }) alongside the
 *     answer. It just did the searching, so it is the cheapest available judge —
 *     a good answer therefore costs no extra latency at all.
 *  3. A retry loop (`searchWithVerification`) that re-searches with the model's
 *     own refined query, escalating reasoning effort, up to `maxAttempts`.
 *
 * When the budget is exhausted the answer is still returned, but flagged
 * `sufficient: false` with a `missing` note, so the voice agent can ask the user
 * to clarify instead of confidently reading out a near-miss.
 */

/** A search that ran out of time — distinct so the agent can say so plainly. */
export class WebSearchTimeoutError extends Error {
    readonly code = 'SEARCH_TIMEOUT';
    constructor() {
        super('The web search took too long to come back.');
        this.name = 'WebSearchTimeoutError';
    }
}

export interface WebSearchSource {
    title: string;
    url: string;
}

export interface OpenAiSearchAnswer {
    answer: string;
    sources: WebSearchSource[];
    /** The search model's own verdict on whether `answer` actually answers the question. */
    sufficient: boolean;
    /** What is still missing when `sufficient` is false (spoken-language, short). */
    missing?: string;
    /** A better query the model suggests trying instead, when `sufficient` is false. */
    refinedQuery?: string;
}

export interface VerifiedSearchAnswer extends OpenAiSearchAnswer {
    /** How many searches were actually run (1 when the first answer was good). */
    attempts: number;
    /** Every query tried, in order — the first is the agent's original. */
    queriesTried: string[];
}

export interface BraveSearchResult {
    title: string;
    url: string;
    description: string;
}

/** Small + cheap and supports the hosted web_search tool. */
export const OPENAI_SEARCH_MODEL = 'gpt-5-mini';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
/** Brave is a single plain HTTP query — nothing like the OpenAI backend's cost. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The OpenAI backend's per-attempt ceiling lives on each SearchProfile instead,
 * because a fast attempt that hangs for 45 s is worse than one that gives up at
 * 25 s and lets the deep retry take over.
 *
 * Wall-clock ceiling for a whole `searchWithVerification` call. A retry is only
 * Wall-clock ceiling for a whole `searchWithVerification` call. A retry is only
 * started if there is real time left, so raising `maxAttempts` cannot stack
 * into minutes of dead air on the satellite.
 */
const OPENAI_TOTAL_BUDGET_MS = 100_000;

/** Below this, a retry cannot realistically finish — return what we have instead. */
const MIN_RETRY_HEADROOM_MS = 25_000;

/** Hard ceiling on `web_search_max_attempts`, whatever the setting says. */
export const MAX_SEARCH_ATTEMPTS_CAP = 4;
export const DEFAULT_SEARCH_ATTEMPTS = 2;

/**
 * How hard one attempt digs. Latency is dominated by `maxToolCalls` — every
 * extra in-call search is a full round trip to the index plus page reads — so
 * the fast profile leans on OUR retry loop instead of searching repeatedly
 * inside a single call.
 *
 * `maxToolCalls` is only a hint to the hosted tool (OpenAI's own counter has
 * been reported to reset mid-run); the real budget is the attempt loop.
 */
interface SearchProfile {
    effort: 'low' | 'medium' | 'high';
    context: 'low' | 'medium' | 'high';
    maxToolCalls: number;
    timeoutMs: number;
    /** Whether to push the model to re-search within this single call. */
    digInCall: boolean;
}

/**
 * The default for every first attempt. Deliberately NOT a cheap rung: a weak
 * first pass fails its own verdict, triggers the retry, and the question ends
 * up paying for both searches — measurably worse than one good search.
 *
 * `low` reasoning effort with `high` search context is the combination that
 * tested well in practice. Raising effort to the API's 'medium' default made it
 * noticeably slower without making answers better, so don't "fix" it back.
 */
const STANDARD_PROFILE: SearchProfile = { effort: 'low', context: 'high', maxToolCalls: 4, timeoutMs: 45_000, digInCall: true };

/**
 * A retry, i.e. the standard pass already came back insufficient. Escalates
 * reasoning one step only — 'high' effort on gpt-5-mini is dramatically slower
 * and this already runs after the user has waited through a full search.
 */
const DEEP_PROFILE: SearchProfile = { effort: 'medium', context: 'high', maxToolCalls: 5, timeoutMs: 55_000, digInCall: true };

const BASE_INSTRUCTIONS =
    'You are the web-search backend of a voice assistant. Search the web and answer the question ' +
    'briefly and factually in the language of the question, leading with the concrete specifics that were ' +
    'asked for (times, names, places, prices, dates). The answer will be spoken aloud, so no markdown and no URLs.\n\n';

/** Only for the deep profiles — in-call re-searching is the main latency cost. */
const DIG_INSTRUCTIONS =
    'Do not stop at the first page that is merely on-topic. If the results are generic, out of date, or only ' +
    'adjacent to what was asked, search again with a better query before answering.\n\n';

/**
 * The self-assessment. On the fast profile this is what makes a shallow answer
 * safe: rather than searching repeatedly up front, we answer fast and let the
 * caller decide whether to spend another attempt.
 */
const VERDICT_INSTRUCTIONS =
    'Judge your own answer honestly: set "sufficient" to true ONLY if it states the specifics the question ' +
    'asked for. A vague, generic or partial answer is not sufficient. When it is not sufficient, put the concrete ' +
    'thing still missing in "missing", and a better search query to try next in "refined_query".';

function instructionsFor(profile: SearchProfile): string {
    return BASE_INSTRUCTIONS + (profile.digInCall ? DIG_INSTRUCTIONS : '') + VERDICT_INSTRUCTIONS;
}

/** Structured verdict — see the module comment for why the searcher is its own judge. */
const SEARCH_RESULT_SCHEMA = {
    type: 'json_schema',
    name: 'search_answer',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            answer: { type: 'string', description: 'The spoken-language answer to the question.' },
            sufficient: { type: 'boolean', description: 'True only if the answer states the specifics that were asked for.' },
            missing: { type: 'string', description: 'What is still missing; empty string when sufficient.' },
            refined_query: { type: 'string', description: 'A better query to try next; empty string when sufficient.' },
        },
        required: ['answer', 'sufficient', 'missing', 'refined_query'],
        additionalProperties: false,
    },
} as const;

/**
 * One web search + summarization pass through the OpenAI Responses API.
 * `timezone` (IANA) approximates the user's location so "the local cinema"
 * resolves sensibly; Homey exposes no city/country, so that's all we send.
 * `question` is the user's actual question when the agent supplied one — the
 * model judges sufficiency against that rather than against its own keywords.
 */
export async function openaiWebSearch(
    query: string,
    apiKey: string,
    opts?: { timezone?: string; question?: string; profile?: SearchProfile; shortfall?: string; timeoutMs?: number },
): Promise<OpenAiSearchAnswer> {
    const profile = opts?.profile ?? STANDARD_PROFILE;
    const tool: any = { type: 'web_search', search_context_size: profile.context };
    if (opts?.timezone) {
        tool.user_location = { type: 'approximate', timezone: opts.timezone };
    }

    // The searcher judges against the user's real question when we have it; the
    // query alone is just keywords and makes for a much weaker judge.
    let input = opts?.question && opts.question !== query
        ? `User's question: ${opts.question}\nSearch query: ${query}`
        : query;
    if (opts?.shortfall) {
        input += `\n\nA previous search already failed to answer this. What was missing: ${opts.shortfall}\n` +
            'Search differently and more deeply this time — do not repeat the previous approach.';
    }

    let res: any;
    try {
        res = await fetch(OPENAI_RESPONSES_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: OPENAI_SEARCH_MODEL,
                tools: [tool],
                max_tool_calls: profile.maxToolCalls,
                reasoning: { effort: profile.effort },
                text: { format: SEARCH_RESULT_SCHEMA },
                instructions: instructionsFor(profile),
                input,
            }),
            signal: AbortSignal.timeout(opts?.timeoutMs ?? profile.timeoutMs),
        });
    } catch (err: any) {
        // A deep search that overran the clock is a normal outcome, not a bug —
        // give it a code the caller can turn into something speakable instead of
        // surfacing a raw "operation was aborted".
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
            throw new WebSearchTimeoutError();
        }
        throw err;
    }
    if (res.status === 401) throw new Error('OpenAI API key was rejected (401) — check it in the app settings');
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`OpenAI /v1/responses returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }

    const json: any = await res.json();
    let text = '';
    const sources: WebSearchSource[] = [];
    for (const item of json?.output ?? []) {
        if (item?.type !== 'message') continue;
        for (const part of item?.content ?? []) {
            if (part?.type !== 'output_text') continue;
            text += part.text ?? '';
            for (const a of part?.annotations ?? []) {
                if (a?.type === 'url_citation' && a.url && !sources.some(s => s.url === a.url)) {
                    sources.push({ title: a.title ?? a.url, url: a.url });
                }
            }
        }
    }
    if (!text.trim()) throw new Error('OpenAI web search returned no answer text');

    return { ...parseVerdict(text), sources };
}

/**
 * Read the structured verdict out of the model's output text.
 *
 * Falls back to treating the whole text as a sufficient answer if it is not the
 * JSON we asked for. That keeps the tool working (degraded to pre-verification
 * behavior) rather than failing the user's question outright — worth it because
 * combining a hosted tool with a strict output format is the part of this most
 * likely to change under us.
 */
function parseVerdict(text: string): Omit<OpenAiSearchAnswer, 'sources'> {
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { answer: text.trim(), sufficient: true };
    }
    const answer = String(parsed?.answer ?? '').trim();
    if (!answer) return { answer: text.trim(), sufficient: true };

    const missing = String(parsed?.missing ?? '').trim();
    const refinedQuery = String(parsed?.refined_query ?? '').trim();
    return {
        answer,
        sufficient: parsed?.sufficient !== false,
        ...(missing ? { missing } : {}),
        ...(refinedQuery ? { refinedQuery } : {}),
    };
}

/**
 * Search, check the answer, and re-search with a better query when it falls
 * short — up to `maxAttempts` total searches (1 disables retrying).
 *
 * Retries escalate reasoning effort and carry the previous attempt's shortfall
 * into the next prompt, so attempt 2 is a genuinely different search rather than
 * the same shallow one again. The last answer is returned either way; check
 * `sufficient` to decide whether to speak it as fact or ask the user to clarify.
 */
export async function searchWithVerification(
    query: string,
    apiKey: string,
    opts?: { timezone?: string; question?: string; maxAttempts?: number; onAttempt?: (n: number, q: string) => void },
): Promise<VerifiedSearchAnswer> {
    const budget = Math.max(1, Math.min(MAX_SEARCH_ATTEMPTS_CAP, Math.trunc(opts?.maxAttempts ?? DEFAULT_SEARCH_ATTEMPTS) || DEFAULT_SEARCH_ATTEMPTS));
    const queriesTried: string[] = [];
    // Every first attempt is the standard profile, whatever the budget: the
    // retry is a safety net for the questions one good search genuinely misses,
    // not a reason to make the first search worse.
    const profileFor = (attempt: number): SearchProfile =>
        attempt === 1 ? STANDARD_PROFILE : DEEP_PROFILE;

    const startedAt = Date.now();
    let nextQuery = query;
    let shortfall: string | undefined;
    let last: OpenAiSearchAnswer | undefined;

    for (let attempt = 1; attempt <= budget; attempt++) {
        const remaining = OPENAI_TOTAL_BUDGET_MS - (Date.now() - startedAt);
        queriesTried.push(nextQuery);
        opts?.onAttempt?.(attempt, nextQuery);

        const profile = profileFor(attempt);
        try {
            last = await openaiWebSearch(nextQuery, apiKey, {
                timezone: opts?.timezone,
                question: opts?.question,
                profile,
                shortfall,
                timeoutMs: Math.min(profile.timeoutMs, Math.max(0, remaining)),
            });
        } catch (err) {
            // A retry that ran out of time must not throw away the usable (if
            // imperfect) answer the previous attempt already produced.
            if (last && err instanceof WebSearchTimeoutError) break;
            throw err;
        }

        if (last.sufficient) break;

        // Nothing better to try — a further identical search would just burn
        // seconds of dead air for the same answer.
        const refined = last.refinedQuery?.trim();
        if (!refined || queriesTried.includes(refined)) break;

        // Don't start a retry that cannot finish inside the wall-clock budget.
        if (OPENAI_TOTAL_BUDGET_MS - (Date.now() - startedAt) < MIN_RETRY_HEADROOM_MS) break;

        nextQuery = refined;
        shortfall = last.missing;
    }

    return { ...last!, attempts: queriesTried.length, queriesTried };
}

/** Raw web search via the Brave Search API — snippets only, no summarization. */
export async function braveWebSearch(query: string, apiKey: string, count = 5): Promise<BraveSearchResult[]> {
    const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetch(url, {
        headers: {
            Accept: 'application/json',
            'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
        throw new Error(`Brave Search API key was rejected (${res.status}) — check it in the app settings`);
    }
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Brave Search returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }

    const json: any = await res.json();
    return (json?.web?.results ?? []).slice(0, count).map((r: any) => ({
        title: String(r?.title ?? ''),
        url: String(r?.url ?? ''),
        description: String(r?.description ?? ''),
    }));
}
