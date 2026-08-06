// Static HTTP server that serves the TTS audio files the app writes, so a real
// PE can fetch and play them. The app builds playback URLs as
//   http://<lan-ip>/app/<id>/userdata/audio/<file>
// (no port -> port 80) and writes files to the absolute path /userdata/audio
// (resolved on this OS, e.g. C:\userdata\audio on Windows). We serve that same
// folder. Binding :80 may need elevation on some systems — if it can't bind
// (port in use or permission denied) we log a clear error and quit.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createLogger } from '../../src/helpers/logger.mjs';
import { audioDir } from '../../src/helpers/file-helper.mjs';

const log = createLogger('EMU-Audio', false);
// Resolved lazily: config.mts may redirect the folder (HE_AUDIO_DIR) after this
// module is loaded.
const audioRoot = () => resolve(audioDir());

/**
 * @param required Whether a satellite actually needs this server. A real device
 *   on the LAN fetches its reply audio here, so failing to bind is fatal. The
 *   virtual satellite plays through the browser page instead, which is served
 *   the same files by the settings web server — so a session with only virtual
 *   satellites keeps running (macOS and Linux need root for port 80).
 */
export function startAudioServer(required: boolean = true): Promise<void> {
  return new Promise((done) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const m = url.pathname.match(/\/userdata\/audio\/([^/]+)$/);
        if (!m) { res.statusCode = 404; res.end('Not found'); return; }

        const root = audioRoot();
        const file = join(root, decodeURIComponent(m[1]));
        if (!file.startsWith(root) || !existsSync(file)) {
          res.statusCode = 404; res.end('Not found'); return;
        }

        const size = statSync(file).size;
        res.setHeader('Content-Type', 'audio/flac');
        res.setHeader('Content-Length', String(size));
        createReadStream(file).pipe(res);
        log.info(`${m[1]} (${size} bytes)`, 'SERVE');
      } catch {
        res.statusCode = 500; res.end('error');
      }
    });

    server.on('error', (err: any) => {
      if (!required) {
        log.warn(
          `Could not bind port 80 (${err?.code ?? err}) — continuing without it. ` +
          'Only virtual satellites are configured, and they play their audio through ' +
          'the satellite page instead.',
        );
        done();
        return;
      }
      if (err?.code === 'EADDRINUSE') {
        log.error(
          'Port 80 is already in use — free it and restart the emulator. ' +
          '(On Windows this is often IIS / the "W3SVC" service; stop it with ' +
          '`net stop w3svc` or `iisreset /stop`.)',
        );
      } else if (err?.code === 'EACCES') {
        log.error(
          'Permission denied binding port 80 — run the emulator in an elevated ' +
          'terminal (Administrator).',
        );
      } else {
        log.error('Audio server error', err);
      }
      process.exit(1);
    });

    server.listen(80, () => {
      log.info(`serving ${audioRoot()} on :80`, 'AUDIO');
      done();
    });
  });
}
