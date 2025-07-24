const EventEmitter = require('node:events');
const net = require('node:net');
const dgram = require('node:dgram');
const { encodeFrame, decodeFrame, VA_EVENT } = require('./esphome-messages');
const { createLogger } = require('../logger');

const log = createLogger('ESP');

class EspVoiceClient extends EventEmitter {
  constructor({ host, apiPort = 6053, webServer }) {
    super();
    this.host = host;
    this.apiPort = apiPort;
    this.webServer = webServer; 
    this.streamId = 1;
    this.lastWav = null;               // in-RAM buffer served at /echo.wav
    this.rxBuf = Buffer.alloc(0);
    this.connected = false;
    this.tcp = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.MAX_RECONNECT_DELAY = 10_000;  // Maximum delay between retries (10 seconds)
    
    // Connection monitoring
    this.lastPingTime = 0;
    this.lastPongTime = 0;
    this.healthCheckTimer = null;
    this.PING_TIMEOUT = 10_000;        // Consider connection dead if no ping for 10 seconds
    this.HEALTH_CHECK_INTERVAL = 5000; // Check connection health every 5 seconds

    this.CHUNK = 1024;            // bytes (≈32 ms @ 16 kHz mono)
    this.SAMPLE_RATE = 16_000;    // 16khz
    this.TRIM_MS = 400;           // milliseconds to cut from the *front*  
    this.BYTES_PER_SAMPLE = 2;    // 16-bit = 2 bytes (mono)
    
    // VAD parameters
    this.RMS_THRESHOLD = 1200;     // RMS threshold for speech detection
    this.SILENCE_MS = 800;        // Stop after this many ms of silence
  }

  async start() {
    // Add an endpoint to the existing WebServer app for serving the WAV file
    await this.connectApi();
  }

    async stop() {
        log.info('Stopping ESP Voice Client...');
        if (this.tcp) {
            this.tcp.destroy();
            this.tcp = null;
        }

        // Clear any existing timers
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }

