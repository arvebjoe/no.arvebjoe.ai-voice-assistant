/**
 * Backend-neutral STT seam inside the local pipeline (mirror of llm-client.mts).
 *
 * The pipeline's speech-to-text stage is pluggable (`local_stt_provider`
 * global setting): a Whisper server on the LAN or Mistral's cloud Voxtral
 * transcription API. Input is always the VAD's utterance clip — PCM16 mono
 * 16 kHz — and output is the plain transcript text.
 */
export interface ISttClient {
    /** Enough settings present to even try (host set / API key set). */
    isConfigured(): boolean;
    /** False only when the backend needs an API key and none is set. */
    hasCredentials(): boolean;
    /** Health probe. Throws when the backend is unreachable/unauthorized. */
    check(): Promise<void>;
    /** Human-readable target for log lines (URL or model id). */
    describe(): string;
    /** Transcribe an utterance (may return '' when nothing intelligible was heard). */
    transcribe(pcm16k: Buffer, languageCode: string): Promise<string>;
    /**
     * Optional streaming mode: open a per-utterance session that transcribes
     * WHILE the audio arrives, so the transcript is (nearly) done the moment
     * the user stops talking. The pipeline uses it when present (opened at
     * VAD speech start, finished at end-of-utterance) and falls back to
     * `transcribe()` otherwise — backends without it are batch-only.
     */
    createStream?(languageCode: string, onDelta?: (text: string) => void): ISttStream;
}

/** One live streaming-transcription session (one utterance). */
export interface ISttStream {
    /** Feed mic PCM (16 kHz mono) as it arrives. Safe before the socket is ready (buffered). */
    append(pcm16k: Buffer): void;
    /** No more audio: flush the backend and resolve the final transcript. */
    finish(): Promise<string>;
    /** Drop the session without a result (turn aborted / VAD timeout). */
    abort(): void;
}
