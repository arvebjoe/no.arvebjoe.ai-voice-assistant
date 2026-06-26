import { IVoiceProvider, VoiceProviderOptions } from './voice-provider.mjs';
import { OpenAIRealtimeProvider } from './providers/openai-realtime-agent.mjs';
import { GeminiLiveProvider } from './providers/gemini-live-provider.mjs';
import { ToolManager } from './tool-manager.mjs';
import { settingsManager } from '../settings/settings-manager.mjs';
import { createLogger } from '../helpers/logger.mjs';

const logger = createLogger('VoiceProviderFactory');

/** Default provider id used when nothing is configured. */
export const DEFAULT_VOICE_PROVIDER = 'openai-realtime';

/** Which global setting holds each provider's API key. */
const API_KEY_SETTING: Record<string, string> = {
    'openai-realtime': 'openai_api_key',
    'gemini-realtime': 'gemini_api_key',
};

/**
 * Voices each provider offers, for the settings UI. Each provider owns its own
 * list (single source of truth); unknown ids fall back to the default provider's
 * list so the dropdown is never empty.
 */
export function getVoicesForProvider(providerId: string): { value: string; name: string }[] {
    switch (providerId) {
        case 'openai-realtime':
            return OpenAIRealtimeProvider.getAvailableVoices();
        case 'gemini-realtime':
            return GeminiLiveProvider.getAvailableVoices();
        default:
            return OpenAIRealtimeProvider.getAvailableVoices();
    }
}

/**
 * Construct the voice/LLM provider for a device.
 *
 * Selection order: explicit `providerId` argument, then the `voice_provider`
 * global setting, then the default. Unknown ids fall back to OpenAI with a
 * warning rather than throwing — the device must always get a usable provider.
 *
 * The factory is authoritative for `options.apiKey`: it resolves the key from
 * the setting that belongs to the chosen provider (so the same options object
 * the device holds ends up with the right key for `handleSettingsChange`).
 */
export function createVoiceProvider(
    homey: any,
    toolManager: ToolManager,
    options: VoiceProviderOptions,
    providerId?: string,
): IVoiceProvider {
    const id = providerId ?? settingsManager.getGlobal<string>('voice_provider', DEFAULT_VOICE_PROVIDER);

    // Resolve the API key from the setting that belongs to this provider.
    const keyName = API_KEY_SETTING[id] ?? API_KEY_SETTING[DEFAULT_VOICE_PROVIDER];
    options.apiKey = settingsManager.getGlobal<string>(keyName, '');

    switch (id) {
        case 'openai-realtime':
            return new OpenAIRealtimeProvider(homey, toolManager, options);

        case 'gemini-realtime':
            return new GeminiLiveProvider(homey, toolManager, options);

        default:
            logger.warn(`Unknown voice provider '${id}', falling back to '${DEFAULT_VOICE_PROVIDER}'`);
            options.apiKey = settingsManager.getGlobal<string>(API_KEY_SETTING[DEFAULT_VOICE_PROVIDER], '');
            return new OpenAIRealtimeProvider(homey, toolManager, options);
    }
}
