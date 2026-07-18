import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'dgram';
import net from 'net';
import {
    formatSyslogMessage, sendTestLogLine, remoteLog, RemoteLogTransport,
    SYSLOG_ERROR, SYSLOG_WARNING, SYSLOG_INFO, SYSLOG_DEBUG,
} from '../src/helpers/remote-log.mjs';
import { createLogger } from '../src/helpers/logger.mjs';

/** Bind a UDP server on an ephemeral loopback port and collect datagrams. */
function startUdpServer(): Promise<{ port: number; messages: string[]; waitFor: (count: number) => Promise<string[]>; close: () => void }> {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        const messages: string[] = [];
        let pending: { count: number; resolve: (m: string[]) => void } | null = null;
        socket.on('message', (buf) => {
            messages.push(buf.toString());
            if (pending && messages.length >= pending.count) {
                pending.resolve(messages);
                pending = null;
            }
        });
        socket.bind(0, '127.0.0.1', () => {
            resolve({
                port: socket.address().port,
                messages,
                waitFor: (count: number) => new Promise((res, rej) => {
                    if (messages.length >= count) return res(messages);
                    pending = { count, resolve: res };
                    setTimeout(() => rej(new Error(`timed out waiting for ${count} datagrams (got ${messages.length})`)), 3000);
                }),
                close: () => socket.close(),
            });
        });
    });
}

/** Bind a TCP server on an ephemeral loopback port and collect newline-framed lines. */
function startTcpServer(): Promise<{ port: number; lines: string[]; waitFor: (count: number) => Promise<string[]>; close: () => void }> {
    return new Promise((resolve) => {
        const lines: string[] = [];
        let buffer = '';
        let pending: { count: number; resolve: (m: string[]) => void } | null = null;
        const server = net.createServer((socket) => {
            socket.on('data', (chunk) => {
                buffer += chunk.toString();
                let idx;
                while ((idx = buffer.indexOf('\n')) >= 0) {
                    lines.push(buffer.slice(0, idx));
                    buffer = buffer.slice(idx + 1);
                }
                if (pending && lines.length >= pending.count) {
                    pending.resolve(lines);
                    pending = null;
                }
            });
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({
                port: (server.address() as net.AddressInfo).port,
                lines,
                waitFor: (count: number) => new Promise((res, rej) => {
                    if (lines.length >= count) return res(lines);
                    pending = { count, resolve: res };
                    setTimeout(() => rej(new Error(`timed out waiting for ${count} lines (got ${lines.length})`)), 3000);
                }),
                close: () => server.close(),
            });
        });
    });
}

const disabledSettings = { enabled: false, host: '', port: 514, protocol: 'udp' as const, level: 'debug' as const };

afterEach(() => {
    // The Logger forwards into the shared singleton — leave it off between tests.
    remoteLog.configure(disabledSettings);
    remoteLog.close();
});

describe('formatSyslogMessage', () => {
    it('builds an RFC 5424 line with facility local0 and the severity in PRI', () => {
        const line = formatSyslogMessage(SYSLOG_INFO, 'CONVO', 'hello world', new Date('2026-07-18T10:00:00.123Z'));
        // local0 = 16 → PRI = 16*8 + 6 = 134
        expect(line).toMatch(/^<134>1 2026-07-18T10:00:00\.123Z \S+ ai-voice-assistant \d+ CONVO - hello world$/);
        expect(formatSyslogMessage(SYSLOG_ERROR, 'X', 'm')).toMatch(/^<131>/);
        expect(formatSyslogMessage(SYSLOG_WARNING, 'X', 'm')).toMatch(/^<132>/);
        expect(formatSyslogMessage(SYSLOG_DEBUG, 'X', 'm')).toMatch(/^<135>/);
    });

    it('strips ANSI colors and collapses newlines to a single line', () => {
        const line = formatSyslogMessage(SYSLOG_INFO, 'T', '\x1b[36mcolored\x1b[0m line one\nline two');
        expect(line.endsWith('colored line one line two')).toBe(true);
        expect(line).not.toContain('\x1b');
        expect(line).not.toContain('\n');
    });

    it('sanitizes the tag into a legal MSGID (no spaces, max 32 chars)', () => {
        const line = formatSyslogMessage(SYSLOG_INFO, 'My Logger Ω', 'm');
        expect(line).toContain(' My_Logger__ - ');
    });

    it('truncates oversized messages instead of producing giant datagrams', () => {
        const line = formatSyslogMessage(SYSLOG_INFO, 'T', 'x'.repeat(20000));
        expect(Buffer.byteLength(line)).toBeLessThanOrEqual(8 * 1024);
        expect(line.endsWith('…')).toBe(true);
    });
});

