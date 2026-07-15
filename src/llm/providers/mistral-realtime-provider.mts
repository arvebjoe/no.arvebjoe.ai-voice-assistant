import { LocalPipelineProvider, PipelineBuild } from "./local-pipeline-provider.mjs";
import { MistralRealtimeSttClient } from "./local/mistral-realtime-stt-client.mjs";
import { MistralClient } from "./local/mistral-client.mjs";
import { MistralTtsClient } from "./local/mistral-tts-client.mjs";
import { settingsManager } from "../../settings/settings-manager.mjs";

/**
 * First-class Mistral voice provider (`voice_provider: 'mistral-realtime'`).
 *
 * Mistral has no unified speech-to-speech realtime API (like OpenAI Realtime
 * or Gemini Live); their own reference design for voice agents is a chained
 * pipeline. This provider hardwires that Mistral-native chain — all three
 * stages on one Mistral account, one API key:
 *
 *   mic 16 kHz -> Voxtral Realtime STT (websocket, transcribes while you talk)
 *              -> Mistral chat completions (tools, streaming)
 *              -> Voxtral TTS (24 kHz WAV)
 *
 * All orchestration (VAD, streaming STT session, tool loop, sentence-by-
 * sentence TTS) is inherited from LocalPipelineProvider; only the stage
 * construction differs. The settings are the SAME `mistral_*` keys the custom
 * pipeline's Mistral backends use — deliberately, so one key/model set serves
 * both, and the custom pipeline keeps offering Mistral for mix-and-match
 * setups (e.g. Voxtral STT + a local Ollama LLM).
 */
export class MistralRealtimeProvider extends LocalPipelineProvider {
    // All three stages ride on the shared Mistral key; the device watches this
    // setting and restarts the provider when it changes.
    override readonly apiKeySettingKey: string = "mistral_api_key";

    /** Voices come from Mistral's live voice library (GET /v1/audio/voices). */
    static async getAvailableVoices(): Promise<{ value: string; name: string }[]> {
        return LocalPipelineProvider.getAvailableVoices('mistral');
    }

    protected override loggerName(): string {
        return "MISTRAL";
    }

    protected override buildPipeline(): PipelineBuild {
        const s = (key: string): string => String(settingsManager.getGlobal<string>(key, '') ?? '').trim();
        const config = {
            apiKey: s('mistral_api_key'),
            sttModel: s('mistral_stt_realtime_model'),
            llmModel: s('mistral_model'),
            ttsModel: s('mistral_tts_model'),
        };
        return {
            stt: new MistralRealtimeSttClient({ apiKey: config.apiKey, model: config.sttModel }),
            llm: new MistralClient({ apiKey: config.apiKey, model: config.llmModel }),
            tts: new MistralTtsClient({ apiKey: config.apiKey, model: config.ttsModel, voice: this.options.voice }),
            configJson: JSON.stringify(config),
        };
    }
}
