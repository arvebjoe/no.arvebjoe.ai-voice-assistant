import { describe, it, expect } from 'vitest';
import { pcmToWavBuffer, pcmToFlacBuffer } from '../src/helpers/audio-encoders.mjs';

function sinePcm(samples: number, amplitude = 8000): Buffer {
    const buf = Buffer.allocUnsafe(samples * 2);
    for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(amplitude * Math.sin(i / 8)), i * 2);
    return buf;
}

describe('pcmToWavBuffer', () => {
    it('prepends a valid 44-byte RIFF/WAVE header', () => {
        const pcm = sinePcm(100);
        const wav = pcmToWavBuffer(pcm, { sampleRate: 16000, channels: 1, bitsPerSample: 16 });

        expect(wav.length).toBe(44 + pcm.length);
        expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
        expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
        expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
        expect(wav.toString('ascii', 36, 40)).toBe('data');
    });

    it('writes correct fmt fields for 16 kHz mono 16-bit', () => {
        const pcm = sinePcm(50);
        const wav = pcmToWavBuffer(pcm, { sampleRate: 16000, channels: 1, bitsPerSample: 16 });

        expect(wav.readUInt32LE(16)).toBe(16);        // PCM fmt chunk size
        expect(wav.readUInt16LE(20)).toBe(1);         // AudioFormat = PCM
        expect(wav.readUInt16LE(22)).toBe(1);         // channels
        expect(wav.readUInt32LE(24)).toBe(16000);     // sample rate
        expect(wav.readUInt32LE(28)).toBe(32000);     // byteRate = 16000 * 2
        expect(wav.readUInt16LE(32)).toBe(2);         // blockAlign = channels * bytes
        expect(wav.readUInt16LE(34)).toBe(16);        // bits per sample
        expect(wav.readUInt32LE(40)).toBe(pcm.length); // data size
        expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // RIFF chunk size
    });

    it('computes byteRate/blockAlign for 24 kHz stereo', () => {
        const pcm = sinePcm(80); // length irrelevant to header math here
        const wav = pcmToWavBuffer(pcm, { sampleRate: 24000, channels: 2, bitsPerSample: 16 });
        expect(wav.readUInt16LE(32)).toBe(4);         // blockAlign = 2ch * 2 bytes
        expect(wav.readUInt32LE(28)).toBe(96000);     // byteRate = 24000 * 4
    });

    it('produces a valid header for empty PCM', () => {
        const wav = pcmToWavBuffer(Buffer.alloc(0), { sampleRate: 16000, channels: 1, bitsPerSample: 16 });
        expect(wav.length).toBe(44);
        expect(wav.readUInt32LE(40)).toBe(0);
        expect(wav.readUInt32LE(4)).toBe(36);
    });
});

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
