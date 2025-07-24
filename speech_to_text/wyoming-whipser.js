const net = require('net');
const { createLogger } = require('../logger');

const log = createLogger('WHISPER');

async function transcribe(host, port, audioBuffer, opts = {}) {
  const {
    language,
    rate     = 16_000,
    channels = 1,
    width    = 2,           
  } = opts;


  const dataPos = 0;
  const dataLen = audioBuffer.length;

  log.info(`Streaming ${dataLen} bytes (${rate} Hz, ${channels} ch`  );

  /* ─── 2. Ship it over Wyoming ─── */
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, host, () => {
      send(sock, { type: 'describe' });
      send(sock, { type: 'transcribe', ...(language && { data: { language } }),});
      send(sock, { type: 'audio-start', data: { rate, width, channels }, });

      const CHUNK = 4096;
      for (let off = 0; off < dataLen; off += CHUNK) {
        const slice = audioBuffer.subarray(
          dataPos + off,
          dataPos + Math.min(off + CHUNK, dataLen)
        );
        send(sock, { type: 'audio-chunk', data: { rate, width, channels }, },slice);
      }

      send(sock, { type: 'audio-stop' });
    });


    sock.setEncoding(null);                 // get raw Buffers

    let buf            = Buffer.alloc(0);   // unread bytes
    let expectBytes    = 0;                 // bytes still to read for this message
    let currentHeader  = null;              // header we just parsed

    sock.on('data', (chunk) => {
      if (!Buffer.isBuffer(chunk)) {
        chunk = Buffer.from(chunk, 'utf8');
      }
      buf = Buffer.concat([buf, chunk]);

      while (true) {
        /* 1.  have we finished a payload? ------------------------------ */
        if (expectBytes) {
          if (buf.length < expectBytes) {
            return;
          }
          const payload = buf.subarray(0, expectBytes);
          buf           = buf.subarray(expectBytes);
          expectBytes   = 0;

          /* -> process (header, payload) pair -------------------------- */
          if (currentHeader?.type === 'transcript' || currentHeader?.type === 'transcript-stop') {
            let data;
            try {
              data = JSON.parse(payload.toString('utf8'));
            } catch (e) {
              sock.destroy();
              return reject(new Error('Transcript payload is not valid JSON'));
            }
            sock.end();
            return resolve(data.text ?? '');
          }

          // ignore payloads of other message types (e.g. "info")
          currentHeader = null;
          continue;               // look for another header in buf
        }

        /* 2.  parse next header line ---------------------------------- */
        const nl = buf.indexOf(0x0A);       // '\n'
        if (nl === -1) {
          return;              // incomplete header
        }

        const headerBuf = buf.subarray(0, nl);
        buf             = buf.subarray(nl + 1);

        try {
          currentHeader = JSON.parse(headerBuf.toString('utf8'));
        } catch (e) {
          sock.destroy();
          return reject(new Error(`Bad JSON header: ${e.message}`));
        }

        expectBytes = currentHeader.payload_length ?? currentHeader.data_length ?? 0;

        if (expectBytes === 0) {
          /* header-only message (rare) --------------------------------- */
          if (currentHeader.type === 'transcript' || currentHeader.type === 'transcript-stop') {
            sock.end();
            return resolve(currentHeader.data?.text ?? '');
          }
          currentHeader = null;
          continue;
        }

        /* 3.  loop will now wait until we have full payload ---------- */
      }
    });

    sock.once('error', reject);
    sock.once('close', () => reject(new Error('Connection closed without transcript')));

  });
}



function send(socket, header, payload = Buffer.alloc(0)) {
  // Wyoming: one-line JSON, then optional binary payload
  header.payload_length = payload.length;
  const line = Buffer.from(JSON.stringify(header) + "\n", "utf8");
  socket.write(line);
  if (payload.length) {
    socket.write(payload);
  }
}

module.exports = {
  transcribe
};
