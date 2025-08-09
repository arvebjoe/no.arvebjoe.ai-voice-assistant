import OpenAI from 'openai';
import { createLogger } from '../helpers/logger.mjs';
import { pcmToWav } from '../helpers/wav-util.mjs';
import '../helpers/polyfills.mjs';

const log = createLogger('STT');

interface TranscribeOptions {
    language?: string;
    model?: string;
    verbose?: boolean;
    sampleRate?: number;
    bitsPerSample?: number;
    channels?: number;
}

async function transcribe(audioBuffer: Buffer, apiKey: string, opts: TranscribeOptions = {}, homey: any): Promise<string> {

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

        if (opts.verbose) {
            log.info(`Transcription completed`, undefined, {
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

export { transcribe };
