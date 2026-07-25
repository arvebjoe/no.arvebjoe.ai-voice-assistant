import { describe, it, expect } from 'vitest';
import { synthesizeChimePcm } from '../src/helpers/listening-chime.mjs';

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