describe('RemoteLogTransport', () => {
    it('sends UDP datagrams when enabled and respects the level threshold', async () => {
        const server = await startUdpServer();
        const transport = new RemoteLogTransport();
        transport.configure({ enabled: true, host: '127.0.0.1', port: server.port, protocol: 'udp', level: 'info' });

        expect(transport.wants(SYSLOG_INFO)).toBe(true);
        expect(transport.wants(SYSLOG_DEBUG)).toBe(false);

        transport.send(SYSLOG_DEBUG, 'SUB', 'dropped by level filter');
        transport.send(SYSLOG_INFO, 'CONVO', 'kept');
        const messages = await server.waitFor(1);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('CONVO - kept');

        transport.close();
        server.close();
    });

    it('sends newline-framed lines over TCP', async () => {
        const server = await startTcpServer();
        const transport = new RemoteLogTransport();
        transport.configure({ enabled: true, host: '127.0.0.1', port: server.port, protocol: 'tcp', level: 'debug' });

        transport.send(SYSLOG_INFO, 'A', 'first');
        transport.send(SYSLOG_DEBUG, 'B', 'second');
        const lines = await server.waitFor(2);
        expect(lines[0]).toContain('A - first');
        expect(lines[1]).toContain('B - second');

        transport.close();
        server.close();
    });

    it('does nothing (and never throws) while disabled or unconfigured', () => {
        const transport = new RemoteLogTransport();
        expect(() => transport.send(SYSLOG_ERROR, 'T', 'no config')).not.toThrow();
        transport.configure(disabledSettings);
        expect(transport.isEnabled()).toBe(false);
        expect(() => transport.send(SYSLOG_ERROR, 'T', 'still off')).not.toThrow();
    });
});

describe('Logger → remote syslog forwarding', () => {
    it('maps enabled-logger info to INFO and disabled-logger info to DEBUG', async () => {
        const server = await startUdpServer();
        remoteLog.configure({ enabled: true, host: '127.0.0.1', port: server.port, protocol: 'udp', level: 'debug' });

        const convo = createLogger('CONVO-RL');      // enabled → console + INFO
        const sub = createLogger('SUB-RL', true);    // disabled → DEBUG only, no console

        convo.info('turn complete', 'END');
        sub.info('protobuf frame parsed');
        sub.warn('reconnecting');
        sub.error('gave up', new Error('boom'));

        const messages = await server.waitFor(4);
        const byTag = (tag: string) => messages.filter((m) => m.includes(` ${tag} `));
        expect(byTag('CONVO-RL')[0]).toMatch(/^<134>/);            // INFO
        expect(byTag('CONVO-RL')[0]).toContain('[END] turn complete');
        expect(byTag('SUB-RL').find((m) => m.includes('protobuf'))).toMatch(/^<135>/); // DEBUG
        expect(byTag('SUB-RL').find((m) => m.includes('reconnecting'))).toMatch(/^<132>/); // WARNING
        expect(byTag('SUB-RL').find((m) => m.includes('gave up'))).toMatch(/^<131>/); // ERROR

        server.close();
    });

    it('drops disabled-logger chatter when the remote level is info', async () => {
        const server = await startUdpServer();
        remoteLog.configure({ enabled: true, host: '127.0.0.1', port: server.port, protocol: 'udp', level: 'info' });

        const sub = createLogger('SUB-RL2', true);
        sub.info('debug-only chatter');
        const convo = createLogger('CONVO-RL2');
        convo.info('kept at info');

        const messages = await server.waitFor(1);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('kept at info');

        server.close();
    });

    it('masks secret-looking detail fields on the remote path too', async () => {
        const server = await startUdpServer();
        remoteLog.configure({ enabled: true, host: '127.0.0.1', port: server.port, protocol: 'udp', level: 'debug' });

        const sub = createLogger('SUB-RL3', true);
        sub.info('session config', '', { api_key: 'sk-proj-supersecretvalue123', model: 'gpt' });

        const messages = await server.waitFor(1);
        expect(messages[0]).not.toContain('supersecret');
        expect(messages[0]).toContain('sk-p');
        expect(messages[0]).toContain('model');

        server.close();
    });
});

describe('sendTestLogLine', () => {
    it('reports success for a reachable UDP target', async () => {
        const server = await startUdpServer();
        const result = await sendTestLogLine({ host: '127.0.0.1', port: server.port, protocol: 'udp' });
        expect(result.ok).toBe(true);
        const messages = await server.waitFor(1);
        expect(messages[0]).toContain('Test message from the AI Voice Assistant');
        server.close();
    });

    it('delivers over TCP and fails cleanly against a closed port', async () => {
        const server = await startTcpServer();
        const ok = await sendTestLogLine({ host: '127.0.0.1', port: server.port, protocol: 'tcp' });
        expect(ok.ok).toBe(true);
        await server.waitFor(1);
        const closedPort = server.port;
        server.close();
        // Give the OS a beat to release the listener before probing it.
        await new Promise((r) => setTimeout(r, 50));
        const fail = await sendTestLogLine({ host: '127.0.0.1', port: closedPort, protocol: 'tcp' });
        expect(fail.ok).toBe(false);
        expect(fail.message).toBeTruthy();
    });

    it('rejects missing host or port without touching the network', async () => {
        expect((await sendTestLogLine({ host: '', port: 514 })).ok).toBe(false);
        expect((await sendTestLogLine({ host: 'example.com', port: 'nope' })).ok).toBe(false);
    });
});
