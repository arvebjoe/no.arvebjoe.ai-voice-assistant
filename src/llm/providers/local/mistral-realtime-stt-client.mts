import WebSocket from 'ws';
import { createLogger } from '../../../helpers/logger.mjs';
import { ISttClient } from './stt-client.mjs';

/**
 * ISttClient for Mistral's Voxtral REALTIME transcription API — the websocket
 * streaming endpoint, much lower latency than the batch upload in
 * `mistral-stt-client.mts` (the model transcribes while audio arrives instead
 * of after the whole clip lands).
 *
 * Wire protocol (verified against the official mistralai Python SDK v2.6.0,
 * `mistralai/extra/realtime/` — the docs pages are behind a bot wall):
 *   - connect  wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=…
 *              with the usual Authorization/x-api-key headers
 *   - server:  {"type":"session.created","session":{request_id, model, …}}
 *   - client:  {"type":"session.update","session":{"audio_format":
 *              {"encoding":"pcm_s16le","sample_rate":16000},
 *              "target_streaming_delay_ms":480}}   (before any audio)
 *   - client:  {"type":"input_audio.append","audio":"<base64 raw PCM>"}
 *              (decoded max 262144 bytes per message)
 *   - client:  {"type":"input_audio.flush"} then {"type":"input_audio.end"}
 *   - server:  {"type":"transcription.text.delta","text":…} (partials),
 *              {"type":"transcription.language",…}, {"type":"transcription.segment",…},
 *              {"type":"transcription.done","text":…,"model":…} (final),
 *              {"type":"error","error":{message}}
 *
 * There is no language parameter — the model detects it (and reports it via
 * transcription.language), so `languageCode` is ignored here.
 */

export interface MistralRealtimeSttConfig {
    apiKey: string;
    /** Model id. Empty = DEFAULT_MISTRAL_REALTIME_STT_MODEL. */
    model: string;
}

export const DEFAULT_MISTRAL_REALTIME_STT_MODEL = 'voxtral-mini-transcribe-realtime-2602';
const MISTRAL_BASE_URL = 'https://api.mistral.ai';
const REALTIME_PATH = '/v1/audio/transcriptions/realtime';
const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
// Server cap is 262144 decoded bytes per append; stay comfortably under it.
const APPEND_CHUNK_BYTES = 65_536;
// Docs: any multiple of 80 ms in 80–1200 (or 2400); 480 is the recommended
// latency/accuracy sweet spot.
const TARGET_STREAMING_DELAY_MS = 480;

export class MistralRealtimeSttClient implements ISttClient {
    private config: MistralRealtimeSttConfig;
    private logger = createLogger('MISTRAL_RT_STT', true);

    constructor(config: MistralRealtimeSttConfig) {
        this.config = { ...config };
    }

    configure(config: MistralRealtimeSttConfig): void {
        this.config = { ...config };
    }

    private get model(): string {
        return this.config.model || DEFAULT_MISTRAL_REALTIME_STT_MODEL;
    }

    describe(): string {
        return `mistral-realtime-stt=${this.model}`;
    }

    isConfigured(): boolean {
        return !!this.config.apiKey;
    }

    hasCredentials(): boolean {
        return !!this.config.apiKey;
    }

    /** Health probe that also validates the key (401 on a bad one). */
    async check(): Promise<void> {
        const res = await fetch(`${MISTRAL_BASE_URL}/v1/models`, {
            headers: { Authorization: `Bearer ${this.config.apiKey}` },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401) throw new Error('Mistral API key was rejected (401) — check it in the app settings');
        if (!res.ok) throw new Error(`Mistral /v1/models returned HTTP ${res.status}`);
    }

    async transcribe(pcm16k: Buffer, _languageCode: string): Promise<string> {
        const url = `${MISTRAL_BASE_URL.replace(/^http/, 'ws')}${REALTIME_PATH}?model=${encodeURIComponent(this.model)}`;

        return new Promise<string>((resolve, reject) => {
            const ws = new WebSocket(url, {
                headers: {
                    Authorization: `Bearer ${this.config.apiKey}`,
                    'x-api-key': this.config.apiKey,
                },
            });

            let settled = false;
            let partial = '';
            const finish = (err: Error | null, text?: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { ws.close(1000); } catch { /* already dead */ }
                if (err) reject(err); else resolve((text ?? partial).trim());
            };
            const timer = setTimeout(
                () => finish(new Error(`Mistral realtime transcription timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)),
                REQUEST_TIMEOUT_MS,
            );

            const send = (obj: any) => ws.send(JSON.stringify(obj));

            ws.on('message', (data: any) => {
                let msg: any;
                try {
                    msg = JSON.parse(data.toString('utf8'));
                } catch {
                    return; // tolerate non-JSON frames like the SDK does
                }
                switch (msg?.type) {
                    case 'session.created':
                        // Configure before any audio (rejected afterwards), then
                        // stream the utterance, flush and end — the SDK does not
                        // wait for session.updated and neither do we.
                        send({
                            type: 'session.update',
                            session: {
                                audio_format: { encoding: 'pcm_s16le', sample_rate: 16000 },
                                target_streaming_delay_ms: TARGET_STREAMING_DELAY_MS,
                            },
                        });
                        for (let off = 0; off < pcm16k.length; off += APPEND_CHUNK_BYTES) {
                            send({
                                type: 'input_audio.append',
                                audio: pcm16k.subarray(off, off + APPEND_CHUNK_BYTES).toString('base64'),
                            });
                        }
                        send({ type: 'input_audio.flush' });
                        send({ type: 'input_audio.end' });
                        break;
                    case 'transcription.text.delta':
                        if (typeof msg.text === 'string') partial += msg.text;
                        break;
                    case 'transcription.done':
                        finish(null, typeof msg.text === 'string' ? msg.text : partial);
                        break;
                    case 'error': {
                        const detail = msg?.error?.message ?? JSON.stringify(msg?.error ?? msg).slice(0, 200);
                        finish(new Error(`Mistral realtime transcription error: ${detail}`));
                        break;
                    }
                    default:
                        break; // session.updated / transcription.language / .segment — informational
                }
            });

            ws.on('error', (err: Error) => finish(new Error(`Mistral realtime websocket error: ${err.message}`)));
            ws.on('close', (code: number) => finish(new Error(`Mistral realtime websocket closed early (code ${code})`)));
            ws.on('unexpected-response', (_req: any, res: any) => {
                finish(new Error(res.statusCode === 401
                    ? 'Mistral API key was rejected (401) — check it in the app settings'
                    : `Mistral realtime endpoint refused the connection (HTTP ${res.statusCode})`));
            });
        });
    }
}
