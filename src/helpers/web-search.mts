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
 */

export interface WebSearchSource {
    title: string;
    url: string;
}

export interface OpenAiSearchAnswer {
    answer: string;
    sources: WebSearchSource[];
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
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * One-shot web search + summarization through the OpenAI Responses API.
 * `timezone` (IANA) approximates the user's location so "the local cinema"
 * resolves sensibly; Homey exposes no city/country, so that's all we send.
 */
export async function openaiWebSearch(query: string, apiKey: string, opts?: { timezone?: string }): Promise<OpenAiSearchAnswer> {
    const tool: any = { type: 'web_search' };
    if (opts?.timezone) {
        tool.user_location = { type: 'approximate', timezone: opts.timezone };
    }

    const res = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: OPENAI_SEARCH_MODEL,
            tools: [tool],
            instructions: 'You are the web-search backend of a voice assistant. Search the web and answer the query ' +
                'briefly and factually in the language of the query, leading with the specifics (times, names, places, prices). ' +
                'The answer will be spoken aloud, so no markdown, no URLs in the text.',
            input: query,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401) throw new Error('OpenAI API key was rejected (401) — check it in the app settings');
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`OpenAI /v1/responses returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }

    const json: any = await res.json();
    let answer = '';
    const sources: WebSearchSource[] = [];
    for (const item of json?.output ?? []) {
        if (item?.type !== 'message') continue;
        for (const part of item?.content ?? []) {
            if (part?.type !== 'output_text') continue;
            answer += part.text ?? '';
            for (const a of part?.annotations ?? []) {
                if (a?.type === 'url_citation' && a.url && !sources.some(s => s.url === a.url)) {
                    sources.push({ title: a.title ?? a.url, url: a.url });
                }
            }
        }
    }
    if (!answer.trim()) throw new Error('OpenAI web search returned no answer text');
    return { answer: answer.trim(), sources };
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
