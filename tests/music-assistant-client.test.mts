import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { MusicAssistantClient } from '../src/helpers/music-assistant-client.mjs';

/**
 * Exercises the MA WebSocket client against a scripted in-process server:
 * server-info handshake, command/result correlation, partial-result
 * accumulation, error results, and the shape mapping of the high-level calls.
 */

type CommandHandler = (msg: any, socket: WebSocket) => void;

class FakeMaServer {
    private wss!: WebSocketServer;
    port = 0;
    received: any[] = [];
    onCommand: CommandHandler = () => { };

    async start(): Promise<void> {
        this.wss = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => this.wss.once('listening', resolve));
        this.port = (this.wss.address() as AddressInfo).port;
        this.wss.on('connection', (socket) => {
            // First frame: the server info message, like the real server.
            socket.send(JSON.stringify({
                server_id: 'test', server_version: '2.7.0', schema_version: 34,
                min_supported_schema_version: 24, base_url: `http://127.0.0.1:${this.port}`,
            }));
            socket.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                this.received.push(msg);
                this.onCommand(msg, socket);
            });
        });
    }

    async stop(): Promise<void> {
        await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    }
}

describe('MusicAssistantClient', () => {
    let server: FakeMaServer;
    let client: MusicAssistantClient;

    beforeEach(async () => {
        server = new FakeMaServer();
        await server.start();
        client = new MusicAssistantClient();
        client.configure('127.0.0.1', server.port);
    });

    afterEach(async () => {
        client.disconnect();
        await server.stop();
    });

    it('rejects when not configured', async () => {
        const bare = new MusicAssistantClient();
        await expect(bare.sendCommand('players/all')).rejects.toThrow(/not configured/i);
    });

    it('sends a command after the server-info handshake and resolves its result', async () => {
        server.onCommand = (msg, socket) => {
            socket.send(JSON.stringify({ message_id: msg.message_id, result: { pong: true } }));
        };
        const result = await client.sendCommand<any>('ping');
        expect(result).toEqual({ pong: true });
        expect(server.received[0].command).toBe('ping');
    });

    it('correlates concurrent commands by message_id', async () => {
        server.onCommand = (msg, socket) => {
            // Answer in reverse order to prove correlation is by id, not order.
            setTimeout(() => {
                socket.send(JSON.stringify({ message_id: msg.message_id, result: msg.command }));
            }, msg.command === 'first' ? 30 : 5);
        };
        const [a, b] = await Promise.all([
            client.sendCommand('first'),
            client.sendCommand('second'),
        ]);
        expect(a).toBe('first');
        expect(b).toBe('second');
    });

    it('accumulates partial list results', async () => {
        server.onCommand = (msg, socket) => {
            socket.send(JSON.stringify({ message_id: msg.message_id, partial: true, result: [1, 2] }));
            socket.send(JSON.stringify({ message_id: msg.message_id, partial: true, result: [3] }));
            socket.send(JSON.stringify({ message_id: msg.message_id, result: [4] }));
        };
        const result = await client.sendCommand<number[]>('big/list');
        expect(result).toEqual([1, 2, 3, 4]);
    });

    it('rejects on an error result with the server details', async () => {
        server.onCommand = (msg, socket) => {
            socket.send(JSON.stringify({ message_id: msg.message_id, error_code: 'InvalidCommand', details: 'no such command' }));
        };
        await expect(client.sendCommand('bogus')).rejects.toThrow(/no such command/);
    });

    it('ignores unsolicited event frames', async () => {
        server.onCommand = (msg, socket) => {
            socket.send(JSON.stringify({ event: 'player_updated', object_id: 'x', data: {} }));
            socket.send(JSON.stringify({ message_id: msg.message_id, result: 'ok' }));
        };
        await expect(client.sendCommand('anything')).resolves.toBe('ok');
    });

    it('maps players/all to the compact player shape', async () => {
        server.onCommand = (msg, socket) => {
            socket.send(JSON.stringify({
                message_id: msg.message_id,
                result: [
                    {
                        player_id: 'p1', display_name: 'Kitchen speaker', provider: 'sendspin',
                        available: true, playback_state: 'playing',
                        device_info: { ip_address: '192.168.1.60', mac_address: 'AA:BB' },
                    },
                    { player_id: '', name: 'ghost' }, // dropped: no id
                ],
            }));
        };
        const players = await client.getPlayers();
        expect(players).toHaveLength(1);
        expect(players[0]).toEqual({
            playerId: 'p1', name: 'Kitchen speaker', provider: 'sendspin',
            available: true, state: 'playing', ipAddress: '192.168.1.60', macAddress: 'AA:BB',
        });
    });

    it('maps music/search results and flattens artists', async () => {
        server.onCommand = (msg, socket) => {
            expect(msg.command).toBe('music/search');
            expect(msg.args.search_query).toBe('abbey road');
            expect(msg.args.media_types).toEqual(['album']);
            socket.send(JSON.stringify({
                message_id: msg.message_id,
                result: {
                    albums: [{
                        uri: 'spotify://album/1', name: 'Abbey Road', media_type: 'album',
                        artists: [{ name: 'The Beatles' }],
                    }],
                    tracks: [], artists: [], playlists: [], radio: [],
                },
            }));
        };
        const results = await client.search('abbey road', ['album']);
        expect(results.albums).toHaveLength(1);
        expect(results.albums[0].artists).toBe('The Beatles');
        expect(results.tracks).toEqual([]);
    });

    it('describes the active queue including the current item', async () => {
        server.onCommand = (msg, socket) => {
            expect(msg.command).toBe('player_queues/get_active_queue');
            socket.send(JSON.stringify({
                message_id: msg.message_id,
                result: {
                    queue_id: 'q1', active: true, state: 'playing', shuffle_enabled: false,
                    repeat_mode: 'off', items: 12,
                    current_item: {
                        media_item: {
                            uri: 'x', name: 'Come Together', media_type: 'track',
                            artists: [{ name: 'The Beatles' }], album: { name: 'Abbey Road' },
                        },
                    },
                },
            }));
        };
        const queue = await client.getActiveQueue('p1');
        expect(queue.queueId).toBe('q1');
        expect(queue.nowPlaying).toBe('Come Together — The Beatles (Abbey Road)');
        expect(queue.itemsInQueue).toBe(12);
    });

    it('sends play_media and queue transport commands with the right args', async () => {
        server.onCommand = (msg, socket) => {
            socket.send(JSON.stringify({ message_id: msg.message_id, result: null }));
        };
        await client.playMedia('q1', 'library://album/5', 'next', true);
        await client.queueCommand('q1', 'pause');
        await client.setShuffle('q1', true);

        const [play, pause, shuffle] = server.received;
        expect(play.command).toBe('player_queues/play_media');
        expect(play.args).toEqual({ queue_id: 'q1', media: 'library://album/5', option: 'next', radio_mode: true });
        expect(pause.command).toBe('player_queues/pause');
        expect(pause.args).toEqual({ queue_id: 'q1' });
        expect(shuffle.command).toBe('player_queues/shuffle');
        expect(shuffle.args).toEqual({ queue_id: 'q1', shuffle_enabled: true });
    });

    it('reconnects for the next command after the server drops the connection', async () => {
        let calls = 0;
        server.onCommand = (msg, socket) => {
            calls++;
            if (calls === 1) {
                socket.send(JSON.stringify({ message_id: msg.message_id, result: 'one' }));
                socket.close();
            } else {
                socket.send(JSON.stringify({ message_id: msg.message_id, result: 'two' }));
            }
        };
        await expect(client.sendCommand('a')).resolves.toBe('one');
        // Give the close a tick to land, then the next command must reconnect.
        await new Promise((r) => setTimeout(r, 50));
        await expect(client.sendCommand('b')).resolves.toBe('two');
    });
});
