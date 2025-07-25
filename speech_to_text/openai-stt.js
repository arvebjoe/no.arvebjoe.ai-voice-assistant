const OpenAI = require('openai');
const { toFile } = OpenAI;
const EventEmitter = require('events');
const { createLogger } = require('../logger');
const { pcmToWav } = require('../wav-helpers'); // Reusing your existing WAV encoder

const log = createLogger('OPENAI-STT');

/**
 * Transcribe audio using OpenAI's Whisper API
 * @param {Buffer} audioBuffer - Raw PCM audio buffer to transcribe
 * @param {Object} opts - Options
 * @param {string} opts.language - Language code (e.g., "no" for Norwegian)
 * @param {string} opts.model - Model to use (default: "whisper-1")
 * @param {boolean} opts.verbose - Enable verbose logging
 * @param {number} opts.sampleRate - Sample rate of PCM data (default: 16000)
 * @param {number} opts.bitsPerSample - Bits per sample of PCM data (default: 16)
 * @param {number} opts.channels - Number of audio channels (default: 1)
 * @returns {Promise<string>} - Transcription text
 */
async function transcribe(audioBuffer, apiKey, opts = {}) {
    const startTime = Date.now();
    
    if (!apiKey) {
        throw new Error('No OpenAI API key found in environment variables');
    }
    
    try {
        // Convert PCM to WAV if needed
        const sampleRate = opts.sampleRate || 16000;
        const wavBuffer = pcmToWav(audioBuffer, sampleRate);
        
        if (opts.verbose) {
            log.info(`Converted ${audioBuffer.length} bytes of PCM data to ${wavBuffer.length} bytes WAV`);
        }
        
        // Initialize OpenAI client
        const openai = new OpenAI({ apiKey });
        
        // Convert WAV buffer to a File-like object using OpenAI's toFile helper
        // This is the recommended approach for passing Buffer data to the API
        const wavFile = await toFile(wavBuffer, 'audio.wav', { type: 'audio/wav' });
        
        if (opts.verbose) {
            log.info(`Created WAV file object (${wavBuffer.length} bytes)`);
        }
        
        // Set up transcription options with the file
        const transcriptionOpts = {
            file: wavFile,
            model: opts.model || 'whisper-1',
            response_format: 'text',
        };
        
        // Add language if specified
        if (opts.language) {
            transcriptionOpts.language = opts.language;
        }
        
        if (opts.verbose) {
            log.info('Sending audio to OpenAI for transcription', null, {
                model: transcriptionOpts.model,
                language: transcriptionOpts.language || 'auto',
                audioSize: wavBuffer.length,
                format: 'wav',
                sampleRate
            });
        }
        
        // Make API request
        const response = await openai.audio.transcriptions.create(transcriptionOpts);
        
        // No cleanup needed since we're using in-memory blob
        
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        log.info(`Transcription completed in ${elapsedTime}s`, null, {
            inputBytes: audioBuffer.length,
            wavBytes: wavBuffer.length,
            language: opts.language || 'auto'
        });
        
        return response;
    } catch (error) {
        log.error('OpenAI transcription error', error);
        throw error;
    }
}

/**
 * Create a stream for real-time transcription (similar to whisper-stream.js)
 * Note: OpenAI doesn't support real-time streaming for Whisper API directly,
 * so this implementation batches audio chunks and sends them when enough data is collected
 * or when end() is called.
 */
class OpenAISTTStream extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.apiKey = process.env.OPENAI_API_KEY;
        if (!this.apiKey) {
            throw new Error('OpenAI API key is required');
        }
        
        this.openai = new OpenAI({ apiKey: this.apiKey });
        this.language = opts.language || 'no';
        this.model = opts.model || 'whisper-1';
        this.verbose = opts.verbose || false;
        this.buffer = Buffer.alloc(0);
        this.minBatchSize = opts.minBatchSize || 1024 * 64; // 64KB minimum for batch processing
        this.maxBatchSize = opts.maxBatchSize || 1024 * 1024 * 24; // 24MB max (Whisper API limit)
        this.isProcessing = false;
        this.isClosed = false;
    }
    
    /**
     * Write an audio chunk to the stream
     * @param {Buffer} chunk - Audio chunk
     */
    async writeChunk(chunk) {
        if (this.isClosed) {
            throw new Error('Stream is closed');
        }
        
        // Add chunk to buffer
        this.buffer = Buffer.concat([this.buffer, chunk]);
        
        // If buffer exceeds min batch size and we're not already processing, send batch
        if (this.buffer.length >= this.minBatchSize && !this.isProcessing) {
            await this._processBatch();
        }
    }
    
    /**
     * Signal that no more audio is coming
     */
    async end() {
        if (this.buffer.length > 0 && !this.isProcessing) {
            await this._processBatch();
        }
        this.isClosed = true;
        this.emit('done');
    }
    
    /**
     * Process the accumulated audio buffer
     * @private
     */
    async _processBatch() {
        if (this.buffer.length === 0 || this.isProcessing) return;
        
        this.isProcessing = true;
        
        try {
            // If buffer exceeds max size, trim it
            const batchBuffer = this.buffer.length > this.maxBatchSize 
                ? this.buffer.subarray(0, this.maxBatchSize) 
                : this.buffer;
            
            // Clear the processed part from the buffer
            this.buffer = this.buffer.length > this.maxBatchSize 
                ? this.buffer.subarray(this.maxBatchSize) 
                : Buffer.alloc(0);
            
            if (this.verbose) {
                log.info('Processing batch', null, { 
                    batchSize: batchBuffer.length,
                    remainingBuffer: this.buffer.length 
                });
            }
            
            // Transcribe the batch
            const result = await transcribe(batchBuffer, {
                language: this.language,
                model: this.model,
                verbose: this.verbose,
                sampleRate: 16000, // Default sample rate for voice
                channels: 1        // Mono audio
            });
            
            if (result) {
                this.emit('transcription', result);
            }
        } catch (error) {
            this.emit('error', error);
        } finally {
            this.isProcessing = false;
            
            // If there's still data in the buffer and the stream isn't closed, process next batch
            if (this.buffer.length >= this.minBatchSize && !this.isClosed) {
                await this._processBatch();
            }
        }
    }
    
    /**
     * Close and clean up resources
     */
    destroy() {
        this.isClosed = true;
        this.buffer = Buffer.alloc(0);
    }
}

// Simplified stream constructor function similar to other modules
function createSTTStream(opts = {}) {
    return new OpenAISTTStream(opts);
}

// Export everything using CommonJS syntax
module.exports = {
    transcribe,
    OpenAISTTStream,
    createSTTStream
};
