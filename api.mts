import { getVoicesForProvider, DEFAULT_VOICE_PROVIDER } from './src/llm/voice-provider-factory.mjs';

/**
 * App Web API — called from the settings page via `Homey.api(...)`.
 *
 * Routes are declared in `.homeycompose/app.json` under `api`; each key of the
 * default-exported object matches a route key. Handlers receive
 * `{ homey, query, params, body }`. (Homey's ESM loader expects a default-export
 * object of handlers, not named function exports.)
 */
export default {
    /**
     * GET /voices?provider=<id> — the voices the given provider offers, so the
     * settings UI can repopulate the voice dropdown when the provider changes.
     * Each provider owns its own list (see getVoicesForProvider).
     */
    async getVoices({ query }: { query: Record<string, string> }): Promise<{ value: string; name: string }[]> {
        const provider = query?.provider || DEFAULT_VOICE_PROVIDER;
        return getVoicesForProvider(provider);
    },
};
