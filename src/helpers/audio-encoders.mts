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
        // Declared outside the try so it can be released in `finally` — the
        // libflacjs Encoder allocates a native (emscripten-heap) encoder plus a
        // listener on the shared Flac singleton, both freed only by destroy().
        let encoder: any = null;
        try {
            // Convert Buffer to appropriate format for libflacjs
            const buffer = Buffer.isBuffer(pcmData) ? pcmData : Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
            
            // Convert PCM data to the Int32Array format expected by libflacjs.
            // Only 16-bit PCM is supported — the whole pipeline is s16le. (An
            // earlier 8-bit branch scaled samples to 16-bit range while telling
            // the encoder 8-bit; internally inconsistent and never used.)
            if (bitsPerSample !== 16) {
                reject(new Error(`Unsupported bits per sample: ${bitsPerSample}`));
                return;
            }
            const samples = new Int32Array(buffer.length / 2);
            for (let i = 0; i < samples.length; i++) {
                samples[i] = buffer.readInt16LE(i * 2);
            }

            // Create encoder with configuration - Encoder needs Flac instance as first parameter
            encoder = new Encoder(Flac, {
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
        } finally {
            // Always release the native encoder + its Flac-singleton listener,
            // whether encoding succeeded or threw. Guarded so a partially
            // constructed encoder (or a destroy() that itself throws) can't mask
            // the original result/error.
            try {
                encoder?.destroy();
            } catch {
                // ignore teardown errors
            }
        }
    });
}
