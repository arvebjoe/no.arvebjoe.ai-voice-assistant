import WebSocket from 'ws';
import { createLogger } from './logger.mjs';

/**
 * Minimal client for the Music Assistant server WebSocket API.
 *
 * MA exposes a JSON command/response API on ws://<host>:<port>/ws (default port
 * 8095; the same API the MA web frontend uses — self-documenting at
 * http://<host>:<port>/api-docs). Only the handful of calls the voice
 * assistant needs are implemented: list players, search the library/providers,
 * start playback on a queue, and transport control (pause/resume/next/…).
 *
 * The music AUDIO never touches this app: both the Voice PE and the
 * ThirdReality speaker are native Sendspin players, so the MA server streams
 * to them directly. This client is the control plane only.
 *
 * Protocol (see music-assistant/models api.py):
 *  - server → first frame: ServerInfoMessage { server_id, server_version, … }
 *  - client → CommandMessage { message_id, command, args }
 *  - server → SuccessResultMessage { message_id, result, partial? }
 *            | ErrorResultMessage { message_id, error_code, details }
 *  - server → EventMessage { event, object_id, data } (unsolicited; ignored)
 *
 * The connection is opened lazily on the first command and reused; when it
 * drops, the next command reconnects. All commands time out rather than hang.
 */

const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 15_000;
// play_media resolves the media server-side BEFORE answering (an artist's
// full catalog is fetched from the streaming provider on first play) — 27-42s
// observed on a real MA 2.9.9, and big catalogs exceed any sane wait. This is
// therefore NOT a failure boundary but "how long we make the user wait":
// on timeout the play_music tool reports status 'preparing' (the command
// completes late server-side and the music starts by itself).
const PLAY_MEDIA_TIMEOUT_MS = 30_000;
// MA requires an `auth` command as the first message from API schema 28
// (server 2.9+): https://github.com/music-assistant/client — the token is a
// long-lived token created in the MA web UI (profile → long-lived tokens).
// Older servers (2.7/2.8) have no auth command and are connected to directly.
const AUTH_MIN_SCHEMA = 28;

/** A queue transport action supported by `queueCommand`. */
export type MaQueueCommand = 'pause' | 'play' | 'resume' | 'stop' | 'next' | 'previous';

export interface MaPlayer {
    playerId: string;
    name: string;
    provider: string;
    available: boolean;
    /** idle | paused | playing | unknown */
    state: string;
    ipAddress: string;
    macAddress: string;
}

export interface MaMediaItem {
    uri: string;
    name: string;
    /** artist | album | track | playlist | radio | … */
    mediaType: string;
    /** Flattened artist name(s), when the item has any. */
    artists: string;
    /** Album name, for tracks. */
    album: string;
}

export interface MaSearchResults {
    artists: MaMediaItem[];
    albums: MaMediaItem[];
    tracks: MaMediaItem[];
    playlists: MaMediaItem[];
    radio: MaMediaItem[];
}

export interface MaQueueState {
    queueId: string;
    active: boolean;
    /** idle | paused | playing | unknown */
    state: string;
    shuffleEnabled: boolean;
    repeatMode: string;
    /** Compact "Track — Artist (Album)" description of the current item. */
    nowPlaying: string | null;
    /** Items remaining in the queue (including the current one). */
    itemsInQueue: number;
}

