import { getVoicesForProvider, DEFAULT_VOICE_PROVIDER } from './src/llm/voice-provider-factory.mjs';
import { testLocalStage, StageTestRequest, StageTestResult } from './src/llm/providers/local/stage-tester.mjs';
import { getLmStudioContext, LmStudioContextResult } from './src/llm/providers/local/lmstudio-context.mjs';
import { computeFeatureCosts, FeatureCostReport } from './src/settings/feature-costs.mjs';

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
     * GET /voices?provider=<id>[&tts=<backend>] — the voices the given provider
     * offers, so the settings UI can repopulate the voice dropdown when the
     * provider (or, for the local provider, its TTS backend) changes. Each
     * provider owns its own list (see getVoicesForProvider).
     */
    async getVoices({ query }: { query: Record<string, string> }): Promise<{ value: string; name: string }[]> {
        const provider = query?.provider || DEFAULT_VOICE_PROVIDER;
        return getVoicesForProvider(provider, query?.tts || undefined);
    },

    /**
     * POST /test-local-stage — test one local-pipeline stage (stt/llm/tts)
     * against the CURRENT (possibly unsaved) settings-form values. Runs from
     * the Homey box because the settings webview can't reach LAN services
     * itself. Never throws — failures come back as { ok:false, message }.
     */
    async testLocalStage({ body }: { body: StageTestRequest }): Promise<StageTestResult> {
        return testLocalStage(body);
    },

    /**
     * GET /lmstudio-context?host=<h>&port=<p>&model=<id> — the context window
     * of the LM Studio model the pipeline would use, read live from LM
     * Studio's REST API with the CURRENT (possibly unsaved) settings-form
     * values, so the budget meter can give a real verdict for the lmstudio
     * backend. Never throws — failures come back as { ok:false, message }.
     */
    async getLmStudioContext({ query }: { query: Record<string, string> }): Promise<LmStudioContextResult> {
        return getLmStudioContext({ host: query?.host, port: query?.port, model: query?.model });
    },

    /**
     * GET /feature-costs?language=<code>&name=<language name> — per-feature
     * LLM context costs (approximate tokens) computed live from the real
     * instruction modules and tool definitions, for the settings page's
     * budget panel. See docs/cost-of-growth.md.
     */
    async getFeatureCosts({ homey, query }: { homey: any; query: Record<string, string> }): Promise<FeatureCostReport> {
        const app = homey.app as any;
        return computeFeatureCosts(
            {
                homey,
                deviceManager: app.deviceManager,
                geoHelper: app.geoHelper,
                weatherHelper: app.weatherHelper,
            },
            query?.language || 'en',
            query?.name || 'English',
        );
    },
};
