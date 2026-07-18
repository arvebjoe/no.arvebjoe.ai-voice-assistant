import dgram from 'dgram';
import net from 'net';
import os from 'os';

/**
 * Remote syslog transport (RFC 5424) for third-party logging solutions —
 * rsyslog/syslog-ng, Synology/QNAP log centers, Grafana Alloy/Loki,
 * Papertrail and friends. This is the same integration route the Homey
 * ecosystem already uses (PaperTrails Log, Simple (Sys) Log, Syslog client,
 * robertklep/homey-syslog), so any collector that works with those works here.
 *
 * The transport is deliberately fire-and-forget: logging must never slow down
 * or break the voice pipeline. UDP datagrams are sent without waiting; TCP
 * writes go through a lazily-(re)connected socket with a bounded buffer, and
 * every failure path is swallowed after remembering the last error (surfaced
 * by the settings page's Test button, not by log spam of its own).
 */

// Syslog severities (RFC 5424 §6.2.1) — only the four this app uses.
export const SYSLOG_ERROR = 3;
export const SYSLOG_WARNING = 4;
export const SYSLOG_INFO = 6;
export const SYSLOG_DEBUG = 7;

const FACILITY_LOCAL0 = 16;
const APP_NAME = 'ai-voice-assistant';
const MAX_MESSAGE_BYTES = 8 * 1024; // fits a jumbo-less UDP datagram comfortably
const TCP_RECONNECT_MIN_MS = 5000;
const TCP_MAX_BUFFERED_BYTES = 64 * 1024;

export type RemoteLogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface RemoteLogSettings {
    enabled: boolean;
    host: string;
    port: number;
    protocol: 'udp' | 'tcp';
    level: RemoteLogLevel;
}

