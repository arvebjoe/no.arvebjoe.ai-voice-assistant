// Static HTTP server that serves the TTS audio files the app writes, so a real
// PE can fetch and play them. The app builds playback URLs as
//   http://<lan-ip>/app/<id>/userdata/audio/<file>
// (no port -> port 80) and writes files to the absolute path /userdata/audio
// (resolved on this OS, e.g. C:\userdata\audio on Windows). We serve that same
// folder. Binding :80 may need elevation on some systems — if it fails we warn
// and carry on; only PE audio playback is affected, the rest works.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createLogger } from '../../src/helpers/logger.mjs';

const log = createLogger('EMU-Audio', false);
const AUDIO_ROOT = resolve('/userdata/audio');

export function startAudioServer(): Promise<void> {
  return new Promise((done) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const m = url.pathname.match(/\/userdata\/audio\/([^/]+)$/);
        if (!m) { res.statusCode = 404; res.end('Not found'); return; }

        const file = join(AUDIO_ROOT, decodeURIComponent(m[1]));
        if (!file.startsWith(AUDIO_ROOT) || !existsSync(file)) {
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
      if (err?.code === 'EACCES' || err?.code === 'EADDRINUSE') {
        log.warn(
          `Could not bind port 80 (${err.code}). PE audio playback will not work — ` +
          'run the emulator elevated (or free port 80). Tool calls, the text console, ' +
          'and device state all still work.',
        );
      } else {
        log.error('Audio server error', err);
      }
      done();
    });

    server.listen(80, () => {
      log.info(`serving ${AUDIO_ROOT} on :80`, 'AUDIO');
      done();
    });
  });
}
