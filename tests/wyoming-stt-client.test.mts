import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { WyomingSttClient } from '../src/llm/providers/local/wyoming-stt-client.mjs';
import { WyomingTtsClient } from '../src/llm/providers/local/wyoming-tts-client.mjs';

/**
 * In-process fake Wyoming server: real TCP, real newline-JSON framing with
 * payload_length — exactly what rhasspy/wyoming-faster-whisper speaks. This
 * exercises the client's socket handling end-to-end instead of mocking it.
 */

interface FakeEvent { type: string; data: any; payload: Buffer | null; }

class FakeWyomingServer {
    server!: net.Server;
    port = 0;
    received: FakeEvent[] = [];
    /** The most recent client socket, for tests that write raw frames. */
    lastSocket: net.Socket | null = null;
    /** Called whenever an event arrives; may send replies via the socket writer. */
    onEvent: (event: FakeEvent, send: (type: string, data?: any, payload?: Buffer) => void) => void = () => { };

    async start(): Promise<void> {
        this.server = net.createServer((socket) => {
            this.lastSocket = socket;
            let buffer = Buffer.alloc(0);
            const send = (type: string, data?: any, payload?: Buffer) => {
                const header: any = { type };
                if (data !== undefined) header.data = data;
                if (payload?.length) header.payload_length = payload.length;
                socket.write(JSON.stringify(header) + '\n');
                if (payload?.length) socket.write(payload);
            };
            socket.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                for (; ;) {
                    const nl = buffer.indexOf(0x0a);
                    if (nl < 0) return;
                    const header = JSON.parse(buffer.subarray(0, nl).toString());
                    const payloadLength = header.payload_length || 0;
                    if (buffer.length < nl + 1 + payloadLength) return;
                    const payload = payloadLength ? Buffer.from(buffer.subarray(nl + 1, nl + 1 + payloadLength)) : null;
                    buffer = buffer.subarray(nl + 1 + payloadLength);
                    const event = { type: header.type, data: header.data ?? {}, payload };
                    this.received.push(event);
                    this.onEvent(event, send);
                }
            });
        });
        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
        this.port = (this.server.address() as net.AddressInfo).port;
    }

    stop(): Promise<void> {
        return new Promise((resolve) => this.server.close(() => resolve()));
    }
}

let server: FakeWyomingServer;

afterEach(async () => {
    await server?.stop().catch(() => { });
});