const LEVEL_TO_SEVERITY: Record<RemoteLogLevel, number> = {
    error: SYSLOG_ERROR,
    warn: SYSLOG_WARNING,
    info: SYSLOG_INFO,
    debug: SYSLOG_DEBUG,
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// RFC 5424 header fields must be printable US-ASCII without spaces.
function sanitizeHeaderField(value: string, maxLen: number): string {
    const clean = value.replace(/[^\x21-\x7e]/g, '_').slice(0, maxLen);
    return clean || '-';
}

/**
 * Build one RFC 5424 syslog line. `tag` (the logger name, e.g. CONVO or ESP)
 * rides in the MSGID field so collectors can filter per subsystem.
 */
export function formatSyslogMessage(severity: number, tag: string, message: string, when: Date = new Date()): string {
    const pri = FACILITY_LOCAL0 * 8 + severity;
    const hostname = sanitizeHeaderField(os.hostname(), 255);
    const msgid = sanitizeHeaderField(tag, 32);
    // Strip terminal colors and collapse to a single line — multi-line
    // datagrams get split into bogus entries by most collectors.
    let msg = message.replace(ANSI_RE, '').replace(/\r?\n/g, ' ');
    const header = `<${pri}>1 ${when.toISOString()} ${hostname} ${APP_NAME} ${process.pid} ${msgid} - `;
    const room = MAX_MESSAGE_BYTES - Buffer.byteLength(header);
    if (Buffer.byteLength(msg) > room) {
        // '…' is 3 bytes in UTF-8 — leave room for it.
        msg = `${Buffer.from(msg).subarray(0, room - 3).toString()}…`;
    }
    return header + msg;
}

export class RemoteLogTransport {
    private settings: RemoteLogSettings | null = null;
    private threshold = SYSLOG_DEBUG;
    private udpSocket: dgram.Socket | null = null;
    private tcpSocket: net.Socket | null = null;
    private lastTcpAttemptAt = 0;
    private lastError: string | null = null;

    /** Apply (new) settings. Closes any open socket when the endpoint changes. */
    configure(settings: RemoteLogSettings): void {
        const prev = this.settings;
        const changed = !prev
            || prev.enabled !== settings.enabled
            || prev.host !== settings.host
            || prev.port !== settings.port
            || prev.protocol !== settings.protocol;
        this.settings = settings;
        this.threshold = LEVEL_TO_SEVERITY[settings.level] ?? SYSLOG_DEBUG;
        if (changed) {
            this.closeSockets();
            this.lastError = null;
            this.lastTcpAttemptAt = 0;
        }
    }

    isEnabled(): boolean {
        return !!(this.settings?.enabled && this.settings.host && this.settings.port);
    }

    /** Whether a message of this severity would currently be sent. */
    wants(severity: number): boolean {
        return this.isEnabled() && severity <= this.threshold;
    }

    getLastError(): string | null {
        return this.lastError;
    }

    /** Fire-and-forget send. Never throws, never blocks. */
    send(severity: number, tag: string, message: string): void {
        if (!this.wants(severity)) {
            return;
        }
        const line = formatSyslogMessage(severity, tag, message);
        try {
            if (this.settings!.protocol === 'tcp') {
                this.sendTcp(line);
            } else {
                this.sendUdp(line);
            }
        } catch (e: any) {
            this.lastError = e?.message || String(e);
        }
    }

    close(): void {
        this.closeSockets();
    }

    private sendUdp(line: string): void {
        if (!this.udpSocket) {
            this.udpSocket = dgram.createSocket(net.isIPv6(this.settings!.host) ? 'udp6' : 'udp4');
            this.udpSocket.on('error', (e) => {
                this.lastError = e.message;
            });
            this.udpSocket.unref();
        }
        this.udpSocket.send(line, this.settings!.port, this.settings!.host, (e) => {
            if (e) this.lastError = e.message;
        });
    }

    private sendTcp(line: string): void {
        if (!this.tcpSocket) {
            const now = Date.now();
            if (now - this.lastTcpAttemptAt < TCP_RECONNECT_MIN_MS) {
                return; // drop instead of hammering an unreachable collector
            }
            this.lastTcpAttemptAt = now;
            const socket = net.connect({ host: this.settings!.host, port: this.settings!.port });
            socket.setNoDelay(true);
            socket.unref();
            socket.on('connect', () => {
                this.lastError = null;
            });
            socket.on('error', (e) => {
                this.lastError = e.message;
            });
            socket.on('close', () => {
                if (this.tcpSocket === socket) {
                    this.tcpSocket = null;
                }
            });
            this.tcpSocket = socket;
        }
        // net buffers writes while connecting; cap it so an unreachable server
        // can't grow memory unboundedly.
        if (this.tcpSocket.writableLength > TCP_MAX_BUFFERED_BYTES) {
            return;
        }
        // Newline framing (RFC 6587 non-transparent) — what rsyslog/syslog-ng
        // and the hosted collectors expect by default.
        this.tcpSocket.write(`${line}\n`);
    }

    private closeSockets(): void {
        if (this.udpSocket) {
            try { this.udpSocket.close(); } catch (_) { /* already closed */ }
            this.udpSocket = null;
        }
        if (this.tcpSocket) {
            try { this.tcpSocket.destroy(); } catch (_) { /* already closed */ }
            this.tcpSocket = null;
        }
    }
}

/** The app-wide transport every Logger instance forwards into. */
export const remoteLog = new RemoteLogTransport();

export interface RemoteLogTestRequest {
    host?: string;
    port?: string | number;
    protocol?: string;
}

export interface RemoteLogTestResult {
    ok: boolean;
    message: string;
}

/**
 * Send one INFO test line with the given (possibly unsaved) settings-form
 * values, for the settings page's Test button. TCP gives a real verdict
 * (connect + write or a named error); UDP is connectionless, so "sent"
 * only means the datagram left the box. Never throws.
 */
export function sendTestLogLine(req: RemoteLogTestRequest): Promise<RemoteLogTestResult> {
    const host = (req.host || '').toString().trim();
    const port = parseInt(String(req.port), 10);
    if (!host || !port || port < 1 || port > 65535) {
        return Promise.resolve({ ok: false, message: 'A server address and port are required' });
    }
    const line = formatSyslogMessage(SYSLOG_INFO, 'TEST', 'Test message from the AI Voice Assistant Homey app — remote logging is configured correctly');

    if (req.protocol === 'tcp') {
        return new Promise((resolve) => {
            const socket = net.connect({ host, port });
            let settled = false;
            const done = (ok: boolean, message: string) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                resolve({ ok, message });
            };
            socket.setTimeout(4000, () => done(false, `Connection to ${host}:${port} timed out`));
            socket.on('connect', () => {
                socket.write(`${line}\n`, () => done(true, `Test line delivered to ${host}:${port} over TCP`));
            });
            socket.on('error', (e) => done(false, e.message));
        });
    }

    return new Promise((resolve) => {
        const socket = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
        socket.send(line, port, host, (e) => {
            try { socket.close(); } catch (_) { /* already closed */ }
            if (e) {
                resolve({ ok: false, message: e.message });
            } else {
                resolve({ ok: true, message: `Test line sent to ${host}:${port} over UDP — check that it arrived at your log server (UDP gives no delivery confirmation)` });
            }
        });
    });
}

/** Parse the raw global-settings snapshot into transport settings and apply. */
export function configureRemoteLogFromSettings(globals: Record<string, any>): void {
    remoteLog.configure({
        enabled: globals.remote_log_enabled === true || globals.remote_log_enabled === 'true',
        host: (globals.remote_log_host || '').toString().trim(),
        port: parseInt(globals.remote_log_port, 10) || 514,
        protocol: globals.remote_log_protocol === 'tcp' ? 'tcp' : 'udp',
        level: (['error', 'warn', 'info', 'debug'].includes(globals.remote_log_level)
            ? globals.remote_log_level : 'debug') as RemoteLogLevel,
    });
}
