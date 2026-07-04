import { describe, it, expect } from 'vitest';
import { pcmToFlacBuffer } from '../src/helpers/audio-encoders.mjs';

function sinePcm(samples: number, amplitude = 8000): Buffer {
    const buf = Buffer.allocUnsafe(samples * 2);
    for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(amplitude * Math.sin(i / 8)), i * 2);
    return buf;
}

describe('pcmToFlacBuffer', () => {
    it('encodes 16-bit mono PCM to a FLAC stream (fLaC magic)', async () => {
        const pcm = sinePcm(4800); // 300 ms @ 16k
        const flac = await pcmToFlacBuffer(pcm, { sampleRate: 16000, channels: 1, bitsPerSample: 16 });
        expect(flac.length).toBeGreaterThan(0);
        expect(flac.toString('ascii', 0, 4)).toBe('fLaC');
    });

    it('rejects PCM whose length is not a whole number of sample-frames', async () => {
        // 16-bit mono => frame is 2 bytes; an odd length is invalid.
        await expect(pcmToFlacBuffer(Buffer.alloc(101), { bitsPerSample: 16, channels: 1 }))
            .rejects.toThrow(/multiple of/i);
    });

    it('rejects an unsupported bit depth', async () => {
        // 24-bit: frame is 3 bytes, so use a length that IS a multiple of 3 to
        // reach the bit-depth branch rather than the frame-size guard.
        await expect(pcmToFlacBuffer(Buffer.alloc(99), { bitsPerSample: 24, channels: 1 }))
            .rejects.toThrow(/Unsupported bits per sample/i);
    });
});
