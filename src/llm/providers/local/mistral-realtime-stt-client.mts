import WebSocket from 'ws';
import { createLogger } from '../../../helpers/logger.mjs';
import { ISttClient, ISttStream } from './stt-client.mjs';

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
 *
 * Two entry points: `createStream()` opens a live per-utterance session the
 * pipeline feeds WHILE the user is still talking (audio queued client-side
 * until the server's session.created arrives), and `transcribe()` is the
 * batch ISttClient contract implemented on top of it (append everything,
 * finish).
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

/**
 * One live utterance session on the realtime websocket. Audio may be appended
 * immediately after construction — it is buffered until the server's
 * session.created arrives and the audio format has been configured, then
 * streamed as it comes. `finish()` flushes/ends the input and resolves the
 * final transcript; the timeout only starts counting there, so a session can
 * stay open for as long as the user keeps talking.
 */
class MistralRealtimeSttStream implements ISttStream {
    private ws: WebSocket;
    private ready = false;              // session.created seen, audio format configured
    private queued: Buffer[] = [];      // audio appended before the session was ready
    private partial = '';
    private finalText: string | null = null;
    private failure: Error | null = null;
    private finishing = false;          // finish() called — flush/end sent (or sent on ready)
    private settled = false;            // terminal: final transcript, failure, or abort
    private waiter: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(url: string, apiKey: string, private onDelta?: (text: string) => void) {
        this.ws = new WebSocket(url, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'x-api-key': apiKey,
            },
        });

        this.ws.on('message', (data: any) => this.onMessage(data));
        this.ws.on('error', (err: Error) => this.fail(new Error(`Mistral realtime websocket error: ${err.message}`)));
        this.ws.on('close', (code: number) => this.fail(new Error(`Mistral realtime websocket closed early (code ${code})`)));
        this.ws.on('unexpected-response', (_req: any, res: any) => {
            this.fail(new Error(res.statusCode === 401
                ? 'Mistral API key was rejected (401) — check it in the app settings'
                : `Mistral realtime endpoint refused the connection (HTTP ${res.statusCode})`));
        });
    }

    append(pcm16k: Buffer): void {
        if (this.settled || this.finishing || pcm16k.length === 0) return;
        if (!this.ready) {
            this.queued.push(pcm16k);
            return;
        }
        this.sendAudio(pcm16k);
    }

    finish(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            if (this.failure) return reject(this.failure);
            if (this.finalText !== null) return resolve(this.finalText);
            this.waiter = { resolve, reject };
            this.timer = setTimeout(
                () => this.fail(new Error(`Mistral realtime transcription timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)),
                REQUEST_TIMEOUT_MS,
            );
            this.finishing = true;
            if (this.ready) this.sendFlushEnd();
        });
    }

    abort(): void {
        if (this.settled) return;
        this.settled = true;
        this.clearTimer();
        try { this.ws.close(1000); } catch { /* already dead */ }
        this.waiter?.reject(new Error('Mistral realtime transcription aborted'));
        this.waiter = null;
    }

    private onMessage(data: any): void {
        let msg: any;
        try {
            msg = JSON.parse(data.toString('utf8'));
        } catch {
            return; // tolerate non-JSON frames like the SDK does
        }
        switch (msg?.type) {
            case 'session.created':
                // Configure before any audio (rejected afterwards), then drain
                // what the mic already produced — the SDK does not wait for
                // session.updated and neither do we.
                this.send({
                    type: 'session.update',
                    session: {
                        audio_format: { encoding: 'pcm_s16le', sample_rate: 16000 },
                        target_streaming_delay_ms: TARGET_STREAMING_DELAY_MS,
                    },
                });
                this.ready = true;
                for (const pcm of this.queued) this.sendAudio(pcm);
                this.queued = [];
                if (this.finishing) this.sendFlushEnd();
                break;
            case 'transcription.text.delta':
                if (typeof msg.text === 'string') {
                    this.partial += msg.text;
                    try { this.onDelta?.(msg.text); } catch { /* consumer's problem */ }
                }
                break;
            case 'transcription.done':
                this.succeed(typeof msg.text === 'string' ? msg.text : this.partial);
                break;
            case 'error': {
                const detail = msg?.error?.message ?? JSON.stringify(msg?.error ?? msg).slice(0, 200);
                this.fail(new Error(`Mistral realtime transcription error: ${detail}`));
                break;
            }
            default:
                break; // session.updated / transcription.language / .segment — informational
        }
    }

    private sendAudio(pcm: Buffer): void {
        for (let off = 0; off < pcm.length; off += APPEND_CHUNK_BYTES) {
            this.send({
                type: 'input_audio.append',
                audio: pcm.subarray(off, off + APPEND_CHUNK_BYTES).toString('base64'),
            });
        }
    }

    private sendFlushEnd(): void {
        this.send({ type: 'input_audio.flush' });
        this.send({ type: 'input_audio.end' });
    }

    private send(obj: any): void {
        try {
            this.ws.send(JSON.stringify(obj));
        } catch (e: any) {
            this.fail(new Error(`Mistral realtime websocket send failed: ${e?.message ?? e}`));
        }
    }

    private succeed(text: string): void {
        if (this.settled) return;
        this.settled = true;
        this.clearTimer();
        this.finalText = text.trim();
        try { this.ws.close(1000); } catch { /* already dead */ }
        this.waiter?.resolve(this.finalText);
        this.waiter = null;
    }

    private fail(err: Error): void {
        if (this.settled) return;
        this.settled = true;
        this.clearTimer();
        this.failure = err;
        try { this.ws.close(1000); } catch { /* already dead */ }
        this.waiter?.reject(err);
        this.waiter = null;
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

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

    /** Open a live session that transcribes while the user is still talking. */
    createStream(_languageCode: string, onDelta?: (text: string) => void): ISttStream {
        const url = `${MISTRAL_BASE_URL.replace(/^http/, 'ws')}${REALTIME_PATH}?model=${encodeURIComponent(this.model)}`;
        return new MistralRealtimeSttStream(url, this.config.apiKey, onDelta);
    }

    /** Batch contract: stream the whole clip through one session. */
    async transcribe(pcm16k: Buffer, languageCode: string): Promise<string> {
        const stream = this.createStream(languageCode);
        stream.append(pcm16k);
        return stream.finish();
    }
}
