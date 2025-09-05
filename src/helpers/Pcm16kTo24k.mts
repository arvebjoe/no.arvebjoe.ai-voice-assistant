// Simple streaming upsampler: 16 kHz PCM s16le mono -> 24 kHz PCM s16le mono.
// - Linear interpolation (robust for STT)
// - Stable across arbitrary chunk sizes
// - Emits fixed-size frames (default: 20 ms @ 24 kHz = 480 samples = 960 bytes)

type InterpMethod = "linear" | "cubic";

export interface ResamplerOptions {
    outRate?: number; // Output sample rate. Default 24000
    frameDurationMs?: number; // Frame duration in milliseconds. Default 20 ms.
    method?: InterpMethod;
}

export class Pcm16kTo24k {
    private readonly inRate = 16000;
    private readonly outRate: number;
    private readonly method: InterpMethod;
    private readonly step: number;                 // source advance per output sample
    private readonly frameSamples: number;
    private readonly frameBytes: number;

    private resamplePrev: number | null = null;    // last source sample from previous chunk
    private resampleFrac = 0;                      // fractional source position [0, step)
    private txBuf = Buffer.alloc(0);               // accumulates 24 kHz bytes until full frames

    // (optional) sanity counters
    private inTotal = 0;
    private outTotal = 0;

    constructor(opts: ResamplerOptions = {}) {
        this.outRate = opts.outRate ?? 24000;
        this.method = opts.method ?? "linear";

        const frameMs = opts.frameDurationMs ?? 20;

        if (this.outRate < 24000) {
            throw new Error(`outRate must be >= 24000 for most realtime endpoints. Got ${this.outRate}.`);
        }
        this.step = this.inRate / this.outRate; // e.g., 16000/24000 = 2/3

        this.frameSamples = Math.max(1, Math.round(this.outRate * frameMs / 1000)); // 24k * 20ms = 480
        this.frameBytes = this.frameSamples * 2; // s16le mono
    }

    /** Push a chunk of 16 kHz PCM (s16le mono). Returns zero or more 24 kHz frames. */
    push(pcm16k: Buffer): Array<Buffer> {
        if (!pcm16k || pcm16k.length < 2) return [];

        // Ensure even number of bytes (int16). Drop last odd byte if any.
        if (pcm16k.length & 1) pcm16k = pcm16k.subarray(0, pcm16k.length - 1);

        const inSamples = pcm16k.length >>> 1;
        this.inTotal += inSamples;

        // --- Resample 16k -> outRate (default 24k) using linear interpolation ---
        const havePrefix = this.resamplePrev !== null ? 1 : 0;
        const total = inSamples + havePrefix;     // virtual source length including prefix sample
        const last = total - 1;

        const readRaw = (j: number) => pcm16k.readInt16LE(j << 1); // 0..inSamples-1
        const readSample = (i: number): number => {
            // i in [0..last], where 0 may be the saved prefix
            if (havePrefix && i === 0) return this.resamplePrev as number;
            const j = i - havePrefix;                        // 0..inSamples-1
            const jj = j < 0 ? 0 : (j >= inSamples ? inSamples - 1 : j); // clamp for safety
            return readRaw(jj);
        };

        let pos = this.resampleFrac;                       // fractional position in source samples
        // Conservative capacity to avoid reallocation
        let cap = Math.ceil(inSamples * (this.outRate / this.inRate) + 8);
        let out = new Int16Array(cap);
        let outIdx = 0;

        const put = (v: number) => {
            if (outIdx >= cap) {
                cap = (cap * 3) >> 1; // grow ×1.5
                const g = new Int16Array(cap);
                g.set(out, 0);
                out = g;
            }
            out[outIdx++] = v;
        };

        // Generate output samples until we cannot safely interpolate
        while (pos < last) {
            const i = pos | 0;
            const frac = pos - i;

            let s: number;
            if (this.method === "cubic" && i > 0 && i + 2 <= last) {
                // Cubic Hermite (Catmull–Rom), with edge guard
                const p0 = readSample(i - 1);
                const p1 = readSample(i);
                const p2 = readSample(i + 1);
                const p3 = readSample(i + 2);
                const m1 = 0.5 * (p2 - p0);
                const m2 = 0.5 * (p3 - p1);
                const t = frac, t2 = t * t, t3 = t2 * t;
                s = (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1
                    + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2;
            } else {
                // Linear (default, robust)
                const s0 = readSample(i);
                const s1 = readSample(Math.min(i + 1, last));
                s = s0 + (s1 - s0) * frac;
            }

            let v = Math.round(s);
            if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
            put(v);
            pos += this.step;
        }

        // Persist edge state for next call
        this.resamplePrev = readSample(last);
        this.resampleFrac = pos - last;      // carry fractional position into next chunk

        // Pack output to bytes and accumulate for framing
        const outBytes = Buffer.allocUnsafe(outIdx << 1);
        for (let k = 0; k < outIdx; k++) outBytes.writeInt16LE(out[k], k << 1);
        this.outTotal += outIdx;

        this.txBuf = Buffer.concat([this.txBuf, outBytes]);

        // Slice into fixed-size frames
        const frames: Array<Buffer> = [];
        while (this.txBuf.length >= this.frameBytes) {
            const frame = this.txBuf.subarray(0, this.frameBytes);
            this.txBuf = this.txBuf.subarray(this.frameBytes);
            frames.push(frame);
        }
        return frames;
    }

    /** Flush any remaining partial bytes as a final (short) frame. Usually you don't need this. */
    flushRemainder(): Buffer | null {
        if (this.txBuf.length === 0) return null;
        const b = this.txBuf;
        this.txBuf = Buffer.alloc(0);
        return b;
    }

    /** Optional: quick sanity to check the long-run ratio ~ outRate/inRate (should be ~1.5 for 24k). */
    getResampleRatio(): number {
        return this.outTotal / Math.max(1, this.inTotal);
    }

    reset() {
        this.resamplePrev = null;
        this.resampleFrac = 0;
        this.txBuf = Buffer.alloc(0);
        this.inTotal = 0;
        this.outTotal = 0;
    }
}
