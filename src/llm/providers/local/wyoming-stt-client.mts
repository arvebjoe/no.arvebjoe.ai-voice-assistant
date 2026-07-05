import { createLogger } from '../../../helpers/logger.mjs';
import { ISttClient } from './stt-client.mjs';
import { WyomingConnection } from './wyoming-protocol.mjs';

/**
 * ISttClient for Wyoming-protocol STT servers — most notably
 * rhasspy/wyoming-faster-whisper (the Home Assistant faster-whisper docker,
 * typically on TCP port 10300). This is a different beast from the HTTP
 * Whisper servers WhisperClient talks to: raw TCP with JSON-line events and
 * binary PCM payloads (see wyoming-protocol.mts). Flow per utterance:
 *
 *   → transcribe { language }
 *   → audio-start { rate:16000, width:2, channels:1 }
 *   → audio-chunk ×N (payload = raw PCM)
 *   → audio-stop
 *   ← transcript { text }        (streaming servers may send
 *                                 transcript-chunk/-stop instead)
 */

export interface WyomingSttConfig {
    host: string;
    port: number;
}

const CONNECT_TIMEOUT_MS = 3_000;
const TRANSCRIBE_TIMEOUT_MS = 30_000;
const INFO_TIMEOUT_MS = 4_000;
// ~100 ms of 16 kHz PCM16 mono per audio-chunk (the wyoming reference size).
const CHUNK_BYTES = 3200;
const AUDIO_FORMAT = { rate: 16000, width: 2, channels: 1 };

export class WyomingSttClient implements ISttClient {
    private config: WyomingSttConfig;
    private logger = createLogger('WYOMING_STT', true);

    constructor(config: WyomingSttConfig) {
        this.config = { ...config };
    }

    configure(config: WyomingSttConfig): void {
        this.config = { ...config };
    }

    describe(): string {
        return `wyoming-stt=${this.config.host}:${this.config.port}`;
    }

    isConfigured(): boolean {
        return !!this.config.host && !!this.config.port;
    }

    /** Wyoming has no authentication. */
    hasCredentials(): boolean {
        return true;
    }

    /**
     * Health probe: the Wyoming handshake itself. `describe` must answer with
     * an `info` event — proves this is a Wyoming service and it is ready (a
     * plain TCP accept is not enough; HTTP servers accept TCP too).
     */
    async check(): Promise<void> {
        const conn = await WyomingConnection.connect(this.config.host, this.config.port, CONNECT_TIMEOUT_MS);
        try {
            conn.send('describe');
            const info = await conn.waitFor(['info'], INFO_TIMEOUT_MS);
            if (!info.data?.asr?.length) {
                throw new Error(`Wyoming service at ${this.config.host}:${this.config.port} reports no STT (asr) programs`);
            }
        } finally {
            conn.close();
        }
    }

    async transcribe(pcm16k: Buffer, languageCode: string): Promise<string> {
        const conn = await WyomingConnection.connect(this.config.host, this.config.port, CONNECT_TIMEOUT_MS);
        try {
            conn.send('transcribe', languageCode ? { language: languageCode } : {});
            conn.send('audio-start', { ...AUDIO_FORMAT, timestamp: 0 });
            for (let off = 0; off < pcm16k.length; off += CHUNK_BYTES) {
                const chunk = pcm16k.subarray(off, Math.min(off + CHUNK_BYTES, pcm16k.length));
                conn.send('audio-chunk', AUDIO_FORMAT, chunk);
            }
            conn.send('audio-stop', { timestamp: Math.round(pcm16k.length / 2 / AUDIO_FORMAT.rate * 1000) });

            // Non-streaming servers answer with a single final `transcript`.
            // Streaming ones send transcript-chunk fragments ending in
            // transcript-stop (each chunk carries the text so far, so the
            // LAST chunk wins — they are not concatenated).
            let streamedText = '';
            const deadline = Date.now() + TRANSCRIBE_TIMEOUT_MS;
            for (; ;) {
                const event = await conn.waitFor(
                    ['transcript', 'transcript-chunk', 'transcript-stop', 'error'],
                    Math.max(1, deadline - Date.now()),
                );
                switch (event.type) {
                    case 'transcript':
                        return String(event.data?.text ?? '').trim();
                    case 'transcript-chunk':
                        streamedText = String(event.data?.text ?? streamedText);
                        break;
                    case 'transcript-stop':
                        return streamedText.trim();
                    case 'error':
                        throw new Error(`Wyoming STT error: ${event.data?.text ?? 'unknown'}`);
                }
            }
        } finally {
            conn.close();
        }
    }
}
