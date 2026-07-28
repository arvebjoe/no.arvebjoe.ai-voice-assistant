import { describe, it, expect } from 'vitest';
import { synthesizeChimePcm, synthesizeMicClosedChimePcm } from '../src/helpers/listening-chime.mjs';

const SAMPLE_RATE = 24_000;

describe('synthesizeChimePcm', () => {
    const pcm = synthesizeChimePcm();

    it('is short (a reopen cue, not an announcement)', () => {
        const ms = pcm.length / 2 / (SAMPLE_RATE / 1000);
        expect(ms).toBeGreaterThan(150);
        expect(ms).toBeLessThan(500);
    });

    it('contains audible-but-gentle audio (no clipping, not silence)', () => {
        let peak = 0;
        for (let i = 0; i < pcm.length; i += 2) {
            peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
        }
        expect(peak).toBeGreaterThan(3000);   // clearly audible
        expect(peak).toBeLessThan(16000);     // well below full scale — gentle cue
    });

    it('starts and ends silent (fades — no pop on the satellite speaker)', () => {
        const first = Math.abs(pcm.readInt16LE(0));
        const last = Math.abs(pcm.readInt16LE(pcm.length - 2));
        expect(first).toBeLessThan(100);
        expect(last).toBeLessThan(100);
    });
});

describe('synthesizeMicClosedChimePcm', () => {
    const pcm = synthesizeMicClosedChimePcm();

    it('mirrors the listening chime: same length, different (reversed) tones', () => {
        const listening = synthesizeChimePcm();
        expect(pcm.length).toBe(listening.length);
        expect(pcm.equals(listening)).toBe(false);
    });

    it('contains audible-but-gentle audio (no clipping, not silence)', () => {
        let peak = 0;
        for (let i = 0; i < pcm.length; i += 2) {
            peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
        }
        expect(peak).toBeGreaterThan(3000);
        expect(peak).toBeLessThan(16000);
    });

    it('starts and ends silent (fades — no pop on the satellite speaker)', () => {
        const first = Math.abs(pcm.readInt16LE(0));
        const last = Math.abs(pcm.readInt16LE(pcm.length - 2));
        expect(first).toBeLessThan(100);
        expect(last).toBeLessThan(100);
    });

    it('descends (A5 first, E5 second — the reverse of the listening chime)', () => {
        // Estimate each tone's frequency by counting zero crossings in the
        // steady middle of the two 90 ms tone segments (tone1 starts at 0,
        // tone2 after tone1 + 40 ms gap).
        const SR = 24_000;
        const seg = (startMs: number, lenMs: number) => {
            const start = Math.round(SR * (startMs / 1000));
            const len = Math.round(SR * (lenMs / 1000));
            let crossings = 0;
            for (let i = start + 1; i < start + len; i++) {
                const a = pcm.readInt16LE((i - 1) * 2);
                const b = pcm.readInt16LE(i * 2);
                if ((a >= 0) !== (b >= 0)) crossings++;
            }
            return (crossings / 2) / (lenMs / 1000); // Hz
        };
        const tone1 = seg(25, 40);  // middle of first tone
        const tone2 = seg(155, 40); // middle of second tone (90 + 40 + ~25)
        expect(tone1).toBeGreaterThan(tone2);
        expect(tone1).toBeCloseTo(880, -2);   // A5 within ~50 Hz
        expect(tone2).toBeCloseTo(659.25, -2); // E5 within ~50 Hz
    });
});
