import { describe, it, expect } from 'vitest';
import { Pcm16kTo24k } from '../src/helpers/Pcm16kTo24k.mjs';

// Helpers for building s16le mono PCM buffers.
function pcmFromSamples(samples: number[]): Buffer {
    const buf = Buffer.allocUnsafe(samples.length * 2);
    samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
    return buf;
}
function samplesFromPcm(buf: Buffer): number[] {
    const out: number[] = [];
    for (let i = 0; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i));
    return out;
}
function constant(n: number, value: number): Buffer {
    return pcmFromSamples(new Array(n).fill(value));
}

describe('Pcm16kTo24k', () => {
    it('rejects an output rate below 24000', () => {
        expect(() => new Pcm16kTo24k({ outRate: 16000 })).toThrow(/outRate/);
    });

    it('returns no frames for empty or sub-sample input', () => {
        const r = new Pcm16kTo24k();
        expect(r.push(Buffer.alloc(0))).toEqual([]);
        expect(r.push(Buffer.from([0x01]))).toEqual([]); // 1 byte, < one int16
    });

    it('emits fixed 960-byte (480-sample @ 24k) frames by default', () => {
        const r = new Pcm16kTo24k();
        // 16k input long enough to produce >1 output frame.
        const frames = r.push(constant(2000, 1000));
        expect(frames.length).toBeGreaterThan(0);
        for (const f of frames) expect(f.length).toBe(960);
    });

    it('buffers a partial trailing frame instead of emitting it', () => {
        const r = new Pcm16kTo24k();
        // A small input that produces < one 24k frame worth of output.
        const frames = r.push(constant(100, 500));
        expect(frames).toEqual([]);
        // flushRemainder returns the buffered short frame once, then null.
        const rem = r.flushRemainder();
        expect(rem).not.toBeNull();
        expect(rem!.length).toBeGreaterThan(0);
        expect(rem!.length).toBeLessThan(960);
        expect(r.flushRemainder()).toBeNull();
    });

    it('produces a constant output for a constant input (interpolation identity)', () => {
        const r = new Pcm16kTo24k();
        const frames = r.push(constant(1500, 4321));
        const all = samplesFromPcm(Buffer.concat([...frames, r.flushRemainder() ?? Buffer.alloc(0)]));
        // Every interpolated sample of a flat signal must equal the constant (no NaN, no drift).
        for (const s of all) expect(s).toBe(4321);
    });

    it('long-run resample ratio is ~1.5 (24k/16k)', () => {
        const r = new Pcm16kTo24k();
        r.push(constant(16000, 2000)); // 1s of 16k audio
        expect(r.getResampleRatio()).toBeGreaterThan(1.48);
        expect(r.getResampleRatio()).toBeLessThan(1.52);
    });

    it('is invariant to sample-aligned input chunk boundaries', () => {
        const input = pcmFromSamples(Array.from({ length: 3000 }, (_, i) => Math.round(8000 * Math.sin(i / 5))));

        const whole = new Pcm16kTo24k();
        const wholeOut = Buffer.concat([...whole.push(input), whole.flushRemainder() ?? Buffer.alloc(0)]);

        const split = new Pcm16kTo24k();
        const collected: Buffer[] = [];
        // Feed in varied but sample-aligned (even-byte) pieces to exercise the
        // prev-sample / fractional-position carry across chunks.
        let off = 0;
        const sizes = [4, 8, 64, 128, 258];
        let si = 0;
        while (off < input.length) {
            const size = sizes[si++ % sizes.length];
            collected.push(...split.push(input.subarray(off, off + size)));
            off += size;
        }
        const rem = split.flushRemainder();
        if (rem) collected.push(rem);
        const splitOut = Buffer.concat(collected);

        expect(splitOut.equals(wholeOut)).toBe(true);
    });

    it('carries the trailing byte of an odd-length chunk (odd splits are invariant)', () => {
        // An int16 split across chunk boundaries is carried into the next push,
        // so odd-length feeds produce the same output as one whole-buffer feed.
        const input = pcmFromSamples(Array.from({ length: 400 }, (_, i) => (i * 111) % 5000));

        const whole = new Pcm16kTo24k();
        const wholeOut = Buffer.concat([...whole.push(input), whole.flushRemainder() ?? Buffer.alloc(0)]);

        const split = new Pcm16kTo24k();
        const collected: Buffer[] = [];
        let off = 0;
        while (off < input.length) {
            collected.push(...split.push(input.subarray(off, off + 3))); // odd size
            off += 3;
        }
        const rem = split.flushRemainder();
        if (rem) collected.push(rem);
        const splitOut = Buffer.concat(collected);

        expect(splitOut.equals(wholeOut)).toBe(true);
    });

    it('clamps interpolated peaks to the int16 range', () => {
        const r = new Pcm16kTo24k({ method: 'cubic' });
        // Alternating full-scale extremes: cubic interpolation can overshoot, must clamp.
        const input = pcmFromSamples(Array.from({ length: 2000 }, (_, i) => (i % 2 === 0 ? 32767 : -32768)));
        const out = samplesFromPcm(Buffer.concat([...r.push(input), r.flushRemainder() ?? Buffer.alloc(0)]));
        for (const s of out) {
            expect(s).toBeGreaterThanOrEqual(-32768);
            expect(s).toBeLessThanOrEqual(32767);
        }
    });

    it('reset() reproduces the first-run output', () => {
        const input = constant(1200, 777);
        const r = new Pcm16kTo24k();
        const first = Buffer.concat([...r.push(input), r.flushRemainder() ?? Buffer.alloc(0)]);
        r.reset();
        const second = Buffer.concat([...r.push(input), r.flushRemainder() ?? Buffer.alloc(0)]);
        expect(second.equals(first)).toBe(true);
        expect(r.getResampleRatio()).toBeGreaterThan(1.4); // counters were reset & recomputed
    });
});
