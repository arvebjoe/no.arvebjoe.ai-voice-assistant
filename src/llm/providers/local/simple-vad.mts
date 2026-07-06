/**
 * Energy-based voice activity detector for the local pipeline.
 *
 * The cloud providers (OpenAI Realtime, Gemini Live) run server-side VAD; a
 * local Whisper deployment is a plain one-shot transcription endpoint, so the
 * end-of-utterance decision has to be made here, on the 16 kHz mic PCM the
 * device streams in. This is deliberately simple (frame RMS against an
 * adaptive noise floor) — mis-trips are tolerated by the device's existing
 * spurious-VAD retry budget in TurnStateMachine.
 *
 * Usage per turn: construct (or reset()), feed() every mic chunk, and act on
 * the returned events:
 *   - speechStart: first frame above threshold (device flips the LED ring)
 *   - utterance:   speech followed by `silenceMs` of quiet — the full clip
 *                  (with pre-roll) to hand to STT
 *   - timeout:     no speech within `noSpeechTimeoutMs` of the first chunk
 * After an utterance/timeout the detector goes inert until reset().
 */

export interface SimpleVadOptions {
    sampleRate?: number;        // default 16000
    frameMs?: number;           // analysis window, default 20 ms
    /** Floor for the speech threshold (int16 RMS). */
    minSpeechRms?: number;      // default 500
    /** Speech threshold = clamp(noiseFloor * noiseFactor, minSpeechRms, maxSpeechRms). */
    noiseFactor?: number;       // default 2.5
    maxSpeechRms?: number;      // default 6000
    /** Quiet needed after speech to close the utterance. */
    silenceMs?: number;         // default 800
    /** Speech shorter than this doesn't arm the silence countdown (clicks/pops). */
    minSpeechMs?: number;       // default 200
    /** Audio kept from before the detected speech start. */
    preRollMs?: number;         // default 300
    /** Give up when the user never speaks. */
    noSpeechTimeoutMs?: number; // default 8000
    /** Hard cap — close the utterance even if the user is still talking. */
    maxUtteranceMs?: number;    // default 25000
}

export interface VadResult {
    speechStart: boolean;
    /** Set when the utterance closed (end-of-speech or max length). PCM16 mono at the input rate. */
    utterance: Buffer | null;
    /** Set when no speech arrived within the timeout. */
    timeout: boolean;
}

export class SimpleVad {
    private readonly sampleRate: number;
    private readonly frameBytes: number;
    private readonly minSpeechRms: number;
    private readonly noiseFactor: number;
    private readonly maxSpeechRms: number;
    private readonly silenceFrames: number;
    private readonly minSpeechFrames: number;
    private readonly preRollBytes: number;
    private readonly timeoutFrames: number;
    private readonly maxUtteranceFrames: number;

    private pending: Buffer = Buffer.alloc(0);   // partial frame carry-over
    private preRoll: Buffer[] = [];      // rolling window before speech
    private preRollLen = 0;
    private captured: Buffer[] = [];     // frames since speech start
    private noiseFloor = 200;            // adaptive quiet-level estimate (int16 RMS)
    private speechActive = false;
    private speechFrames = 0;
    private quietFrames = 0;
    private totalFrames = 0;
    private utteranceFrames = 0;
    private finished = false;

    constructor(opts: SimpleVadOptions = {}) {
        this.sampleRate = opts.sampleRate ?? 16000;
        const frameMs = opts.frameMs ?? 20;
        this.frameBytes = Math.round(this.sampleRate * frameMs / 1000) * 2;
        this.minSpeechRms = opts.minSpeechRms ?? 500;
        this.noiseFactor = opts.noiseFactor ?? 2.5;
        this.maxSpeechRms = opts.maxSpeechRms ?? 6000;
        this.silenceFrames = Math.ceil((opts.silenceMs ?? 800) / frameMs);
        this.minSpeechFrames = Math.ceil((opts.minSpeechMs ?? 200) / frameMs);
        this.preRollBytes = Math.round(this.sampleRate * (opts.preRollMs ?? 300) / 1000) * 2;
        this.timeoutFrames = Math.ceil((opts.noSpeechTimeoutMs ?? 8000) / frameMs);
        this.maxUtteranceFrames = Math.ceil((opts.maxUtteranceMs ?? 25000) / frameMs);
    }

