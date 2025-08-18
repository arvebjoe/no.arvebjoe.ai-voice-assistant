import { WavOptions } from './interfaces.mjs';

// Add RIFF/WAVE header to a PCM Buffer
export function pcmToWavBuffer(pcmBuf: Buffer, { sampleRate, channels, bitsPerSample }: WavOptions): Buffer {
    const dataSize = pcmBuf.length;
    const blockAlign = (channels * bitsPerSample) >> 3;
    const byteRate = sampleRate * blockAlign;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);                 // PCM fmt chunk size
    header.writeUInt16LE(1, 20);                  // AudioFormat=PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuf]);
}