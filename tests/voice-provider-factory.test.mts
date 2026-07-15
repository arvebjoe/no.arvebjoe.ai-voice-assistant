import { describe, it, expect, beforeEach } from 'vitest';
import {
    createVoiceProvider,
    getVoicesForProvider,
    DEFAULT_VOICE_PROVIDER,
} from '../src/llm/voice-provider-factory.mjs';
import { OpenAIRealtimeProvider } from '../src/llm/providers/openai-realtime-agent.mjs';
import { GeminiLiveProvider } from '../src/llm/providers/gemini-live-provider.mjs';
import { LocalPipelineProvider } from '../src/llm/providers/local-pipeline-provider.mjs';
import { MistralRealtimeProvider } from '../src/llm/providers/mistral-realtime-provider.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

// The factory only passes the toolManager through to the provider constructor,
// which stores it without calling anything — a bare stub is sufficient.
const toolManager: any = {};

describe('voice-provider-factory', () => {
    let homey: MockHomey;

    beforeEach(() => {
        settingsManager.reset();
        homey = new MockHomey();
        homey.setMockSetting('openai_api_key', 'openai-secret');
        homey.setMockSetting('gemini_api_key', 'gemini-secret');
        homey.setMockSetting('mistral_api_key', 'mistral-secret');
        settingsManager.init(homey as any);
    });

    it('defaults to the OpenAI provider and resolves the OpenAI key', () => {
        const opts: any = {};
        const provider = createVoiceProvider(homey as any, toolManager, opts);
        expect(provider).toBeInstanceOf(OpenAIRealtimeProvider);
        expect(opts.apiKey).toBe('openai-secret');
    });

    it('constructs the Gemini provider on explicit request and resolves the Gemini key', () => {
        const opts: any = {};
        const provider = createVoiceProvider(homey as any, toolManager, opts, 'gemini-realtime');
        expect(provider).toBeInstanceOf(GeminiLiveProvider);
        expect(opts.apiKey).toBe('gemini-secret');
    });

    it('follows the voice_provider global setting when no id is passed', () => {
        homey.setMockSetting('voice_provider', 'gemini-realtime');
        const provider = createVoiceProvider(homey as any, toolManager, {} as any);
        expect(provider).toBeInstanceOf(GeminiLiveProvider);
    });

    it('lets an explicit id override the global setting', () => {
        homey.setMockSetting('voice_provider', 'gemini-realtime');
        const provider = createVoiceProvider(homey as any, toolManager, {} as any, 'openai-realtime');
        expect(provider).toBeInstanceOf(OpenAIRealtimeProvider);
    });

    it('constructs the Mistral provider on request and resolves the shared Mistral key', () => {
        const opts: any = {};
        const provider = createVoiceProvider(homey as any, toolManager, opts, 'mistral-realtime');
        expect(provider).toBeInstanceOf(MistralRealtimeProvider);
        // The Mistral provider IS a pipeline under the hood (hardwired stages).
        expect(provider).toBeInstanceOf(LocalPipelineProvider);
        expect(opts.apiKey).toBe('mistral-secret');
        expect(provider.apiKeySettingKey).toBe('mistral_api_key');
        expect(provider.hasApiKey()).toBe(true);
        (provider as MistralRealtimeProvider).destroy();
    });

    it('constructs the keyless local provider on request', () => {
        const opts: any = {};
        const provider = createVoiceProvider(homey as any, toolManager, opts, 'local');
        expect(provider).toBeInstanceOf(LocalPipelineProvider);
        // No API-key setting exists for the local pipeline — resolves to ''.
        expect(opts.apiKey).toBe('');
        expect(provider.hasApiKey()).toBe(true);
        (provider as LocalPipelineProvider).destroy();
    });

    it('falls back to OpenAI (with the OpenAI key) for an unknown provider id', () => {
        const opts: any = {};
        const provider = createVoiceProvider(homey as any, toolManager, opts, 'does-not-exist');
        expect(provider).toBeInstanceOf(OpenAIRealtimeProvider);
        expect(opts.apiKey).toBe('openai-secret');
    });

    it('DEFAULT_VOICE_PROVIDER is the OpenAI id', () => {
        expect(DEFAULT_VOICE_PROVIDER).toBe('openai-realtime');
    });

    describe('getVoicesForProvider', () => {
        it('returns distinct, non-empty lists per provider', async () => {
            const openai = await getVoicesForProvider('openai-realtime');
            const gemini = await getVoicesForProvider('gemini-realtime');
            const local = await getVoicesForProvider('local');
            expect(openai.length).toBeGreaterThan(0);
            expect(gemini.length).toBeGreaterThan(0);
            expect(local.length).toBeGreaterThan(0);
            for (const v of [...openai, ...gemini, ...local]) {
                expect(v).toHaveProperty('value');
                expect(v).toHaveProperty('name');
            }
        });

        it('falls back to the OpenAI list for an unknown provider id', async () => {
            expect(await getVoicesForProvider('nope')).toEqual(await getVoicesForProvider('openai-realtime'));
        });

        it('serves the Voxtral sentinel for the Mistral provider when the voice list is unavailable', async () => {
            // No live fetch in unit tests: the list probe fails and the
            // dropdown still gets its single sentinel entry.
            homey.setMockSetting('mistral_api_key', '');
            const voices = await getVoicesForProvider('mistral-realtime');
            expect(voices.map((v) => v.value)).toEqual(['']);
        });
    });
});
