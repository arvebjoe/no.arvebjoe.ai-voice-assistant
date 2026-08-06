import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openaiWebSearch, braveWebSearch, searchWithVerification, WebSearchTimeoutError, OPENAI_SEARCH_MODEL } from '../src/helpers/web-search.mjs';

type FetchCall = { url: string; init?: any };
let fetchCalls: FetchCall[] = [];
let fetchImpl: (url: string, init?: any) => any;

const jsonResponse = (body: any, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
});

/** A Responses payload whose output_text carries the structured verdict. */
const verdictResponse = (verdict: any, annotations: any[] = []) => jsonResponse({
    output: [
        { type: 'web_search_call', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(verdict), annotations }] },
    ],
});

const sufficient = (answer: string, annotations: any[] = []) =>
    verdictResponse({ answer, sufficient: true, missing: '', refined_query: '' }, annotations);

const insufficient = (answer: string, missing: string, refined: string) =>
    verdictResponse({ answer, sufficient: false, missing, refined_query: refined });

const bodyOf = (i: number) => JSON.parse(fetchCalls[i].init.body);

beforeEach(() => {
    fetchCalls = [];
    vi.stubGlobal('fetch', vi.fn((url: any, init?: any) => {
        fetchCalls.push({ url: String(url), init });
        return Promise.resolve(fetchImpl(String(url), init));
    }));
});
afterEach(() => vi.unstubAllGlobals());

describe('openaiWebSearch', () => {
    it('sends the web_search tool with high context + timezone and parses the verdict and citations', async () => {
        fetchImpl = () => sufficient('Dune 3 runs at 18:00 and 21:00 at Colosseum.', [
            { type: 'url_citation', url: 'https://kino.example/oslo', title: 'Oslo kino' },
            { type: 'url_citation', url: 'https://kino.example/oslo', title: 'duplicate' },
        ]);

        const { answer, sources, sufficient: ok } = await openaiWebSearch('kino oslo i dag', 'sk-x', { timezone: 'Europe/Oslo' });

        expect(answer).toContain('Dune 3');
        expect(ok).toBe(true);
        expect(sources).toEqual([{ title: 'Oslo kino', url: 'https://kino.example/oslo' }]);

        const body = bodyOf(0);
        expect(fetchCalls[0].url).toBe('https://api.openai.com/v1/responses');
        expect(fetchCalls[0].init.headers.Authorization).toBe('Bearer sk-x');
        expect(body.model).toBe(OPENAI_SEARCH_MODEL);
        expect(body.input).toBe('kino oslo i dag');
        expect(body.tools).toEqual([{
            type: 'web_search',
            search_context_size: 'high',
            user_location: { type: 'approximate', timezone: 'Europe/Oslo' },
        }]);
        expect(body.text.format.name).toBe('search_answer');
        expect(body.max_tool_calls).toBeGreaterThan(0);
    });

    it('passes the user question alongside the query so the model judges against it', async () => {
        fetchImpl = () => sufficient('18:00 and 21:00.');
        await openaiWebSearch('kino oslo', 'sk-x', { question: 'når går Dune 3 i kveld?' });

        expect(bodyOf(0).input).toContain('når går Dune 3 i kveld?');
        expect(bodyOf(0).input).toContain('kino oslo');
    });

    it('feeds the previous shortfall into a retry prompt', async () => {
        fetchImpl = () => sufficient('18:00.');
        await openaiWebSearch('kino oslo colosseum', 'sk-x', { shortfall: 'no show times' });

        expect(bodyOf(0).input).toContain('no show times');
    });

    it('omits user_location without a timezone and rejects on 401', async () => {
        fetchImpl = () => jsonResponse({ error: 'bad key' }, 401);
        await expect(openaiWebSearch('news', 'sk-bad')).rejects.toThrow(/401/);

        fetchImpl = () => sufficient('ok');
        await openaiWebSearch('news', 'sk-x');
        expect(bodyOf(1).tools[0].user_location).toBeUndefined();
    });

    it('rejects when the response has no answer text', async () => {
        fetchImpl = () => jsonResponse({ output: [{ type: 'web_search_call' }] });
        await expect(openaiWebSearch('news', 'sk-x')).rejects.toThrow(/no answer/);
    });

    it('degrades to plain text when the output is not the JSON verdict', async () => {
        fetchImpl = () => jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'plain answer' }] }] });
        const r = await openaiWebSearch('news', 'sk-x');
        expect(r).toMatchObject({ answer: 'plain answer', sufficient: true });
    });
});

