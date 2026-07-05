import { createLogger } from '../../../helpers/logger.mjs';
import { toMonoPcm16 } from '../../../helpers/wav.mjs';
import { ITtsClient } from './tts-client.mjs';
import { WyomingConnection } from './wyoming-protocol.mjs';

/**
 * ITtsClient for Wyoming-protocol TTS servers — most notably
 * rhasspy/wyoming-piper (the Home Assistant Piper docker, typically on TCP
 * port 10200). Counterpart of WyomingSttClient; the wire transport lives in
 * wyoming-protocol.mts. Flow per clip:
 *
 *   → synthesize { text }
 *   ← audio-start { rate, width, channels }
 *   ← audio-chunk ×N (payload = raw PCM)
 *   ← audio-stop
 *
 * The voice is whatever the server was started with (--voice); like the
 * HTTP PiperClient there is no per-request voice selection in this round.
 */

export interface WyomingTtsConfig {
    host: string;
    port: number;
}

const CONNECT_TIMEOUT_MS = 3_000;
const SYNTHESIZE_TIMEOUT_MS = 30_000;
const INFO_TIMEOUT_MS = 4_000;

export class WyomingTtsClient implements ITtsClient {
    private config: WyomingTtsConfig;
    private logger = createLogger('WYOMING_TTS', true);

    constructor(config: WyomingTtsConfig) {
        this.config = { ...config };
    }

    configure(config: WyomingTtsConfig): void {
        this.config = { ...config };
    }

    describe(): string {
        return `wyoming-tts=${this.config.host}:${this.config.port}`;
    }

    isConfigured(): boolean {
        return !!this.config.host && !!this.config.port;
    }

    /** Wyoming has no authentication. */
    hasCredentials(): boolean {
        return true;
    }

    /**
     * Health probe: the Wyoming handshake — `describe` must answer with an
     * `info` event that lists a TTS program.
     */
    async check(): Promise<void> {
        const conn = await WyomingConnection.connect(this.config.host, this.config.port, CONNECT_TIMEOUT_MS);
        try {
            conn.send('describe');
            const info = await conn.waitFor(['info'], INFO_TIMEOUT_MS);
            if (!info.data?.tts?.length) {
                throw new Error(`Wyoming service at ${this.config.host}:${this.config.port} reports no TTS programs`);
            }
        } finally {
            conn.close();
        }
    }

    async synthesize(text: string, signal?: AbortSignal): Promise<{ pcm: Buffer; sampleRate: number }> {
        const conn = await WyomingConnection.connect(this.config.host, this.config.port, CONNECT_TIMEOUT_MS);
        signal?.addEventListener('abort', () => conn.close(), { once: true });
        try {
            conn.send('synthesize', { text });

            const deadline = Date.now() + SYNTHESIZE_TIMEOUT_MS;
            const start = await conn.waitFor(['audio-start', 'error'], SYNTHESIZE_TIMEOUT_MS);
            if (start.type === 'error') throw new Error(`Wyoming TTS error: ${start.data?.text ?? 'unknown'}`);

            const sampleRate = Number(start.data?.rate) || 22050;
            const width = Number(start.data?.width) || 2;
            const channels = Number(start.data?.channels) || 1;
            if (width !== 2) {
                throw new Error(`Unsupported sample width ${width} from Wyoming TTS — only 16-bit PCM is supported`);
            }

            const chunks: Buffer[] = [];
            for (; ;) {
                const event = await conn.waitFor(
                    ['audio-chunk', 'audio-stop', 'error'],
                    Math.max(1, deadline - Date.now()),
                );
                if (event.type === 'audio-chunk') {
                    if (event.payload?.length) chunks.push(event.payload);
                    continue;
                }
                if (event.type === 'error') throw new Error(`Wyoming TTS error: ${event.data?.text ?? 'unknown'}`);
                break; // audio-stop
            }

            const pcm = Buffer.concat(chunks);
            return { pcm: toMonoPcm16(pcm, channels), sampleRate };
        } finally {
            conn.close();
        }
    }
}
