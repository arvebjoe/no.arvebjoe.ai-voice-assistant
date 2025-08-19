import { WavOptions } from './interfaces.mjs';
import * as flac from 'flac-bindings';
import { StreamEncoder } from 'flac-bindings';
import { Readable } from 'stream';

interface FlacOptions {
    sampleRate?: number;
    channels?: number;
    bitsPerSample?: number;
    compressionLevel?: number;
    verify?: boolean;
}

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



/**
 * Convert raw PCM → FLAC in memory.
 * @param {Buffer|TypedArray} pcmData
 * @param {object} [opts]
 * @returns {Promise<Buffer>}
 */
export function pcmToFlacBuffer(pcmData: Buffer | Uint8Array,
    {
        sampleRate = 16_000,
        channels = 1,
        bitsPerSample = 16,
        compressionLevel = 5,
        verify = true
    }: FlacOptions = {}
): Promise<Buffer> {

    // Sanity-check frame size
    const frame = channels * (bitsPerSample >> 3);
    if (pcmData.byteLength % frame !== 0) {
        return Promise.reject(
            new Error(`PCM length must be a multiple of ${frame} bytes (one sample-frame)`)
        );
    }

    return new Promise((resolve, reject) => {
        const enc = new StreamEncoder({
            sampleRate,
            channels,
            bitsPerSample,
            compressionLevel
        });

        const chunks: Buffer[] = [];

        enc.on('data', (c: Buffer) => chunks.push(c));
        enc.once('close', () => resolve(Buffer.concat(chunks)));  // safest
        enc.once('error', reject);

        // Feed the encoder via a proper Readable so back-pressure is honoured
        const source = Buffer.isBuffer(pcmData) ? pcmData : Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);    
        Readable.from(source).pipe(enc);
    });
}
