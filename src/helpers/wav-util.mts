import { WavOptions } from './interfaces.mjs';


// Import libflacjs (pure JavaScript FLAC encoder)
let Flac: any;
let isFlacReady = false;
let initializationPromise: Promise<void> | null = null;

// Initialize libflacjs using dynamic imports
async function initializeFlac(): Promise<void> {
    if (initializationPromise) {
        return initializationPromise;
    }

    initializationPromise = (async () => {
        try {
            // Use dynamic import for ES modules
            const FlacFactory = await import('libflacjs');
            Flac = (FlacFactory as any).default();
            
            if (Flac.isReady && Flac.isReady()) {
                isFlacReady = true;
                console.log('✅ libflacjs loaded and ready');
            } else {
                // Wait for async initialization
                await new Promise<void>((resolve) => {
                    Flac.on('ready', () => {
                        isFlacReady = true;
                        console.log('✅ libflacjs initialized and ready');
                        resolve();
                    });
                });
            }
        } catch (error: any) {
            console.error('❌ libflacjs failed to load:', error?.message || error);
            throw error;
        }
    })();

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

    // Initialize FLAC if not ready
    if (!isFlacReady || !Flac) {
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

            // Use the manual encoding approach with low-level libflac API
            const flacData: Buffer[] = [];
            let encoder: any;

            try {
                // Create encoder using low-level API
                encoder = Flac.create_libflac_encoder(sampleRate, channels, bitsPerSample, compressionLevel, 0);
                
                if (!encoder) {
                    throw new Error('Failed to create FLAC encoder');
                }

                // Set up write callback to collect encoded data
                const writeCallback = (data: Uint8Array, bytes: number, samples: number, current_frame: number) => {
                    if (data && bytes > 0) {
                        flacData.push(Buffer.from(data.slice(0, bytes)));
                    }
                    return 0; // Success
                };

                // Initialize encoder with callback
                const status = Flac.init_encoder_stream(
                    encoder,
                    writeCallback,
                    null, // seek callback
                    null, // tell callback
                    null  // metadata callback
                );

                if (status !== 0) {
                    throw new Error(`Failed to initialize FLAC encoder: ${status}`);
                }

                // Encode the audio data
                const samplesPerChannel = samples.length / channels;
                const processed = Flac.FLAC__stream_encoder_process_interleaved(
                    encoder,
                    samples,
                    samplesPerChannel
                );

                if (!processed) {
                    throw new Error('Failed to process audio data');
                }

                // Finish encoding
                const finished = Flac.FLAC__stream_encoder_finish(encoder);
                if (!finished) {
                    console.warn('FLAC encoder finish returned false');
                }

                // Clean up
                Flac.FLAC__stream_encoder_delete(encoder);

                resolve(Buffer.concat(flacData));

            } catch (error) {
                if (encoder) {
                    Flac.FLAC__stream_encoder_delete(encoder);
                }
                reject(error);
            }

        } catch (error) {
            reject(error);
        }
    });
}