        this.connected = false;
    }

  /* ───────── ESPHome API (trimmed: handshake, VAD) ───────── */
  async connectApi() {
    // Clear any existing reconnection timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    log.info(`Connecting to ${this.host}:${this.apiPort}`);
    
    this.tcp = net.createConnection(this.apiPort, this.host, () => this.onConnect());
    
    // Enable TCP keepalive
    this.tcp.setKeepAlive(true, 1000); // Send keepalive every 1 second when idle
    
    this.tcp.on('data', (data) => this.onTcpData(data));
    
    this.tcp.on('error', (err) => {
      log.error('TCP connection error', err);
      this.handleDisconnect();
    });

    this.tcp.on('close', () => {
      if (this.connected) {
        log.warn('TCP connection closed unexpectedly');
        this.handleDisconnect();
      }
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return; // Already scheduled

    // Calculate delay with exponential backoff
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), this.MAX_RECONNECT_DELAY);

    log.warn('Scheduling reconnection attempt', { attempt: this.reconnectAttempt + 1, delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt++;
      this.connectApi();
    }, delay);
  }

  
  async onConnect() {
    log.info(`Connected to ${this.host}:${this.apiPort}`);
    // Reset reconnection counter and start health monitoring
    this.reconnectAttempt = 0;
    this.startHealthCheck();
    this.send('HelloRequest', { clientInfo: 'echo-test', apiVersionMajor: 1, apiVersionMinor: 6 });
  }

  startHealthCheck() {
    // Clear any existing health check timer
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    // Start periodic health checks
    this.healthCheckTimer = setInterval(() => {
      const now = Date.now();
      
      // If we haven't received a ping in PING_TIMEOUT ms, consider the connection dead
      if (this.lastPingTime > 0 && (now - this.lastPingTime) > this.PING_TIMEOUT) {
        log.warn('Connection timeout - no ping received', {
          lastPing: Math.round((now - this.lastPingTime) / 1000) + 's ago'
        });
        this.handleDisconnect();
      }
    }, this.HEALTH_CHECK_INTERVAL);
  }

  handleDisconnect() {
    // Clean up connection state
    this.connected = false;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    this.lastPingTime = 0;
    this.lastPongTime = 0;
    
    if (this.tcp) {
      this.tcp.destroy();
      this.tcp = null;
    }

    // Schedule reconnect
    this.scheduleReconnect();
  }
  
  // Public method to disconnect and clean up resources
  async disconnect() {
    log.info('Disconnecting ESP Voice Client');
    
    // Clear any reconnect timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Clean up connection state without scheduling reconnect
    this.connected = false;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    if (this.tcp) {
      this.tcp.destroy();
      this.tcp = null;
    }
    
    log.info('ESP Voice Client disconnected');
    return true;
  }

  async onTcpData(data) {
    this.rxBuf = Buffer.concat([this.rxBuf, data]);
    while (true) {
      const frame = decodeFrame(this.rxBuf);
      if (!frame) {
        break;
      }
      this.logRx(frame);
      this.dispatch(frame);
      this.rxBuf = this.rxBuf.slice(frame.bytes);
    }
  }  



  /*──────── finite-state dispatch ────────*/
  async dispatch({ name, message }) {

    // 1) handshake
    if (name === 'HelloResponse' && !this.connected) {
      this.send('ConnectRequest', { password: '' });           // no API password
    }

    // 2) connected → ask for entities
    else if (name === 'ConnectResponse') {
      this.connected = true;
      this.send('ListEntitiesRequest');
    }

    // 3) capture media_player key
    //else if (name === 'ListEntitiesMediaPlayerResponse') {
    //  mediaPlayerKey = message.key;
    //  console.log(`🎛  media_player key = ${mediaPlayerKey}`);
    //}

    // 4) once entity dump is finished, subscribe
    else if (name === 'ListEntitiesDoneResponse') {
      this.send('SubscribeVoiceAssistantRequest', { subscribe: true });
    }

    else if (name === 'VoiceAssistantAnnounceFinished') {
      log.info('VoiceAssistantAnnounceFinished received');
      this.emit('end');  
    }

    // 5) Voice-Assistant session
    else if (name === 'VoiceAssistantRequest' && message.start) {
      this.handleVoiceSession();
    }
    //else if (name === 'MediaPlayerStateResponse') {
    //  console.log('STATE', message.state);   // expect PLAYING, then IDLE
    //}
    else if (name === 'PingRequest') {
      this.lastPingTime = Date.now();
      this.send('PingResponse', {});     // empty payload
      this.lastPongTime = Date.now();
      log.info('Ping-Pong completed', null, { 
        timeSinceLastPing: this.lastPingTime - this.lastPongTime 
      });
    }
  }

  /*──────────────── voice-assistant round trip ────────────────*/
  handleVoiceSession() {

    this.emit('begin');
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_RUN_START);
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_VAD_START);

    const mic = dgram.createSocket('udp4');
    mic.bind(() => {
      const MIC_PORT = mic.address().port;

      this.send('VoiceAssistantResponse', {
        port: MIC_PORT,
        error: false,
        useUdpAudio: true,
      });

      /*──── VAD parameters ────*/
      const SAMPLES = this.CHUNK / 2;  // 16-bit samples (512 samples per chunk)
      const chunks = [];
      let lastVoice = Date.now();
      let isCurrentlyVoice = false;    // Track if current chunk has voice

      mic.on('message', (buf) => {
        chunks.push(buf);

        /* fast RMS calculation */
        let sum = 0;
        for (let i = 0; i < SAMPLES; i++) {
          const s = buf.readInt16LE(i * 2);
          sum += s * s;
        }
        const rms = Math.sqrt(sum / SAMPLES);
        
        // Update voice detection state
        isCurrentlyVoice = rms > this.RMS_THRESHOLD;
        if (isCurrentlyVoice) {
          lastVoice = Date.now();
          //log.debug('Voice detected', { rms: Math.round(rms) });
        }

        // Check for end of speech
        const silenceDuration = Date.now() - lastVoice;
        if (silenceDuration > this.SILENCE_MS) {
          /*log.debug('Speech ended', { 
            silenceDuration,
            totalChunks: chunks.length,
            totalDurationMs: chunks.length * (this.CHUNK / this.BYTES_PER_SAMPLE / this.SAMPLE_RATE * 1000)
          });*/
          mic.close();
          this.processVoice(Buffer.concat(chunks));
        }
      });
    });
  }

    /*──────── after VAD ────────*/
  processVoice(pcm) {
    if (!pcm.length) {
      return;
    }

    log.info(`Received audio data`, null, { bytes: pcm.length });

    //await sleep(1000);   // fake delays to mimic real pipeline

    //vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_START, { language: 'en-US' });
    //await sleep(1000);
    //vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_END,   { text: 'this is a test' });

    const bytesToTrim = Math.min(pcm.length, Math.round(this.SAMPLE_RATE * this.TRIM_MS / 1000) * this.BYTES_PER_SAMPLE);

    if (bytesToTrim) {
      pcm = pcm.slice(bytesToTrim);      
    }

    //vaEvent(VA_EVENT.VOICE_ASSISTANT_TTS_STREAM_START); 

    /* 1. write WAV, 2. let PE fetch it */
    //const wavFile = makeEchoWav(pcm);
    //playOnPE(wavFile);


    //await sleep(5000);
    //vaEvent(VA_EVENT.VOICE_ASSISTANT_TTS_STREAM_END); 
    //console.log('🔊  playback done');

    this.emit('audio', pcm);
  }

  sttEnd(text) {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_VAD_END, { text });
  }

  intentStart() {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_INTENT_START);
  }

  intentEnd(text) {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_INTENT_END, { text });
  } 

  endRun() {
    /*
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_RUN_END);
    this.streamId++;    
    */
    //this.send('VoiceAssistantEndRunRequest', { streamId: this.streamId });
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_RUN_END);
    this.streamId++;
  }

  playAudioFromUrl(url) {
    this.send('VoiceAssistantAnnounceRequest', {
      mediaId: url,
      text: '',
      startConversation: false,
    });
    log.info('Playing audio from URL:', url);
  }


  /* called by main pipeline */
  playBuffer(wavBuf) {
    /*
    this.lastWav = wavBuf;
    this.send('VoiceAssistantAnnounceRequest', {
      mediaId: `${this.baseUrl}/echo.wav`,
      text: '',
      startConversation: false,
    });*/
  }




  /*──────────────── helpers ────────────────*/
  vaEvent(type, extra = {}) {
    this.send('VoiceAssistantEventResponse', { eventType: type, streamId: this.streamId, ...extra });
  }

  send(name, payload) {
    log.info(name, "TX", payload);
    this.tcp.write(encodeFrame(name, payload));
  }

  logRx(f) {
    log.info(f.name || `unknown#${f.id}`, "RX", f.message || { length: f.payload.length });
  }
}

module.exports = {
  EspVoiceClient
};
