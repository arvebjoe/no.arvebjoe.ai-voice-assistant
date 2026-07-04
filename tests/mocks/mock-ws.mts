// Fake `ws` WebSocket for provider unit tests. Lets a test drive the socket
// lifecycle (open / message / error / close) and inspect everything the provider
// sends, with no network. Every constructed instance is pushed to `createdSockets`
// so tests can grab the current socket and assert reconnect behaviour.
import { EventEmitter } from 'node:events';

export const createdSockets: FakeWebSocket[] = [];

export function __resetSockets(): void {
    createdSockets.length = 0;
    FakeWebSocket.strictCloseCodes = false;
}

export class FakeWebSocket extends EventEmitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    // When true, close() rejects reserved codes like the real `ws` does — used to
    // prove the provider never sends code 1006 (H-e) and guards close() calls.
    static strictCloseCodes = false;

    readyState: number = FakeWebSocket.CONNECTING;
    sent: string[] = [];
    pings = 0;
    closeCalls: Array<{ code?: number; reason?: string }> = [];

    constructor(public url: string, public opts?: any) {
        super();
        createdSockets.push(this);
    }

    send(data: any): void {
        this.sent.push(typeof data === 'string' ? data : data.toString('utf8'));
    }

    close(code?: number, reason?: string): void {
        this.closeCalls.push({ code, reason });
        if (FakeWebSocket.strictCloseCodes && code != null && [1005, 1006, 1015].includes(code)) {
            throw new TypeError(`invalid status code ${code}`);
        }
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
    }

    ping(): void { this.pings++; }

    // ---- Test drivers ----
    /** Simulate the connection opening. */
    __open(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.emit('open');
    }
    /** Deliver a server event (object is JSON-encoded; string sent as-is). */
    __message(payload: any): void {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        this.emit('message', Buffer.from(text, 'utf8'));
    }
    /** Simulate a failed/broken connection (error then abnormal close). */
    __fail(): void {
        this.emit('error', new Error('connection failed'));
        if (this.readyState !== FakeWebSocket.CLOSED) {
            this.readyState = FakeWebSocket.CLOSED;
            this.emit('close', 1006, Buffer.from('abnormal'));
        }
    }

    // ---- Assertion helpers ----
    /** Parsed JSON of everything the provider sent on this socket. */
    parsedSent(): any[] {
        return this.sent.map(s => { try { return JSON.parse(s); } catch { return { type: '<non-json>' }; } });
    }
    sentTypes(): string[] { return this.parsedSent().map(m => m.type); }
}

export default FakeWebSocket;
