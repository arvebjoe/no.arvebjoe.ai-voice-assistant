// The browser side of the virtual satellites: the page that borrows the host
// machine's mic and speaker, and the WebSocket that carries audio and control
// between it and a LocalAudioEspClient.
//
// It piggybacks on the settings web server (one port, one URL to remember):
//
//   GET /satellite[?sat=<mac>]      the satellite page
//   GET /he/sat/list                the virtual satellites, for the page's picker
//   GET /he/audio/<file>            the app's audio folder, so playback does not
//                                   depend on the :80 audio server
//   WS  /he/sat/ws?sat=<mac>        control (JSON) + mic audio (binary s16le 16 kHz)
//
// The hub is a module singleton because clients are created while devices boot
// (after the web server is already listening) — registration order does not
// matter, the page just asks for a satellite by id when it connects.
import http from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '../../../src/helpers/logger.mjs';
import { audioDir } from '../../../src/helpers/file-helper.mjs';
import type { LocalAudioEspClient, ToPage } from './local-audio-esp-client.mjs';

const log = createLogger('VSAT-Web', false);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = resolve(__dirname, 'satellite.html');
// The folder the app writes reply and chime audio to (HE_AUDIO_DIR-aware).
const audioRoot = () => resolve(audioDir());

class VirtualSatelliteHub {
  private clients = new Map<string, LocalAudioEspClient>();
  private wss: WebSocketServer | null = null;

  register(client: LocalAudioEspClient): void {
    this.clients.set(client.id, client);
  }

  list(): LocalAudioEspClient[] {
    return [...this.clients.values()];
  }

  get isEmpty(): boolean {
    return this.clients.size === 0;
  }

  /** Find by MAC, then by 1-based index, then by name substring (as `use`). */
  find(query: string): LocalAudioEspClient | null {
    if (!query) return null;
    const all = this.list();
    const byId = this.clients.get(query);
    if (byId) return byId;
    const idx = Number(query);
    if (Number.isInteger(idx) && idx >= 1 && idx <= all.length) return all[idx - 1];
    const q = query.toLowerCase();
    return all.find((c) => c.name.toLowerCase().includes(q)) ?? null;
  }

  /**
   * HTTP routes owned by the hub. Returns true when the request was handled, so
   * the settings web server can fall through to its own routes.
   */
  handleHttp(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return false;

    if (path === '/satellite' || path === '/satellite.html') {
      // Re-read per request so page edits show on a plain reload.
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(readFileSync(PAGE_PATH, 'utf8'));
      return true;
    }

    if (path === '/he/sat/list') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(this.list().map((c) => ({ id: c.id, name: c.name, zone: c.zone }))));
      return true;
    }

    const audio = path.match(/^\/he\/audio\/([^/]+)$/);
    if (audio) {
      this.serveAudio(decodeURIComponent(audio[1]), res);
      return true;
    }

    return false;
  }

  /**
   * Serve a file from the app's audio folder. The page rewrites every playback
   * URL to this route: the URLs the app builds point at the LAN IP on port 80,
   * which needs a privileged bind the emulator may not have (macOS/Linux).
   */
  private serveAudio(filename: string, res: http.ServerResponse): void {
    const root = audioRoot();
    const file = join(root, filename);
    if (!file.startsWith(root) || !existsSync(file)) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.setHeader('Content-Type', filename.endsWith('.wav') ? 'audio/wav' : 'audio/flac');
    res.setHeader('Content-Length', String(statSync(file).size));
    createReadStream(file).pipe(res);
  }

  /** Attach the WebSocket endpoint to the settings web server. */
  attachWebSocket(server: http.Server): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/he/sat/ws') {
        socket.destroy();
        return;
      }
      const client = this.find(url.searchParams.get('sat') ?? '') ?? this.list()[0];
      if (!client) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket as any, head, (ws) => this.onConnection(ws, client));
    });
  }

  private onConnection(ws: WebSocket, client: LocalAudioEspClient): void {
    const send = (msg: ToPage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    client.attachPage(send);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      // Binary = mic audio (s16le mono 16 kHz), exactly the PE's frame format.
      if (isBinary) {
        client.pushMicAudio(Buffer.from(data));
        return;
      }
      try {
        client.handlePageMessage(JSON.parse(data.toString('utf8')));
      } catch (err) {
        log.warn('bad message from the satellite page', err);
      }
    });

    ws.on('close', () => client.detachPage(send));
    ws.on('error', (err) => log.warn(`satellite page socket error: ${err?.message ?? err}`));
  }
}

export const satelliteHub = new VirtualSatelliteHub();
