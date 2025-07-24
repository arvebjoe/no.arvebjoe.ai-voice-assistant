const net = require('net');
const { WyomingParser } = require('./wyoming-parser');
const { createLogger } = require('../logger');

const log = createLogger('PIPER');


/**
 * Text-to-speech through a Wyoming Piper daemon.
 * @param {string} host  – e.g. "127.0.0.1"
 * @param {number} port  – e.g. 10200
 * @param {string} text  – text to speak 
 * @returns {Promise<Buffer>} raw PCM (concatenated)
 */
async function synthesize(host, port, text) {
  return new Promise((resolve, reject) => {

    const socket = net.createConnection(port, host);
    const parser = new WyomingParser();

    socket.on('data', chunk => parser.feed(chunk));
    socket.on('error', reject);
    socket.on('connect', () =>
        socket.write(JSON.stringify({type:'synthesize', data: {text}}) + '\n')
    );

    let streamInfo = null;               // filled by first audio-start
    const pcm = [];

    parser.on('event', ({header, data, payload}) => {
      switch (header.type) {

        case 'audio-start':
          streamInfo = data;             // {rate,width,channels…}
          break;

        case 'audio-chunk':
          pcm.push(payload);
          break;

        case 'audio-stop':
          socket.end();
          socket.destroy(); 
          
          const pcmBuf = Buffer.concat(pcm); 
          streamInfo.data = pcmBuf;
          resolve(streamInfo);

          break;

        default:
          // ignore other event types for now
      }
    });
  });
}

module.exports = {
  synthesize
};
