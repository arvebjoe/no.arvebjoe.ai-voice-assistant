import { ChatMessage, ILlmClient, LlmChatResult, LlmToolDef } from './llm-client.mjs';
import { ITtsClient } from './tts-client.mjs';

/**
 * The "None" backends: pipeline stages that are switched off.
 *
 * Both are real clients rather than null checks scattered through the provider
 * — they satisfy the stage seams (always configured, always healthy, never
 * reach the network) so the pipeline's startup gates, health probes and
 * settings-rebuild path need no special cases. The provider only consults the
 * `noOp` marker where the *behaviour* differs (skip the round trip entirely).
 *
 * **None LLM** hands the conversation over to Homey Flows: the turn stops
 * after speech-to-text, the transcript goes out on the "Heard something"
 * trigger card, and whatever the user built in Flow decides what happens next
 * — including speaking a reply back through the "Say" action card, which still
 * uses the configured TTS backend. Requested on the forum by users who already
 * run their own agent/LLM orchestration and only want the satellite's ears.
 *
 * **None TTS** removes speech synthesis: the model still answers, but the reply
 * only leaves as text (the "Heard something"/"Thinking" trigger tokens), for
 * setups that speak it on some other speaker entirely. It also disables the
 * "Say" card and spoken replies — nothing in the app can produce audio without
 * a TTS backend, so `textToSpeech()` fails loudly instead of serving silence.
 */
export class NoneLlmClient implements ILlmClient {
    readonly noOp = true;

    isConfigured(): boolean { return true; }
    hasCredentials(): boolean { return true; }
    async check(): Promise<void> { /* nothing to reach */ }
    describe(): string { return 'none (transcript handed to Flows)'; }

    async chat(
        _messages: ChatMessage[],
        _tools: LlmToolDef[],
        _onDelta?: (delta: string) => void,
        _signal?: AbortSignal,
    ): Promise<LlmChatResult> {
        // Never actually called — the provider short-circuits on `noOp` before
        // building a prompt. Implemented anyway so the seam stays honest.
        return { content: '', toolCalls: [] };
    }
}

export class NoneTtsClient implements ITtsClient {
    readonly noOp = true;

    isConfigured(): boolean { return true; }
    hasCredentials(): boolean { return true; }
    async check(): Promise<void> { /* nothing to reach */ }
    describe(): string { return 'none (no speech)'; }

    async synthesize(_text: string): Promise<{ pcm: Buffer; sampleRate: number }> {
        // The sample rate is the app's reply contract; the buffer is empty, and
        // every consumer drops empty PCM without emitting audio.
        return { pcm: Buffer.alloc(0), sampleRate: 24000 };
    }
}