describe('WyomingSttClient', () => {
    it('runs the transcribe flow and returns the transcript', async () => {
        server = new FakeWyomingServer();
        await server.start();
        server.onEvent = (event, send) => {
            if (event.type === 'audio-stop') {
                send('transcript', { text: ' skru på lyset ' });
            }
        };

        const client = new WyomingSttClient({ host: '127.0.0.1', port: server.port });
        const pcm = Buffer.alloc(8000); // 250 ms @16k — spans multiple chunks
        const text = await client.transcribe(pcm, 'no');
        expect(text).toBe('skru på lyset');

        // Protocol sequence and framing arrived intact on the server side.
        const types = server.received.map((e) => e.type);
        expect(types[0]).toBe('transcribe');
        expect(server.received[0].data.language).toBe('no');
        expect(types[1]).toBe('audio-start');
        expect(server.received[1].data).toMatchObject({ rate: 16000, width: 2, channels: 1 });
        expect(types[types.length - 1]).toBe('audio-stop');
        const chunks = server.received.filter((e) => e.type === 'audio-chunk');
        expect(chunks.length).toBeGreaterThanOrEqual(2);
        expect(chunks.reduce((n, c) => n + (c.payload?.length ?? 0), 0)).toBe(pcm.length);
    });

    it('supports streaming servers (last transcript-chunk wins on transcript-stop)', async () => {
        server = new FakeWyomingServer();
        await server.start();
        server.onEvent = (event, send) => {
            if (event.type === 'audio-stop') {
                send('transcript-start', {});
                send('transcript-chunk', { text: 'turn off' });
                send('transcript-chunk', { text: 'turn off the lights' });
                send('transcript-stop');
            }
        };

        const client = new WyomingSttClient({ host: '127.0.0.1', port: server.port });
        expect(await client.transcribe(Buffer.alloc(3200), 'en')).toBe('turn off the lights');
    });

    it('check() passes only when describe answers with an asr-capable info', async () => {
        server = new FakeWyomingServer();
        await server.start();
        server.onEvent = (event, send) => {
            if (event.type === 'describe') {
                send('info', { asr: [{ name: 'faster-whisper', installed: true }], tts: [] });
            }
        };

        const client = new WyomingSttClient({ host: '127.0.0.1', port: server.port });
        await expect(client.check()).resolves.toBeUndefined();
    });

    it('check() rejects a Wyoming service with no STT programs', async () => {
        server = new FakeWyomingServer();
        await server.start();
        server.onEvent = (event, send) => {
            if (event.type === 'describe') send('info', { asr: [], tts: [{ name: 'piper' }] });
        };

        const client = new WyomingSttClient({ host: '127.0.0.1', port: server.port });
        await expect(client.check()).rejects.toThrow(/no STT/);
    });

    it('rejects cleanly when nothing listens on the port', async () => {
        const client = new WyomingSttClient({ host: '127.0.0.1', port: 1 }); // nothing there
        await expect(client.transcribe(Buffer.alloc(320), 'en')).rejects.toThrow();
    });

    it('WyomingTtsClient: synthesize collects the audio-chunk stream into PCM', async () => {
        server = new FakeWyomingServer();
        await server.start();
        const clip = Buffer.alloc(22050); // 0.5 s @22050 PCM16 mono
        server.onEvent = (event, send) => {
            if (event.type === 'synthesize') {
                expect(event.data.text).toBe('Hei på deg.');
                send('audio-start', { rate: 22050, width: 2, channels: 1 });
                send('audio-chunk', { rate: 22050, width: 2, channels: 1 }, clip.subarray(0, 10000));
                send('audio-chunk', { rate: 22050, width: 2, channels: 1 }, clip.subarray(10000));
                send('audio-stop', {});
            }
        };

        const client = new WyomingTtsClient({ host: '127.0.0.1', port: server.port });
        const { pcm, sampleRate } = await client.synthesize('Hei på deg.');
        expect(sampleRate).toBe(22050);
        expect(pcm.length).toBe(clip.length);
    });

    it('WyomingTtsClient: check() requires a tts-capable info', async () => {
        server = new FakeWyomingServer();
        await server.start();
        server.onEvent = (event, send) => {
            if (event.type === 'describe') send('info', { asr: [{ name: 'faster-whisper' }], tts: [] });
        };
        const client = new WyomingTtsClient({ host: '127.0.0.1', port: server.port });
        await expect(client.check()).rejects.toThrow(/no TTS/);

        server.onEvent = (event, send) => {
            if (event.type === 'describe') send('info', { tts: [{ name: 'piper', installed: true }] });
        };
        await expect(client.check()).resolves.toBeUndefined();
    });

    it('parses events that arrive with data_length side-band JSON', async () => {
        server = new FakeWyomingServer();
        await server.start();
        server.onEvent = (event) => {
            if (event.type === 'audio-stop') {
                // Emulate the wyoming lib's data_length framing: the header
                // carries only lengths, the data JSON follows as its own block.
                const dataBytes = Buffer.from(JSON.stringify({ text: 'hello world' }));
                server.lastSocket!.write(JSON.stringify({ type: 'transcript', data_length: dataBytes.length }) + '\n');
                server.lastSocket!.write(dataBytes);
            }
        };

        const client = new WyomingSttClient({ host: '127.0.0.1', port: server.port });
        expect(await client.transcribe(Buffer.alloc(320), 'en')).toBe('hello world');
    });
});
