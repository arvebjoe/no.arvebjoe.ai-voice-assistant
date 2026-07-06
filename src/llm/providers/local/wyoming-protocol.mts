import net from 'node:net';

/**
 * Minimal Wyoming protocol client transport (see
 * docs/home-assistant-voice-preview-edition/wyoming-protocol.md).
 *
 * Wyoming is the Home Assistant voice ecosystem's TCP protocol — NOT HTTP.
 * Every message is a newline-terminated JSON header, optionally followed by
 * `data_length` bytes of additional JSON (merged into `data`) and
 * `payload_length` bytes of binary payload (raw PCM audio):
 *
 *   { "type": "...", "data": {...}, "data_length": N, "payload_length": M }\n
 *   <N bytes JSON><M bytes binary>
 *
 * Used by rhasspy/wyoming-faster-whisper (STT, typically port 10300) and
 * wyoming-piper (TTS, typically port 10200). This module owns connect/frame/
 * parse; the per-service flows (transcribe, synthesize) live in the clients.
 */

export interface WyomingEvent {
    type: string;
    data: any;
    payload: Buffer | null;
}

export class WyomingConnection {
    private socket: net.Socket;
    private buffer: Buffer = Buffer.alloc(0);
    private queue: WyomingEvent[] = [];
    private waiter: { resolve: () => void } | null = null;
    private failure: Error | null = null;
    private ended = false;

    private constructor(socket: net.Socket) {
        this.socket = socket;
        socket.on('data', (chunk) => {
            this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
            this.drainBuffer();
        });
        socket.on('error', (err) => this.fail(err));
        socket.on('close', () => {
            this.ended = true;
            this.waiter?.resolve();
        });
    }

    /** Open a TCP connection to a Wyoming service. */
    static connect(host: string, port: number, timeoutMs: number): Promise<WyomingConnection> {
        return new Promise((resolve, reject) => {
            const socket = net.connect({ host, port });
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error(`Connecting to ${host}:${port} timed out after ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);
            socket.once('connect', () => {
                clearTimeout(timer);
                resolve(new WyomingConnection(socket));
            });
            socket.once('error', (err) => {
                clearTimeout(timer);
                socket.destroy();
                reject(err);
            });
        });
    }

    /** Send one event: JSON header line + optional binary payload. */
    send(type: string, data?: any, payload?: Buffer): void {
        const header: any = { type };
        if (data !== undefined) header.data = data;
        if (payload?.length) header.payload_length = payload.length;
        this.socket.write(JSON.stringify(header) + '\n');
        if (payload?.length) this.socket.write(payload);
    }

    /**
     * Wait for the next event of one of the given types; any other event
     * types arriving in between (pings, progress, …) are consumed and
     * dropped. Rejects on socket error, close, or timeout.
     */
    async waitFor(types: string[], timeoutMs: number): Promise<WyomingEvent> {
        const deadline = Date.now() + timeoutMs;
        for (; ;) {
            const event = this.queue.shift();
            if (event) {
                if (types.includes(event.type)) return event;
                continue; // drop uninteresting events (pings, progress, …)
            }
            if (this.failure) throw this.failure;
            if (this.ended) throw new Error('Connection closed before the expected reply arrived');
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error(`Timed out waiting for '${types.join('/')}' after ${Math.round(timeoutMs / 1000)}s`);
            await this.nextWake(remaining);
        }
    }

    close(): void {
        this.ended = true;
        try {
            this.socket.removeAllListeners();
            this.socket.destroy();
        } catch { /* ignore */ }
        this.waiter?.resolve();
    }

    /** Resolve when new data/close/error arrives, or after `ms`. */
    private nextWake(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (this.waiter?.resolve === wrapped) this.waiter = null;
                resolve();
            }, ms);
            const wrapped = () => {
                clearTimeout(timer);
                this.waiter = null;
                resolve();
            };
            this.waiter = { resolve: wrapped };
        });
    }

    private fail(err: Error): void {
        this.failure = err;
        this.waiter?.resolve();
    }

    /** Parse as many complete events as the buffer holds. */
    private drainBuffer(): void {
        for (; ;) {
            const nl = this.buffer.indexOf(0x0a);
            if (nl < 0) return;

            let header: any;
            try {
                header = JSON.parse(this.buffer.subarray(0, nl).toString('utf8'));
            } catch {
                // Corrupt line — skip it rather than wedging the stream.
                this.buffer = this.buffer.subarray(nl + 1);
                continue;
            }

            const dataLength = Number(header?.data_length) || 0;
            const payloadLength = Number(header?.payload_length) || 0;
            const total = nl + 1 + dataLength + payloadLength;
            if (this.buffer.length < total) return; // wait for the rest

            let data = header?.data ?? {};
            if (dataLength > 0) {
                try {
                    const extra = JSON.parse(this.buffer.subarray(nl + 1, nl + 1 + dataLength).toString('utf8'));
                    data = { ...data, ...extra };
                } catch { /* keep inline data */ }
            }
            const payload = payloadLength > 0
                ? Buffer.from(this.buffer.subarray(nl + 1 + dataLength, total))
                : null;
            this.buffer = this.buffer.subarray(total);

            this.queue.push({ type: String(header?.type ?? ''), data, payload });
            this.waiter?.resolve();
        }
    }
}
