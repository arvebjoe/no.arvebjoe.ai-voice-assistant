import { TypedEmitter } from "tiny-typed-emitter";

/**
 * Provider-agnostic voice/LLM abstraction.
 *
 * `IVoiceProvider` is the seam between the device (`voice-assistant-device.mts`)
 * and a concrete backend. Today the only implementation is the OpenAI Realtime
 * agent, but the contract is deliberately backend-neutral so a provider can be:
 *   - a single realtime speech-in / speech-out WebSocket (like OpenAI Realtime), or
 *   - a composed pipeline (e.g. local Whisper STT -> Claude/Ollama LLM -> Piper/OpenAI TTS),
 *     possibly mixing WebSocket and slower REST transports internally.
 *
 * The device treats the provider as a black box: it pushes microphone PCM in and
 * receives audio/text + tool calls out, plus lifecycle and on-the-fly settings updates.
 *
 * AUDIO CONTRACTS (current, provider-independent — keep these in sync if generalized):
 *   - `sendAudioChunk()` expects PCM16, mono, 24 kHz (the device resamples 16k->24k first).
 *   - `audio.delta` emits PCM16, mono, 24 kHz (the device segments then FLAC-encodes it).
 *   - `textToSpeech()` returns a FLAC-encoded buffer.
 * A future 16 kHz local pipeline would require device-side resample/encode changes.
 */
export type VoiceProviderEvents = {
    connected: () => void;
    open: () => void;
    close: (code: number, reason: string) => void;
    event: (message: any) => void;
    silence: (source: string) => void;
    error: (err: Error) => void;

    // Reconnection events
    reconnecting: (attempt: number, delay: number) => void;
    reconnected: () => void;
    reconnectFailed: (attempt: number, error: Error) => void;
    Healthy: () => void;
    Unhealthy: () => void;
    missing_api_key: () => void;

    "input_audio_buffer.committed": () => void;

    "session.updated": (msg: any) => void;

    "audio.delta": (chunk: Buffer) => void; // PCM16 mono 24 kHz
    "audio.done": () => void;

    "text.delta": (delta: string) => void;
    "text.done": (msg: any) => void;

    "transcript.delta": (delta: string) => void;        // ASSISTANT spoken-output transcript
    "transcript.done": (transcript: string) => void;     // USER input transcript (final)
    "input_transcript.delta": (delta: string) => void;   // USER input transcript (streaming)

    "response.output_item.added": () => void;
    "response.progress": () => void;
    "response.output_item.done": () => void;
    "response.done": () => void;
    "response.error": (msg: any) => void;

    "conversation.item.created": () => void;

    "tool.arguments.delta": (d: { callId: string; name?: string; delta: string }) => void;
    "tool.arguments.done": (d: { callId: string; name?: string; args: any }) => void;
    "tool.called": (d: { callId: string; name: string; args: any }) => void;
    "tool.call.started": (d: { callId: string; name?: string; itemId?: string }) => void;

    "rate_limits.updated": (msg: any) => void;
};

/**
 * Configuration passed when constructing a provider. Backend-neutral; a provider
 * is free to ignore fields it doesn't use (e.g. a local engine ignores `apiKey`).
 */
export type VoiceProviderOptions = {
    url?: string;
    apiKey?: string | null;
    voice: string;
    languageCode: string;   // e.g. 'no'
    languageName: string;   // e.g. 'Norwegian'
    additionalInstructions: string | null;
    deviceZone: string;
    supportsTimers?: boolean; // device advertised the TIMERS feature flag
};

/**
 * The contract every voice/LLM provider must satisfy. Mirrors exactly what the
 * device calls and listens to. All methods are required (the device guards some
 * with truthy checks, so a missing method would silently no-op).
 *
 * `restart`/`update*` are typed `Promise<void> | void` so providers may implement
 * them synchronously; the device awaits only where it needs to.
 */
export interface IVoiceProvider extends TypedEmitter<VoiceProviderEvents> {
    // --- provider-declared facts the device needs ---
    /**
     * Sample rate (Hz) this provider expects for `sendAudioChunk`. The PE mic is
     * 16 kHz; the device resamples up to this rate (or passes through at 16 kHz).
     * OpenAI Realtime = 24000, Gemini Live = 16000.
     */
    readonly inputSampleRate: number;
    /** Which global setting holds this provider's API key (e.g. 'openai_api_key'). */
    readonly apiKeySettingKey: string;

    // --- lifecycle ---
    start(): Promise<void>;
    close(code?: number, reason?: string): void;
    restart(): Promise<void> | void;
    isConnected(): boolean;
    hasApiKey(): boolean;

    // --- audio in / conversation ---
    sendAudioChunk(pcm16Mono24k: Buffer): void;
    resetConversation(): void;

    // --- text in / out ---
    sendTextForAudioResponse(text: string): void;
    sendTextForTextResponse(question: string): void;
    textToSpeech(text: string): Promise<Buffer>; // returns FLAC

    // --- on-the-fly settings updates ---
    updateApiKey(newApiKey: string): Promise<void> | void;
    updateVoice(newVoice: string): Promise<void> | void;
    updateLanguage(newLanguageCode: string, newLanguageName: string): Promise<void> | void;
    updateAdditionalInstructions(newAdditionalInstructions: string | null): Promise<void> | void;
    updateZone(newDeviceZone: string): Promise<void> | void;
    updateTimerSupport(supportsTimers: boolean): Promise<void> | void;
}
