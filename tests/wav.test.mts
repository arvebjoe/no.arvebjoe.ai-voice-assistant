import { describe, it, expect } from 'vitest';
import { pcmToWav, wavToPcm, toMonoPcm16, resamplePcm16Mono } from '../src/helpers/wav.mjs';

function sinePcm16(samples: number, freq: number, rate: number, amplitude = 8000): Buffer {
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        buf.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * freq * i / rate)), i * 2);
    }
    return buf;
}

describe('wav helpers', () => {
    it('round-trips PCM through pcmToWav/wavToPcm', () => {
        const pcm = sinePcm16(1600, 440, 16000);
        const wav = pcmToWav(pcm, 16000, 1);
        expect(wav.length).toBe(44 + pcm.length);

        const parsed = wavToPcm(wav);
        expect(parsed.sampleRate).toBe(16000);
        expect(parsed.channels).toBe(1);
        expect(parsed.bitsPerSample).toBe(16);
        expect(Buffer.compare(parsed.pcm, pcm)).toBe(0);
    });

    it('walks extra RIFF chunks before data (Piper-style headers survive additions)', () => {
        const pcm = sinePcm16(100, 440, 22050);
        const wav = pcmToWav(pcm, 22050, 1);
        // Splice a LIST chunk between fmt and data.
        const list = Buffer.alloc(8 + 4);
        list.write('LIST', 0, 'ascii');
        list.writeUInt32LE(4, 4);
        const spliced = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
        spliced.writeUInt32LE(spliced.length - 8, 4);

        const parsed = wavToPcm(spliced);
        expect(parsed.sampleRate).toBe(22050);
        expect(Buffer.compare(parsed.pcm, pcm)).toBe(0);
    });

    it('rejects non-WAV and non-PCM16 data', () => {
        expect(() => wavToPcm(Buffer.from('definitely not a wav file'))).toThrow(/RIFF/);
        const pcm = sinePcm16(10, 440, 16000);
        const wav = pcmToWav(pcm, 16000, 1);
        wav.writeUInt16LE(3, 20); // IEEE float format tag
        expect(() => wavToPcm(wav)).toThrow(/Unsupported WAV format/);
    });

    it('downmixes interleaved stereo to mono by averaging', () => {
        const stereo = Buffer.alloc(8);
        stereo.writeInt16LE(1000, 0); // L
        stereo.writeInt16LE(2000, 2); // R
        stereo.writeInt16LE(-500, 4);
        stereo.writeInt16LE(500, 6);
        const mono = toMonoPcm16(stereo, 2);
        expect(mono.length).toBe(4);
        expect(mono.readInt16LE(0)).toBe(1500);
        expect(mono.readInt16LE(2)).toBe(0);
    });

    it('resamples 22050 -> 24000 with the right length and preserved amplitude', () => {
        const inRate = 22050, outRate = 24000;
        const pcm = sinePcm16(inRate, 440, inRate); // 1 second
        const out = resamplePcm16Mono(pcm, inRate, outRate);
        expect(out.length / 2).toBe(Math.round((pcm.length / 2) * outRate / inRate));

        // Linear interpolation of a mid-frequency sine keeps the peak roughly intact.
        let peak = 0;
        for (let i = 0; i < out.length / 2; i++) peak = Math.max(peak, Math.abs(out.readInt16LE(i * 2)));
        expect(peak).toBeGreaterThan(7000);
        expect(peak).toBeLessThanOrEqual(8000);
    });

    it('is a pass-through when rates match', () => {
        const pcm = sinePcm16(100, 440, 24000);
        expect(resamplePcm16Mono(pcm, 24000, 24000)).toBe(pcm);
    });
});