    /** Ready the detector for a new turn. */
    reset(): void {
        this.pending = Buffer.alloc(0);
        this.preRoll = [];
        this.preRollLen = 0;
        this.captured = [];
        this.speechActive = false;
        this.speechFrames = 0;
        this.quietFrames = 0;
        this.totalFrames = 0;
        this.utteranceFrames = 0;
        this.finished = false;
        // Keep the learned noiseFloor across turns — the room doesn't change.
    }

    /** Feed mic PCM (any chunk size). */
    feed(chunk: Buffer): VadResult {
        const result: VadResult = { speechStart: false, utterance: null, timeout: false };
        if (this.finished || chunk.length === 0) return result;

        this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;

        while (this.pending.length >= this.frameBytes && !this.finished) {
            const frame = this.pending.subarray(0, this.frameBytes);
            this.pending = this.pending.subarray(this.frameBytes);
            this.processFrame(frame, result);
        }
        return result;
    }

    private processFrame(frame: Buffer, result: VadResult): void {
        this.totalFrames++;
        const rms = this.frameRms(frame);
        const threshold = Math.min(this.maxSpeechRms, Math.max(this.minSpeechRms, this.noiseFloor * this.noiseFactor));
        const isSpeech = rms >= threshold;

        if (!isSpeech) {
            // Track the quiet level so a noisy room raises the bar. Slow EMA,
            // and only on sub-threshold frames so speech can't drag it up.
            this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
        }

        if (!this.speechActive) {
            if (isSpeech) {
                this.speechActive = true;
                this.speechFrames = 1;
                this.quietFrames = 0;
                this.utteranceFrames = 0;
                this.captured = [Buffer.from(frame)];
                result.speechStart = true;
            } else {
                // Rolling pre-roll so the first syllable isn't clipped.
                this.preRoll.push(Buffer.from(frame));
                this.preRollLen += frame.length;
                while (this.preRollLen > this.preRollBytes && this.preRoll.length) {
                    this.preRollLen -= this.preRoll[0].length;
                    this.preRoll.shift();
                }
                if (this.totalFrames >= this.timeoutFrames) {
                    this.finished = true;
                    result.timeout = true;
                }
            }
            return;
        }

        // Speech is active: capture everything (including the quiet tail).
        this.captured.push(Buffer.from(frame));
        this.utteranceFrames++;
        if (isSpeech) {
            this.speechFrames++;
            this.quietFrames = 0;
        } else {
            this.quietFrames++;
        }

        const hadRealSpeech = this.speechFrames >= this.minSpeechFrames;
        if (!hadRealSpeech && this.quietFrames >= this.silenceFrames) {
            // A short click/pop, then quiet — treat it as if nothing happened
            // (fold the false start into the pre-roll and keep waiting).
            for (const f of this.captured) {
                this.preRoll.push(f);
                this.preRollLen += f.length;
            }
            while (this.preRollLen > this.preRollBytes && this.preRoll.length) {
                this.preRollLen -= this.preRoll[0].length;
                this.preRoll.shift();
            }
            this.captured = [];
            this.speechActive = false;
            this.speechFrames = 0;
            this.quietFrames = 0;
            return;
        }

        if ((hadRealSpeech && this.quietFrames >= this.silenceFrames) || this.utteranceFrames >= this.maxUtteranceFrames) {
            this.finished = true;
            result.utterance = Buffer.concat([...this.preRoll, ...this.captured]);
        }
    }

    private frameRms(frame: Buffer): number {
        const samples = frame.length >>> 1;
        if (!samples) return 0;
        let sum = 0;
        for (let i = 0; i < samples; i++) {
            const v = frame.readInt16LE(i << 1);
            sum += v * v;
        }
        return Math.sqrt(sum / samples);
    }
}
