import { describe, it, expect } from 'vitest';
import { PcmSegmenter } from '../src/helpers/pcm-segmenter.mjs';

// The segmenter operates on 24 kHz s16le mono. Its tuning constants are private,
// so these tests hardcode the derived values and note the coupling:
//   FRAME = 30 ms          = 1440 bytes (720 samples)
//   MIN_SILENCE = 300 ms   = 10 frames to trigger a cut
//   MIN_CHUNK  = 600 ms    = 28800 bytes minimum emitted size
const FRAME_SAMPLES = 720;
const FRAME_BYTES = FRAME_SAMPLES * 2;
const MIN_CHUNK_BYTES = 28800;

// Build `numFrames` worth of PCM at a fixed amplitude. Amplitude 0 => silence,
// ~8000 => clearly above the -45 dBFS speech threshold.
function pcm(numFrames: number, amplitude: number): Buffer {
    const total = numFrames * FRAME_SAMPLES;
    const buf = Buffer.allocUnsafe(total * 2);
    for (let i = 0; i < total; i++) {
        // Alternate sign so RMS matches |amplitude| rather than being a DC offset.
        buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
    }
    return buf;
}

function collectChunks(seg: PcmSegmenter): Buffer[] {
    const chunks: Buffer[] = [];
    seg.on('chunk', (b) => chunks.push(b));
    return chunks;
}

describe('PcmSegmenter', () => {
    it('emits exactly one chunk after >=600 ms speech followed by >=300 ms silence', async () => {
        const seg = new PcmSegmenter();
        const chunks = collectChunks(seg);

        await seg.feed(pcm(20, 8000)); // 600 ms speech
        await seg.feed(pcm(10, 0));    // 300 ms silence -> cut

        expect(chunks).toHaveLength(1);
        expect(chunks[0].length).toBeGreaterThanOrEqual(MIN_CHUNK_BYTES);
    });

    it('drops a short (<600 ms) segment on flush and still emits done', async () => {
        // Documents current behaviour: flush() routes the tail through the same
        // MIN_CHUNK guard, so a sub-600 ms reply produces no audio at all.
        const seg = new PcmSegmenter();
        const chunks = collectChunks(seg);
        let done = false;
        seg.on('done', () => { done = true; });

        await seg.feed(pcm(5, 8000)); // 150 ms speech, below the minimum
        seg.flush();

        expect(chunks).toHaveLength(0);
        expect(done).toBe(true);
    });

    it('flushes a large-enough tail that never saw trailing silence', async () => {
        const seg = new PcmSegmenter();
        const chunks = collectChunks(seg);

        await seg.feed(pcm(25, 8000)); // 750 ms speech, no trailing silence
        expect(chunks).toHaveLength(0); // nothing cut yet
        seg.flush();
        expect(chunks).toHaveLength(1);
    });

    it('emits only done on an empty flush', () => {
        const seg = new PcmSegmenter();
        const chunks = collectChunks(seg);
        let done = false;
        seg.on('done', () => { done = true; });

        seg.flush();
        expect(chunks).toHaveLength(0);
        expect(done).toBe(true);
    });

    it('is invariant to feed chunk boundaries', async () => {
        const input = Buffer.concat([pcm(20, 8000), pcm(10, 0)]);

        const whole = new PcmSegmenter();
        const wholeChunks = collectChunks(whole);
        await whole.feed(input);
        whole.flush();

        const split = new PcmSegmenter();
        const splitChunks = collectChunks(split);
        for (let off = 0; off < input.length; off += 100) {
            await split.feed(input.subarray(off, off + 100));
        }
        split.flush();

        expect(splitChunks.length).toBe(wholeChunks.length);
        const a = Buffer.concat(wholeChunks);
        const b = Buffer.concat(splitChunks);
        expect(b.equals(a)).toBe(true);
    });

    it('reset() discards buffered audio without emitting', async () => {
        const seg = new PcmSegmenter();
        const chunks = collectChunks(seg);
        let done = false;
        seg.on('done', () => { done = true; });

        // Buffer more than MIN_CHUNK worth of speech, then abort via reset().
        await seg.feed(pcm(25, 8000));
        seg.reset();

        // Nothing emitted by reset itself...
        expect(chunks).toHaveLength(0);
        expect(done).toBe(false);

        // ...and the discarded audio does not leak into a subsequent flush.
        seg.flush();
        expect(chunks).toHaveLength(0);
        expect(done).toBe(true);
    });

    it('never emits on sub-frame feeds', async () => {
        const seg = new PcmSegmenter();
        const chunks = collectChunks(seg);
        // Feed less than one full frame at a time; nothing should be emitted.
        for (let i = 0; i < 10; i++) await seg.feed(Buffer.alloc(FRAME_BYTES - 4, 5));
        expect(chunks).toHaveLength(0);
    });

    it('treats loud frames as speech and silent frames as silence (no cut without silence)', async () => {
        const seg = new PcmSegmenter();
        const chunks = collectChunks(seg);
        // 40 frames of continuous speech: never 10 consecutive silent frames -> no cut.
        await seg.feed(pcm(40, 8000));
        expect(chunks).toHaveLength(0);
    });
});
