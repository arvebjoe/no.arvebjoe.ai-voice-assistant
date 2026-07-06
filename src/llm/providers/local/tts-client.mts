/**
 * Backend-neutral TTS seam inside the local pipeline (mirror of llm-client.mts).
 *
 * The pipeline's text-to-speech stage is pluggable (`local_tts_provider`
 * global setting): a Piper server on the LAN or Mistral's cloud Voxtral TTS.
 * Output is PCM16 mono at the backend's native rate — the provider resamples
 * to the app's 24 kHz reply contract itself.
 */
export interface ITtsClient {
    /** Enough settings present to even try (host set / API key set). */
    isConfigured(): boolean;
    /** False only when the backend needs an API key and none is set. */
    hasCredentials(): boolean;
    /** Health probe. Throws when the backend is unreachable/unauthorized. */
    check(): Promise<void>;
    /** Human-readable target for log lines (URL or model id). */
    describe(): string;
    /** Synthesize text to PCM16 mono at the backend's native sample rate. */
    synthesize(text: string, signal?: AbortSignal): Promise<{ pcm: Buffer; sampleRate: number }>;
    /**
     * Apply the app's `selected_voice` setting. Optional: Piper's voice is fixed
     * server-side, while Voxtral picks one of its preset voices per request.
     */
    setVoice?(voice: string): void;
}
