import EventEmitter from 'node:events';
import net from 'node:net';
import dgram from 'node:dgram';
import { encodeFrame, decodeFrame, VA_EVENT } from './esphome-messages.mjs';
import { createLogger } from '../helpers/logger.mjs';
import { WebServer } from '../helpers/webserver.mjs';

const log = createLogger('ESP');

interface EspVoiceClientOptions {
  host: string;
  apiPort?: number;
  webServer: InstanceType<typeof WebServer>;
}

class EspVoiceClient extends EventEmitter {
  private host: string;
  private apiPort: number;
  private webServer: InstanceType<typeof WebServer>;
  private streamId: number;
  private lastWav: Buffer | null;
  private rxBuf: Buffer;
  private connected: boolean;
  private tcp: net.Socket | null;
  private reconnectTimer: NodeJS.Timeout | null;
  private reconnectAttempt: number;
  private MAX_RECONNECT_DELAY: number;
  private lastPingTime: number;
  private lastPongTime: number;
  private healthCheckTimer: NodeJS.Timeout | null;
  private PING_TIMEOUT: number;
  private HEALTH_CHECK_INTERVAL: number;
  private CHUNK: number;
  private SAMPLE_RATE: number;
  private TRIM_MS: number;
  private BYTES_PER_SAMPLE: number;
  private RMS_THRESHOLD: number;
  private SILENCE_MS: number;

  constructor({ host, apiPort = 6053, webServer }: EspVoiceClientOptions) {
    super();
    this.host = host;
    this.apiPort = apiPort;
    this.webServer = webServer;
    this.streamId = 1;
    this.lastWav = null;
    this.rxBuf = Buffer.alloc(0);
    this.connected = false;
    this.tcp = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.MAX_RECONNECT_DELAY = 10_000;
    this.lastPingTime = 0;
    this.lastPongTime = 0;
    this.healthCheckTimer = null;
    this.PING_TIMEOUT = 10_000;
    this.HEALTH_CHECK_INTERVAL = 5000;
    this.CHUNK = 1024;
    this.SAMPLE_RATE = 16_000;
    this.TRIM_MS = 400;
    this.BYTES_PER_SAMPLE = 2;
    this.RMS_THRESHOLD = 1200;
    this.SILENCE_MS = 800;
  }

  async start(): Promise<void> {
    await this.connectApi();
  }

