import { WavOptions } from './interfaces.mjs';

// Import libflacjs (pure JavaScript FLAC encoder) - using createRequire for CommonJS modules
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const FlacFactory = require('libflacjs');
const Flac = FlacFactory();
const { Encoder } = require('libflacjs/lib/encoder');

// Track initialization state
let isFlacReady = false;
let initializationPromise: Promise<void> | null = null;

// Initialize FLAC library
function initializeFlac(): Promise<void> {
    if (initializationPromise) {
        return initializationPromise;
    }

    initializationPromise = new Promise<void>((resolve) => {
        if (Flac.isReady()) {
            isFlacReady = true;
            resolve();
        } else {
            Flac.on('ready', () => {
                isFlacReady = true;
                resolve();
            });
        }
    });

    return initializationPromise;
}

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
 * Convert raw PCM → FLAC in memory using libflacjs.
 * @param {Buffer|TypedArray} pcmData
 * @param {object} [opts]
 * @returns {Promise<Buffer>}
 */
export async function pcmToFlacBuffer(pcmData: Buffer | Uint8Array,
    {
        sampleRate = 16_000,
        channels = 1,
        bitsPerSample = 16,
        compressionLevel = 5,
        verify = true
    }: FlacOptions = {}
): Promise<Buffer> {

    // Ensure FLAC is ready before proceeding
    if (!isFlacReady) {
        await initializeFlac();
    }

    // Sanity-check frame size
    const frame = channels * (bitsPerSample >> 3);
    if (pcmData.byteLength % frame !== 0) {
        throw new Error(`PCM length must be a multiple of ${frame} bytes (one sample-frame)`);
    }

    return new Promise((resolve, reject) => {
        try {
            // Convert Buffer to appropriate format for libflacjs
            const buffer = Buffer.isBuffer(pcmData) ? pcmData : Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
            
            // Convert PCM data to Int32Array format expected by libflacjs
            const samples = new Int32Array(buffer.length / (bitsPerSample / 8));
            if (bitsPerSample === 16) {
                // Convert 16-bit PCM to Int32Array
                for (let i = 0; i < samples.length; i++) {
                    samples[i] = buffer.readInt16LE(i * 2);
                }
            } else if (bitsPerSample === 8) {
                // Convert 8-bit PCM to Int32Array
                for (let i = 0; i < samples.length; i++) {
                    samples[i] = buffer.readInt8(i) << 8; // Scale to 16-bit range
                }
            } else {
                reject(new Error(`Unsupported bits per sample: ${bitsPerSample}`));
                return;
            }

            // Create encoder with configuration - Encoder needs Flac instance as first parameter
            const encoder = new Encoder(Flac, {
                sampleRate: sampleRate,
                channels: channels,
                bitsPerSample: bitsPerSample,
                compression: compressionLevel,
                verify: verify
            });

            // Prepare samples for encoding
            const samplesPerChannel = samples.length / channels;
            
            // Deinterleave channels if needed
            const channelData: Int32Array[] = [];
            if (channels === 1) {
                channelData.push(samples);
            } else {
                // Deinterleave stereo data
                for (let ch = 0; ch < channels; ch++) {
                    const channelSamples = new Int32Array(samplesPerChannel);
                    for (let i = 0; i < samplesPerChannel; i++) {
                        channelSamples[i] = samples[i * channels + ch];
                    }
                    channelData.push(channelSamples);
                }
            }

            // Encode the audio data
            const encodeResult = encoder.encode(channelData);
            if (!encodeResult) {
                reject(new Error('Failed to encode FLAC data'));
                return;
            }

            // Finish encoding
            encoder.encode(); // Call without parameters to finish

            // Get the encoded FLAC data
            const flacData = encoder.getSamples();
            resolve(Buffer.from(flacData));

        } catch (error) {
            reject(error);
        }
    });
}
