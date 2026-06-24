import { IVoiceProvider, VoiceProviderOptions } from './voice-provider.mjs';
import { OpenAIRealtimeProvider } from './openai-realtime-agent.mjs';
import { ToolManager } from './tool-manager.mjs';
import { settingsManager } from '../settings/settings-manager.mjs';
import { createLogger } from '../helpers/logger.mjs';

const logger = createLogger('VoiceProviderFactory');

/** Default provider id used when nothing is configured. */
export const DEFAULT_VOICE_PROVIDER = 'openai-realtime';

/**
 * Construct the voice/LLM provider for a device.
 *
 * Selection order: explicit `providerId` argument, then the `voice_provider`
 * global setting, then the default. Unknown ids fall back to OpenAI with a
 * warning rather than throwing — the device must always get a usable provider.
 */
export function createVoiceProvider(
    homey: any,
    toolManager: ToolManager,
    options: VoiceProviderOptions,
    providerId?: string,
): IVoiceProvider {
    const id = providerId ?? settingsManager.getGlobal<string>('voice_provider', DEFAULT_VOICE_PROVIDER);

    switch (id) {
        case 'openai-realtime':
            return new OpenAIRealtimeProvider(homey, toolManager, options);

        default:
            logger.warn(`Unknown voice provider '${id}', falling back to '${DEFAULT_VOICE_PROVIDER}'`);
            return new OpenAIRealtimeProvider(homey, toolManager, options);
    }
}
