import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openaiWebSearch, braveWebSearch, OPENAI_SEARCH_MODEL } from '../src/helpers/web-search.mjs';

type FetchCall = { url: string; init?: any };
let fetchCalls: FetchCall[] = [];
let fetchImpl: (url: string, init?: any) => any;

const jsonResponse = (body: any, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
});

beforeEach(() => {
    fetchCalls = [];
    vi.stubGlobal('fetch', vi.fn((url: any, init?: any) => {
        fetchCalls.push({ url: String(url), init });
        return Promise.resolve(fetchImpl(String(url), init));
    }));
});
afterEach(() => vi.unstubAllGlobals());

describe('openaiWebSearch', () => {
    it('sends the web_search tool with the timezone and parses the answer + citations', async () => {
        fetchImpl = () => jsonResponse({
            output: [
                { type: 'web_search_call', status: 'completed' },
                {
                    type: 'message',
                    content: [{
                        type: 'output_text',
                        text: 'Dune 3 runs at 18:00 and 21:00 at Colosseum.',
                        annotations: [
                            { type: 'url_citation', url: 'https://kino.example/oslo', title: 'Oslo kino' },
                            { type: 'url_citation', url: 'https://kino.example/oslo', title: 'duplicate' },
                        ],
                    }],
                },
            ],
        });

        const { answer, sources } = await openaiWebSearch('kino oslo i dag', 'sk-x', { timezone: 'Europe/Oslo' });

        expect(answer).toContain('Dune 3');
        expect(sources).toEqual([{ title: 'Oslo kino', url: 'https://kino.example/oslo' }]);

        const body = JSON.parse(fetchCalls[0].init.body);
        expect(fetchCalls[0].url).toBe('https://api.openai.com/v1/responses');
        expect(fetchCalls[0].init.headers.Authorization).toBe('Bearer sk-x');
        expect(body.model).toBe(OPENAI_SEARCH_MODEL);
        expect(body.input).toBe('kino oslo i dag');
        expect(body.tools).toEqual([{ type: 'web_search', user_location: { type: 'approximate', timezone: 'Europe/Oslo' } }]);
    });

    it('omits user_location without a timezone and rejects on 401', async () => {
        fetchImpl = () => jsonResponse({ error: 'bad key' }, 401);
        await expect(openaiWebSearch('news', 'sk-bad')).rejects.toThrow(/401/);

        fetchImpl = () => jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] });
        await openaiWebSearch('news', 'sk-x');
        const body = JSON.parse(fetchCalls[1].init.body);
        expect(body.tools).toEqual([{ type: 'web_search' }]);
    });

    it('rejects when the response has no answer text', async () => {
        fetchImpl = () => jsonResponse({ output: [{ type: 'web_search_call' }] });
        await expect(openaiWebSearch('news', 'sk-x')).rejects.toThrow(/no answer/);
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