interface PendingCommand {
    resolve: (result: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    /** Accumulates list results delivered in `partial` chunks. */
    partialResult?: any;
}

/** Map a raw MA media item (or ItemMapping) to the compact shape the LLM sees. */
function toMediaItem(raw: any): MaMediaItem {
    const artists = Array.isArray(raw?.artists)
        ? raw.artists.map((a: any) => a?.name).filter(Boolean).join(', ')
        : '';
    return {
        uri: String(raw?.uri ?? ''),
        name: String(raw?.name ?? ''),
        mediaType: String(raw?.media_type ?? 'unknown'),
        artists,
        album: String(raw?.album?.name ?? ''),
    };
}

function toPlayer(raw: any): MaPlayer {
    return {
        playerId: String(raw?.player_id ?? ''),
        // `display_name` is the serialization alias MA adds for `name`.
        name: String(raw?.display_name ?? raw?.name ?? ''),
        provider: String(raw?.provider ?? ''),
        available: raw?.available === true,
        state: String(raw?.playback_state ?? raw?.state ?? 'unknown'),
        ipAddress: String(raw?.device_info?.ip_address ?? ''),
        macAddress: String(raw?.device_info?.mac_address ?? ''),
    };
}

/** "Track — Artist (Album)" for a raw queue item, or null when idle. */
function describeQueueItem(raw: any): string | null {
    const media = raw?.media_item ?? raw;
    if (!media?.name) return null;
    const item = toMediaItem(media);
    let text = item.name;
    if (item.artists) text += ` — ${item.artists}`;
    if (item.album) text += ` (${item.album})`;
    return text;
}

export class MusicAssistantClient {
    private logger = createLogger('MusicAssistant', true);
    private host = '';
    private port = 8095;
    private token = '';
    private ws: WebSocket | null = null;
    private connectPromise: Promise<void> | null = null;
    private messageId = 0;
    private pending: Map<string, PendingCommand> = new Map();
    private serverVersion = '';

    /**
     * Update the server address/token. Closes any open connection when
     * something actually changed so the next command reconnects (and
     * re-authenticates) against the new config.
     */
    configure(host: string, port: number, token = ''): void {
        const h = (host || '').trim();
        const p = Number(port) > 0 ? Number(port) : 8095;
        const t = (token || '').trim();
        if (h === this.host && p === this.port && t === this.token) {
            return;
        }
        this.host = h;
        this.port = p;
        this.token = t;
        this.disconnect();
    }

    hasConfig(): boolean {
        return this.host.length > 0;
    }

    /** Tear down the socket and fail anything still in flight. */
    disconnect(): void {
        const ws = this.ws;
        this.ws = null;
        this.connectPromise = null;
        this.failAllPending(new Error('Connection to Music Assistant closed.'));
        if (ws) {
            try { ws.close(); } catch { /* already closing */ }
        }
    }

    private failAllPending(err: Error): void {
        for (const [, cmd] of this.pending) {
            clearTimeout(cmd.timer);
            cmd.reject(err);
        }
        this.pending.clear();
    }

    /** Open the socket (if needed) and wait for the server-info frame. */
    private ensureConnected(): Promise<void> {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }
        if (this.connectPromise) {
            return this.connectPromise;
        }
        if (!this.hasConfig()) {
            return Promise.reject(new Error('Music Assistant is not configured — set the server address in the app settings.'));
        }

        const url = `ws://${this.host}:${this.port}/ws`;
        this.connectPromise = new Promise<void>((resolve, reject) => {
            this.logger.info(`Connecting to ${url}`);
            const ws = new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT_MS });
            let settled = false;

            const fail = (err: Error) => {
                if (!settled) {
                    settled = true;
                    this.ws = null;
                    this.connectPromise = null;
                    reject(err);
                }
            };

            // Resolve on the ServerInfoMessage, not on 'open': the server is
            // only ready for commands once it has sent its info frame — and on
            // schema >= 28 only after our `auth` command was accepted.
            const timer = setTimeout(() => {
                try { ws.close(); } catch { /* noop */ }
                fail(new Error(`Music Assistant at ${this.host}:${this.port} did not answer within ${CONNECT_TIMEOUT_MS / 1000}s.`));
            }, CONNECT_TIMEOUT_MS);