  async stop(): Promise<void> {
    log.info('Stopping ESP Voice Client...');
    if (this.tcp) {
      this.tcp.destroy();
      this.tcp = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    this.connected = false;
    this.emit('disconnected');
  }

  async connectApi(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    log.info(`Connecting to ${this.host}:${this.apiPort}`);
    this.tcp = net.createConnection(this.apiPort, this.host, () => this.onConnect());
    this.tcp.setKeepAlive(true, 1000);
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

  scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), this.MAX_RECONNECT_DELAY);
    log.warn('Scheduling reconnection attempt', { attempt: this.reconnectAttempt + 1, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt++;
      this.connectApi();
    }, delay);
  }

  async onConnect(): Promise<void> {
    log.info(`Connected to ${this.host}:${this.apiPort}`);
    this.reconnectAttempt = 0;
    this.startHealthCheck();
    this.send('HelloRequest', { clientInfo: 'echo-test', apiVersionMajor: 1, apiVersionMinor: 6 });
  }

  startHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    this.healthCheckTimer = setInterval(() => {
      const now = Date.now();
      if (this.lastPingTime > 0 && (now - this.lastPingTime) > this.PING_TIMEOUT) {
        log.warn('Connection timeout - no ping received', {
          lastPing: Math.round((now - this.lastPingTime) / 1000) + 's ago'
        });
        this.handleDisconnect();
      }
    }, this.HEALTH_CHECK_INTERVAL);
  }

  handleDisconnect(): void {
    this.connected = false;
    this.emit('disconnected');
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
    this.scheduleReconnect();
  }

  async disconnect(): Promise<boolean> {
    log.info('Disconnecting ESP Voice Client');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    this.emit('disconnected');
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

  async onTcpData(data: Buffer): Promise<void> {
    this.rxBuf = Buffer.concat([this.rxBuf, data]);
    while (true) {
      const frame = decodeFrame(this.rxBuf);
      if (!frame) {
        break;
      }
      this.logRx(frame);
      // Fix: handle null for name
      this.dispatch({ name: frame.name ?? '', message: frame.message });
      this.rxBuf = this.rxBuf.slice(frame.bytes);
    }
  }

  async dispatch({ name, message }: { name: string; message: any }): Promise<void> {
    if (name === 'HelloResponse' && !this.connected) {
      this.send('ConnectRequest', { password: '' });
    } else if (name === 'ConnectResponse') {
      this.connected = true;
      this.emit('connected');
      // Fix: add empty object for ListEntitiesRequest
      this.send('ListEntitiesRequest', {});
    } else if (name === 'ListEntitiesDoneResponse') {
      this.send('SubscribeVoiceAssistantRequest', { subscribe: true });
    } else if (name === 'VoiceAssistantAnnounceFinished') {
      log.info('VoiceAssistantAnnounceFinished received');
      this.emit('end');
    } else if (name === 'VoiceAssistantRequest' && message.start) {
      this.handleVoiceSession();
    } else if (name === 'PingRequest') {
      this.lastPingTime = Date.now();
      this.send('PingResponse', {});
      this.lastPongTime = Date.now();
      // Fix: use undefined instead of null
      log.info('Ping-Pong completed', undefined, {
        timeSinceLastPing: this.lastPingTime - this.lastPongTime
      });
    }
  }

  handleVoiceSession(): void {
    this.emit('begin');
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_RUN_START);
    const mic = dgram.createSocket('udp4');
    mic.bind(() => {
      // Fix: use net.AddressInfo
      const MIC_PORT = (mic.address() as net.AddressInfo).port;
      this.send('VoiceAssistantResponse', {
        port: MIC_PORT,
        error: false,
        useUdpAudio: true,
      });
      const SAMPLES = this.CHUNK / 2;
      const chunks: Buffer[] = [];
      let lastVoice = Date.now();
      let isCurrentlyVoice = false;
      let firstChunk = true;
      mic.on('message', (buf: Buffer) => {
        if (firstChunk) {
          firstChunk = false;
          this.sttStart();
        }        
        chunks.push(buf);
        let sum = 0;
        for (let i = 0; i < SAMPLES; i++) {
          const s = buf.readInt16LE(i * 2);
          sum += s * s;
        }
        const rms = Math.sqrt(sum / SAMPLES);
        isCurrentlyVoice = rms > this.RMS_THRESHOLD;
        if (isCurrentlyVoice) {
          lastVoice = Date.now();
        }
        const silenceDuration = Date.now() - lastVoice;
        if (silenceDuration > this.SILENCE_MS) {
          mic.close();
          this.processVoice(Buffer.concat(chunks));
        }
      });
    });
  }

  processVoice(pcm: Buffer): void {
    if (!pcm.length) {
      return;
    }
    // Fix: use undefined instead of null
    log.info(`Received audio data`, undefined, { bytes: pcm.length });  
    const bytesToTrim = Math.min(pcm.length, Math.round(this.SAMPLE_RATE * this.TRIM_MS / 1000) * this.BYTES_PER_SAMPLE);
    if (bytesToTrim) {
      pcm = pcm.slice(bytesToTrim);
    }
    this.emit('audio', pcm);
  }

  playAudioFromUrl(url: string): void {
    this.send('VoiceAssistantAnnounceRequest', {
      mediaId: url,
      text: '',
      startConversation: false,
    });
    // Fix: use undefined instead of null
    log.info('Playing audio from URL:', undefined, url);
  }

  sttStart(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_VAD_START);
  }

  sttEnd(text: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_VAD_END, { text });
  }

  intentStart(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_INTENT_START);
  }

  intentEnd(text: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_INTENT_END, { text });
  }

  endRun(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_RUN_END);
    this.streamId++;
  }

  playBuffer(wavBuf: Buffer): void {
    // Not implemented
  }

  vaEvent(type: number, extra: Record<string, any> = {}): void {
    this.send('VoiceAssistantEventResponse', { eventType: type, streamId: this.streamId, ...extra });
  }

  send(name: string, payload: any): void {
    log.info(name, 'TX', payload);
    this.tcp?.write(encodeFrame(name, payload));
  }

  logRx(f: any): void {
    log.info(f.name || `unknown#${f.id}`, 'RX', f.message || { length: f.payload.length });
  }
}

export { EspVoiceClient, EspVoiceClientOptions };