describe('searchWithVerification', () => {
    it('stops after one search when the answer is sufficient', async () => {
        fetchImpl = () => sufficient('Bus at 12:04.');
        const r = await searchWithVerification('next bus', 'sk-x', { maxAttempts: 3 });

        expect(r.attempts).toBe(1);
        expect(r.sufficient).toBe(true);
        expect(fetchCalls).toHaveLength(1);
    });

    it('retries with the refined query and escalating effort, then succeeds', async () => {
        let call = 0;
        fetchImpl = () => (++call === 1
            ? insufficient('The cinema is open today.', 'the actual show times', 'Colosseum Oslo Dune 3 show times')
            : sufficient('Dune 3 at 18:00 and 21:00.'));

        const r = await searchWithVerification('kino oslo', 'sk-x', { maxAttempts: 2 });

        expect(r.attempts).toBe(2);
        expect(r.sufficient).toBe(true);
        expect(r.answer).toContain('18:00');
        expect(r.queriesTried).toEqual(['kino oslo', 'Colosseum Oslo Dune 3 show times']);
        expect(bodyOf(0).reasoning.effort).toBe('low');
        expect(bodyOf(1).reasoning.effort).toBe('medium');
        expect(bodyOf(1).input).toContain('the actual show times');
    });

    it.each([1, 2])('runs the same strong first attempt whether or not a retry is allowed (budget %i)', async (maxAttempts) => {
        fetchImpl = () => sufficient('Bus at 12:04.');
        await searchWithVerification('next bus', 'sk-x', { maxAttempts });

        // A weak first pass fails its own verdict and makes the question pay for
        // two searches — so the budget must not weaken attempt 1.
        const body = bodyOf(0);
        expect(body.reasoning.effort).toBe('low');
        expect(body.tools[0].search_context_size).toBe('high');
        expect(body.instructions).toContain('search again with a better query');
    });

    it('escalates a retry one reasoning step, not to high', async () => {
        let call = 0;
        fetchImpl = () => (++call === 1
            ? insufficient('vague', 'the times', 'better query')
            : sufficient('18:00.'));
        await searchWithVerification('kino', 'sk-x', { maxAttempts: 2 });

        // 'high' effort on gpt-5-mini is dramatically slower, and this already
        // runs after the user has sat through a full search.
        expect(bodyOf(1).reasoning.effort).toBe('medium');
        expect(bodyOf(1).max_tool_calls).toBeGreaterThan(bodyOf(0).max_tool_calls);
    });

    it('honours the attempt budget and reports the shortfall when it runs out', async () => {
        let n = 0;
        fetchImpl = () => insufficient(`vague ${++n}`, 'the specifics', `query ${n + 1}`);

        const r = await searchWithVerification('start', 'sk-x', { maxAttempts: 2 });

        expect(fetchCalls).toHaveLength(2);
        expect(r.attempts).toBe(2);
        expect(r.sufficient).toBe(false);
        expect(r.missing).toBe('the specifics');
    });

    it('never retries when the budget is 1', async () => {
        fetchImpl = () => insufficient('vague', 'the specifics', 'better query');
        const r = await searchWithVerification('start', 'sk-x', { maxAttempts: 1 });

        expect(fetchCalls).toHaveLength(1);
        expect(r.sufficient).toBe(false);
    });

    it('gives up early rather than repeating a query it already tried', async () => {
        fetchImpl = () => insufficient('vague', 'the specifics', 'start');
        const r = await searchWithVerification('start', 'sk-x', { maxAttempts: 4 });

        expect(fetchCalls).toHaveLength(1);
        expect(r.sufficient).toBe(false);
    });

    it('keeps the earlier answer when a retry times out', async () => {
        let call = 0;
        fetchImpl = () => {
            if (++call === 1) return insufficient('partial answer', 'the times', 'better query');
            const err: any = new Error('aborted');
            err.name = 'TimeoutError';
            throw err;
        };

        const r = await searchWithVerification('kino', 'sk-x', { maxAttempts: 2 });

        expect(r.answer).toBe('partial answer');
        expect(r.sufficient).toBe(false);
        expect(fetchCalls).toHaveLength(2);
    });

    it('propagates a timeout on the very first attempt as WebSearchTimeoutError', async () => {
        fetchImpl = () => {
            const err: any = new Error('aborted');
            err.name = 'TimeoutError';
            throw err;
        };
        await expect(searchWithVerification('kino', 'sk-x', { maxAttempts: 2 }))
            .rejects.toBeInstanceOf(WebSearchTimeoutError);
    });

    it('gives each attempt a generous per-request timeout', async () => {
        fetchImpl = () => sufficient('ok');
        await searchWithVerification('kino', 'sk-x', { maxAttempts: 1 });
        // AbortSignal.timeout(ms) — assert we are well past the old 30 s ceiling.
        expect(fetchCalls[0].init.signal).toBeInstanceOf(AbortSignal);
    });

    it('clamps a nonsensical budget to the hard cap', async () => {
        let n = 0;
        fetchImpl = () => insufficient('vague', 'more', `q${++n}`);
        const r = await searchWithVerification('start', 'sk-x', { maxAttempts: 99 });

        expect(r.attempts).toBe(4);
    });
});

describe('braveWebSearch', () => {
    it('queries with the subscription token and maps results', async () => {
        fetchImpl = () => jsonResponse({
            web: {
                results: [
                    { title: 'Ruter', url: 'https://ruter.no', description: 'Next bus 12:04', extra: 'ignored' },
                    { title: 'Entur', url: 'https://entur.no', description: 'Journey planner' },
                ],
            },
        });

        const results = await braveWebSearch('next bus majorstuen', 'brave-key');

        expect(results).toEqual([
            { title: 'Ruter', url: 'https://ruter.no', description: 'Next bus 12:04' },
            { title: 'Entur', url: 'https://entur.no', description: 'Journey planner' },
        ]);
        expect(fetchCalls[0].url).toContain('https://api.search.brave.com/res/v1/web/search?q=next%20bus%20majorstuen');
        expect(fetchCalls[0].init.headers['X-Subscription-Token']).toBe('brave-key');
    });

    it('rejects on a bad key (401/403) and tolerates an empty result set', async () => {
        fetchImpl = () => jsonResponse({}, 403);
        await expect(braveWebSearch('x', 'bad')).rejects.toThrow(/rejected/);

        fetchImpl = () => jsonResponse({ web: {} });
        await expect(braveWebSearch('x', 'ok')).resolves.toEqual([]);
    });
});
