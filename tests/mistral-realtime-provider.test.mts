import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MistralRealtimeProvider } from '../src/llm/providers/mistral-realtime-provider.mjs';
import { MistralRealtimeSttClient } from '../src/llm/providers/local/mistral-realtime-stt-client.mjs';
import { MistralClient } from '../src/llm/providers/local/mistral-client.mjs';
import { MistralTtsClient } from '../src/llm/providers/local/mistral-tts-client.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { fakeToolManager } from './mocks/mock-tool-manager.mjs';

const baseOpts = {
    apiKey: '',
    voice: '',
    languageCode: 'en',
    languageName: 'English',
    additionalInstructions: '',
    deviceZone: 'Office',
    supportsTimers: false,
};

const toolManager = fakeToolManager({}, []);
const applySettings = () => settingsManager.flushGlobalsEmit();

let homey: MockHomey;
let provider: MistralRealtimeProvider | null = null;

describe('MistralRealtimeProvider', () => {
    beforeEach(() => {
        settingsManager.reset();
        homey = new MockHomey();
        homey.setMockSetting('mistral_api_key', 'sk-mistral');
        settingsManager.init(homey as any);
    });

    afterEach(() => {
        try { (provider as any)?.destroy?.(); } catch { /* ignore */ }
        provider = null;
    });

    it('hardwires all three stages to Mistral on the shared key', () => {
        provider = new MistralRealtimeProvider(homey as any, toolManager as any, { ...baseOpts });
        expect((provider as any).stt).toBeInstanceOf(MistralRealtimeSttClient);
        expect((provider as any).llm).toBeInstanceOf(MistralClient);
        expect((provider as any).tts).toBeInstanceOf(MistralTtsClient);
        expect(provider.hasApiKey()).toBe(true);
        // The device watches this setting for key changes, and feeds 16 kHz
        // mic PCM straight through (no resampler).
        expect(provider.apiKeySettingKey).toBe('mistral_api_key');
        expect(provider.inputSampleRate).toBe(16000);
    });

    it('reads the shared mistral_* model settings (same keys as the custom pipeline)', () => {
        homey.setMockSetting('mistral_stt_realtime_model', 'rt-model');
        homey.setMockSetting('mistral_model', 'chat-model');
        homey.setMockSetting('mistral_tts_model', 'tts-model');
        provider = new MistralRealtimeProvider(homey as any, toolManager as any, { ...baseOpts });
        expect((provider as any).stt.describe()).toBe('mistral-realtime-stt=rt-model');
        expect((provider as any).llm.describe()).toBe('mistral=chat-model');
        expect((provider as any).tts.describe()).toBe('mistral-tts=tts-model');
    });

    it('rebuilds the stages when a mistral_* setting changes', () => {
        provider = new MistralRealtimeProvider(homey as any, toolManager as any, { ...baseOpts });
        // The rebuild fires a background health re-probe whose failure emits
        // 'error' — sink it so the emitter doesn't throw in the test.
        (provider as any).on('error', () => { });
        const before = (provider as any).llm;
        homey.setMockSetting('mistral_model', 'mistral-medium-latest');
        applySettings();
        expect((provider as any).llm).not.toBe(before);
        expect((provider as any).llm.describe()).toBe('mistral=mistral-medium-latest');
        // An unrelated custom-pipeline setting must NOT rebuild the stages.
        const pinned = (provider as any).llm;
        homey.setMockSetting('local_llm_host', '10.0.0.9');
        applySettings();
        expect((provider as any).llm).toBe(pinned);
    });

    it('emits missing_api_key on start when the Mistral key is not set', async () => {
        homey.setMockSetting('mistral_api_key', '');
        provider = new MistralRealtimeProvider(homey as any, toolManager as any, { ...baseOpts });
        expect(provider.hasApiKey()).toBe(false);
        const spy = vi.fn();
        (provider as any).on('missing_api_key', spy);
        await provider.start();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(provider.isConnected()).toBe(false);
    });

    it('routes the selected voice to the Voxtral TTS stage', () => {
        provider = new MistralRealtimeProvider(homey as any, toolManager as any, { ...baseOpts });
        provider.updateVoice('530e2e20-58e2-45d8-b0a5-4594f4915944');
        expect(((provider as any).tts as any).config.voice).toBe('530e2e20-58e2-45d8-b0a5-4594f4915944');
    });

    it('offers the Voxtral voice library (sentinel without a key, live list with one)', async () => {
        homey.setMockSetting('mistral_api_key', '');
        expect((await MistralRealtimeProvider.getAvailableVoices()).map((v) => v.value)).toEqual(['']);

        homey.setMockSetting('mistral_api_key', 'sk-mistral-provider-voices');
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                items: [{ id: '530e2e20-58e2-45d8-b0a5-4594f4915944', name: 'Paul - Sad', slug: 'en_paul_sad', languages: ['en_us'] }],
                total: 1,
            }),
        })));
        try {
            expect(await MistralRealtimeProvider.getAvailableVoices()).toEqual([
                { value: '530e2e20-58e2-45d8-b0a5-4594f4915944', name: 'Paul - Sad (EN-US)' },
            ]);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
