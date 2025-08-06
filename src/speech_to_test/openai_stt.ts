import OpenAI from 'openai';
import EventEmitter from 'events';
import { createLogger } from '../helpers/logger';
import { pcmToWav } from '../helpers/wav-util';
import '../helpers/polyfills';

const log = createLogger('OPENAI-STT');

interface TranscribeOptions {
    language?: string;
    model?: string;
    verbose?: boolean;
    sampleRate?: number;
    bitsPerSample?: number;
    channels?: number;
}

async function transcribe(
    audioBuffer: Buffer,
    apiKey: string,
    opts: TranscribeOptions = {}
): Promise<string> {
    const startTime = Date.now();
    if (!apiKey) {
        throw new Error('No OpenAI API key found in environment variables');
    }
    try {
        const sampleRate = opts.sampleRate || 16000;
        const wavBuffer = pcmToWav(audioBuffer, sampleRate);
        if (opts.verbose) {
            log.info(`Converted ${audioBuffer.length} bytes of PCM data to ${wavBuffer.length} bytes WAV`);
        }
        const openai = new OpenAI({ apiKey });
        const wavFile = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' });
        if (opts.verbose) {
            log.info(`Created WAV file object (${wavBuffer.length} bytes)`);
        }
        const transcriptionOpts: any = {
            file: wavFile,
            model: opts.model || 'whisper-1',
            response_format: 'json',
        };
        if (opts.language) {
            transcriptionOpts.language = opts.language;
        }
        if (opts.verbose) {
            log.info('Sending audio to OpenAI for transcription', undefined, transcriptionOpts);
        }
        const response = await openai.audio.transcriptions.create(transcriptionOpts);
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        if (opts.verbose) {
            log.info(`Transcription completed in ${elapsedTime}s`, undefined, {
                inputBytes: audioBuffer.length,
                wavBytes: wavBuffer.length,
                language: opts.language || 'auto',
                response: response,
            });
        }
        // Return the transcription text
        return response.text ?? '';
    } catch (error: any) {
        log.error('OpenAI transcription error', error);
        throw error;
    }
}

interface OpenAISTTStreamOptions extends TranscribeOptions {
    minBatchSize?: number;
    maxBatchSize?: number;
}

class OpenAISTTStream extends EventEmitter {
    private apiKey: string;
    private openai: OpenAI;
    private language: string;
    private model: string;
    private verbose: boolean;
    private buffer: Buffer;
    private minBatchSize: number;
    private maxBatchSize: number;
    private isProcessing: boolean;
    private isClosed: boolean;

    constructor(opts: OpenAISTTStreamOptions = {}) {
        super();
        this.apiKey = process.env.OPENAI_API_KEY || '';
        if (!this.apiKey) {
            throw new Error('OpenAI API key is required');
        }
        this.openai = new OpenAI({ apiKey: this.apiKey });
        this.language = opts.language || 'no';
        this.model = opts.model || 'whisper-1';
        this.verbose = opts.verbose || false;
        this.buffer = Buffer.alloc(0);
        this.minBatchSize = opts.minBatchSize || 1024 * 64;
        this.maxBatchSize = opts.maxBatchSize || 1024 * 1024 * 24;
        this.isProcessing = false;
        this.isClosed = false;
    }

    async writeChunk(chunk: Buffer): Promise<void> {
        if (this.isClosed) {
            throw new Error('Stream is closed');
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length >= this.minBatchSize && !this.isProcessing) {
            await this._processBatch();
        }
    }

    async end(): Promise<void> {
        if (this.buffer.length > 0 && !this.isProcessing) {
            await this._processBatch();
        }
        this.isClosed = true;
        this.emit('done');
    }

    private async _processBatch(): Promise<void> {
        if (this.buffer.length === 0 || this.isProcessing) return;
        this.isProcessing = true;
        try {
            const batchBuffer = this.buffer.length > this.maxBatchSize
                ? this.buffer.subarray(0, this.maxBatchSize)
                : this.buffer;
            this.buffer = this.buffer.length > this.maxBatchSize
                ? this.buffer.subarray(this.maxBatchSize)
                : Buffer.alloc(0);
            if (this.verbose) {
                log.info('Processing batch', undefined, {
                    batchSize: batchBuffer.length,
                    remainingBuffer: this.buffer.length,
                });
            }
            const result = await transcribe(batchBuffer, this.apiKey, {
                language: this.language,
                model: this.model,
                verbose: this.verbose,
                sampleRate: 16000,
                channels: 1,
            });
            if (result) {
                this.emit('transcription', result);
            }
        } catch (error: any) {
            this.emit('error', error);
        } finally {
            this.isProcessing = false;
            if (this.buffer.length >= this.minBatchSize && !this.isClosed) {
                await this._processBatch();
            }
        }
    }

    destroy(): void {
        this.isClosed = true;
        this.buffer = Buffer.alloc(0);
    }
}

function createSTTStream(opts: OpenAISTTStreamOptions = {}): OpenAISTTStream {
    return new OpenAISTTStream(opts);
}

export { transcribe, OpenAISTTStream, createSTTStream };