            const succeed = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve();
                }
            };

            let gotServerInfo = false;
            let authMessageId = '';

            ws.on('message', (data: WebSocket.RawData) => {
                let msg: any;
                try {
                    msg = JSON.parse(data.toString());
                } catch {
                    this.logger.warn('Ignoring non-JSON frame from Music Assistant');
                    return;
                }
                if (!gotServerInfo) {
                    // First frame is the server info.
                    gotServerInfo = true;
                    this.serverVersion = String(msg?.server_version ?? '');
                    const schema = Number(msg?.schema_version ?? 0);
                    this.logger.info(`Connected to Music Assistant ${this.serverVersion} (schema ${schema || '?'})`);
                    if (schema < AUTH_MIN_SCHEMA) {
                        succeed();
                        return;
                    }
                    if (!this.token) {
                        try { ws.close(); } catch { /* noop */ }
                        fail(new Error(`Music Assistant ${this.serverVersion} requires an API token — create a long-lived token in the MA web UI (your profile → long-lived tokens) and paste it into this app's Music Assistant settings.`));
                        return;
                    }
                    authMessageId = String(++this.messageId);
                    ws.send(JSON.stringify({ message_id: authMessageId, command: 'auth', args: { token: this.token } }));
                    return;
                }
                if (!settled && authMessageId && String(msg?.message_id ?? '') === authMessageId) {
                    // Auth verdict: an error result or a falsy result means the
                    // token was rejected (matches the official python client).
                    if ((msg.error_code !== undefined && msg.error_code !== null) || !msg.result) {
                        const details = msg.details ? ` (${msg.details})` : '';
                        try { ws.close(); } catch { /* noop */ }
                        fail(new Error(`Music Assistant rejected the API token${details} — create a new long-lived token in the MA web UI and update the app settings.`));
                        return;
                    }
                    this.logger.info('Authenticated with Music Assistant');
                    succeed();
                    return;
                }
                this.handleMessage(msg);
            });

            ws.on('error', (err: Error) => {
                this.logger.warn(`Music Assistant socket error: ${err.message}`);
                fail(new Error(`Could not reach Music Assistant at ${this.host}:${this.port} — ${err.message}`));
            });

            ws.on('close', () => {
                clearTimeout(timer);
                // Only fail pending commands when the closing socket is still the
                // current one — a stale socket's delayed 'close' (after a config
                // change already opened a replacement) must not reject commands
                // that belong to the new socket (code_review_2 M3).
                if (this.ws === ws) {
                    this.ws = null;
                    this.connectPromise = null;
                    this.failAllPending(new Error('Connection to Music Assistant closed.'));
                }
                fail(new Error(`Music Assistant at ${this.host}:${this.port} closed the connection.`));
            });

            this.ws = ws;
        });
        return this.connectPromise;
    }

    private handleMessage(msg: any): void {
        // Unsolicited events (player_updated, queue_updated, …) — not used.
        if (typeof msg?.event === 'string') {
            return;
        }
        const id = msg?.message_id != null ? String(msg.message_id) : '';
        const cmd = this.pending.get(id);
        if (!cmd) {
            return;
        }

        if (msg.error_code !== undefined && msg.error_code !== null) {
            clearTimeout(cmd.timer);
            this.pending.delete(id);
            const details = msg.details ? String(msg.details) : String(msg.error_code);
            cmd.reject(new Error(`Music Assistant error: ${details}`));
            return;
        }

        // Large list results arrive as several `partial` chunks followed by a
        // final (non-partial) message; concatenate arrays as they come in.
        if (msg.partial === true) {
            if (Array.isArray(msg.result)) {
                cmd.partialResult = Array.isArray(cmd.partialResult)
                    ? cmd.partialResult.concat(msg.result)
                    : [...msg.result];
            }
            return;
        }

        clearTimeout(cmd.timer);
        this.pending.delete(id);
        let result = msg.result;
        if (Array.isArray(cmd.partialResult) && Array.isArray(result)) {
            result = cmd.partialResult.concat(result);
        }
        cmd.resolve(result);
    }

    /** Send one command and await its result. */
    async sendCommand<T = any>(command: string, args?: Record<string, any>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
        await this.ensureConnected();
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error('Connection to Music Assistant is not open.');
        }

        const id = String(++this.messageId);
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                const err = new Error(`Music Assistant did not answer '${command}' within ${timeoutMs / 1000}s.`);
                // Distinguishable from a real error result: a timed-out command
                // usually COMPLETES late server-side (play_media keeps building
                // the queue), so callers may treat this as "still working".
                (err as any).code = 'MA_TIMEOUT';
                reject(err);
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            const payload: Record<string, any> = { message_id: id, command };
            if (args && Object.keys(args).length > 0) {
                payload.args = args;
            }
            ws.send(JSON.stringify(payload), (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(err);
                }
            });
        });
    }

    // ------------------------------------------------------------------
    // High-level calls (thin wrappers over the MA command names)
    // ------------------------------------------------------------------

    /** All players known to the MA server. */
    async getPlayers(): Promise<MaPlayer[]> {
        const raw = await this.sendCommand<any[]>('players/all');
        return (Array.isArray(raw) ? raw : []).map(toPlayer).filter(p => p.playerId);
    }

    /**
     * Global search across the library and all music providers.
     * `mediaTypes` filters the kinds returned (artist/album/track/playlist/radio).
     */
    async search(query: string, mediaTypes?: string[], limit = 8): Promise<MaSearchResults> {
        const args: Record<string, any> = { search_query: query, limit };
        if (mediaTypes && mediaTypes.length > 0) {
            args.media_types = mediaTypes;
        }
        const raw = await this.sendCommand<any>('music/search', args);
        const list = (key: string): MaMediaItem[] =>
            (Array.isArray(raw?.[key]) ? raw[key] : []).map(toMediaItem).filter((i: MaMediaItem) => i.uri);
        return {
            artists: list('artists'),
            albums: list('albums'),
            tracks: list('tracks'),
            playlists: list('playlists'),
            radio: list('radio'),
        };
    }

    /**
     * The queue that is currently active for a player (its own queue, or the
     * group leader's when the player is synced into a group).
     */
    async getActiveQueue(playerId: string): Promise<MaQueueState> {
        const raw = await this.sendCommand<any>('player_queues/get_active_queue', { player_id: playerId });
        return {
            queueId: String(raw?.queue_id ?? playerId),
            active: raw?.active === true,
            state: String(raw?.state ?? 'unknown'),
            shuffleEnabled: raw?.shuffle_enabled === true,
            repeatMode: String(raw?.repeat_mode ?? 'off'),
            nowPlaying: describeQueueItem(raw?.current_item),
            itemsInQueue: Number(raw?.items ?? 0),
        };
    }

    /**
     * Start playing media on a queue. `media` is one or more MA URIs (or plain
     * names — the server resolves them). `option` is a QueueOption: play |
     * replace | next | replace_next | add. `radioMode` fills the queue with
     * similar tracks.
     */
    async playMedia(queueId: string, media: string | string[], option = 'replace', radioMode = false): Promise<void> {
        await this.sendCommand('player_queues/play_media', {
            queue_id: queueId,
            media,
            option,
            radio_mode: radioMode,
        }, PLAY_MEDIA_TIMEOUT_MS);
    }

    /** Transport control on a queue (pause/play/resume/stop/next/previous). */
    async queueCommand(queueId: string, command: MaQueueCommand): Promise<void> {
        await this.sendCommand(`player_queues/${command}`, { queue_id: queueId });
    }

    async setShuffle(queueId: string, enabled: boolean): Promise<void> {
        await this.sendCommand('player_queues/shuffle', { queue_id: queueId, shuffle_enabled: enabled });
    }
}

// One shared client (and thus one socket) for all voice devices in the app.
let sharedClient: MusicAssistantClient | null = null;

export function getMusicAssistantClient(): MusicAssistantClient {
    if (!sharedClient) {
        sharedClient = new MusicAssistantClient();
    }
    return sharedClient;
}
