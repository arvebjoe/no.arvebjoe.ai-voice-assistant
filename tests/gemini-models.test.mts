import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    classifyGeminiModel, compareGeminiModels, geminiModelOptions, isGeminiModelGone, isGeminiOverloaded,
    pickGeminiFallback, __clearGeminiModelCache,
} from '../src/llm/providers/gemini-models.mjs';

const GEN = ['generateContent', 'countTokens'];
const BIDI = ['bidiGenerateContent'];

/** A trimmed `GET /v1beta/models` catalog, shaped like Google's reply. */
export const CATALOG = {
    models: [
        { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: GEN },
        { name: 'models/gemini-3.8-flash-lite', displayName: 'Gemini 3.8 Flash-Lite', supportedGenerationMethods: GEN },
        { name: 'models/gemini-3.9-flash-preview', displayName: 'Gemini 3.9 Flash Preview', supportedGenerationMethods: GEN },
        { name: 'models/gemini-3.1-flash', displayName: 'Gemini 3.1 Flash', supportedGenerationMethods: GEN },
        { name: 'models/gemini-3.8-pro', displayName: 'Gemini 3.8 Pro', supportedGenerationMethods: GEN },
        { name: 'models/gemini-3.8-flash-tts', displayName: 'Gemini 3.8 Flash TTS', supportedGenerationMethods: GEN },
        { name: 'models/gemini-3.8-flash-lite-tts', displayName: 'Gemini 3.8 Flash-Lite TTS', supportedGenerationMethods: GEN },
        { name: 'models/gemini-3.1-flash-live-preview', displayName: 'Gemini 3.1 Flash Live', supportedGenerationMethods: BIDI },
        { name: 'models/gemini-3.8-flash-image', displayName: 'Image', supportedGenerationMethods: GEN },
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    ],
};

function stubCatalog(status = 200, body: any = CATALOG) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('gemini-models', () => {
    beforeEach(() => __clearGeminiModelCache());
    afterEach(() => vi.unstubAllGlobals());

    it('classifies flash models by role and drops everything else', () => {
        const role = (name: string, m = GEN) => classifyGeminiModel({ name: `models/${name}`, supportedGenerationMethods: m });
        expect(role('gemini-3.8-flash')).toBe('text');
        expect(role('gemini-3.8-flash-tts')).toBe('tts');
        expect(role('gemini-3.1-flash-live-preview', BIDI)).toBe('live');
        expect(role('gemini-3.8-pro')).toBeNull();            // not flash
        expect(role('gemini-3.8-flash-image')).toBeNull();    // wrong family
        expect(role('gemini-3.1-flash-live-preview', GEN)).toBeNull(); // live name, no bidi
    });

    it('ranks stable, newest, full flash first', () => {
        const ids = ['gemini-3.9-flash-preview', 'gemini-3.8-flash-lite', 'gemini-3.1-flash', 'gemini-3.8-flash'];
        expect(ids.sort(compareGeminiModels)).toEqual(
            ['gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-3.1-flash', 'gemini-3.9-flash-preview']);
    });

    it('lists per role behind the "" default, key in a header not the URL', async () => {
        const fetchMock = stubCatalog();
        const { options, message } = await geminiModelOptions('g-key');

        expect(message).toBe('');
        expect(options.text.map(o => o.value)).toEqual(
            ['', 'gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-3.1-flash', 'gemini-3.9-flash-preview']);
        expect(options.tts.map(o => o.value)).toEqual(['', 'gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']);
        expect(options.live.map(o => o.value)).toEqual(['', 'gemini-3.1-flash-live-preview']);

        const [url, init] = fetchMock.mock.calls[0] as any;
        expect(url).not.toContain('g-key');
        expect(init.headers['x-goog-api-key']).toBe('g-key');
    });

    it('never throws: no key or a rejected key leaves only the defaults plus a message', async () => {
        const none = await geminiModelOptions('  ');
        expect(none.options.text).toEqual([{ value: '', name: 'Default (gemini-3.8-flash)' }]);
        expect(none.message).toMatch(/Enter your Gemini API key/);

        stubCatalog(400, { error: { message: 'API key not valid' } });
        const bad = await geminiModelOptions('bad');
        expect(bad.options.tts).toHaveLength(1);
        expect(bad.message).toMatch(/rejected.*API key not valid/);
    });

    it('recognises the "model gone" errors and nothing else', () => {
        expect(isGeminiModelGone({ status: 404, message: 'This model models/gemini-2.5-flash is no longer available to new users.' })).toBe(true);
        expect(isGeminiModelGone({ reason: 'models/x is not found for API version v1beta, or is not supported for bidiGenerateContent' })).toBe(true);
        expect(isGeminiModelGone({ status: 429, message: 'Resource exhausted' })).toBe(false);
        expect(isGeminiModelGone({ status: 400, message: 'API key not valid' })).toBe(false);
        expect(isGeminiModelGone(null)).toBe(false);
    });

    it('recognises overload (503 / 429) but never a retired model as overload', () => {
        expect(isGeminiOverloaded({ status: 503, message: 'This model is currently experiencing high demand.' })).toBe(true);
        expect(isGeminiOverloaded({ message: '{"error":{"code":503,"status":"UNAVAILABLE"}}' })).toBe(true);
        expect(isGeminiOverloaded({ status: 429, message: 'RESOURCE_EXHAUSTED' })).toBe(true);
        expect(isGeminiOverloaded({ status: 404, message: 'This model is no longer available to new users.' })).toBe(false);
        expect(isGeminiOverloaded({ status: 500, message: 'Internal error' })).toBe(false);
    });

    it('picks the best replacement not yet tried, null when the list fails', async () => {
        stubCatalog();
        expect(await pickGeminiFallback('g-key', 'text', new Set(['gemini-3.8-flash']))).toBe('gemini-3.8-flash-lite');

        __clearGeminiModelCache();
        stubCatalog(500, { error: { message: 'boom' } });
        expect(await pickGeminiFallback('g-key', 'text', new Set())).toBeNull();
    });
});
