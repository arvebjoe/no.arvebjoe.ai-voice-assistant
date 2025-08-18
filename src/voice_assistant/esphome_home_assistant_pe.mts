import EventEmitter from 'node:events';
import net from 'node:net';
import dgram from 'node:dgram';
import { TypedEmitter } from "tiny-typed-emitter";
import { encodeFrame, decodeFrame, VA_EVENT } from './esphome-messages.mjs';
import { createLogger } from '../helpers/logger.mjs';

const log = createLogger('ESP');

interface EspVoiceClientOptions {
  host: string;
  apiPort?: number;
}

type EspVoiceEvents = {
    connected: () => void;
    disconnected: () => void;
    announce_finished: () => void;
    start: () => void;
    chunk: (data: Buffer) => void;
  }



class EspVoiceClient  extends (EventEmitter as new () => TypedEmitter<EspVoiceEvents>) {
  private host: string;
  private apiPort: number;
  private streamId: number;
  private rxBuf: Buffer;
  private connected: boolean;
  private tcp: net.Socket | null;
  private mic!: dgram.Socket;
  private reconnectTimer: NodeJS.Timeout | null;
  private reconnectAttempt: number;
  private MAX_RECONNECT_DELAY: number;
  private lastPingTime: number;
  private healthCheckTimer: NodeJS.Timeout | null;
  private PING_TIMEOUT: number;
  private HEALTH_CHECK_INTERVAL: number;

  constructor({ host, apiPort = 6053 }: EspVoiceClientOptions) {
    super();
    this.host = host;
    this.apiPort = apiPort;

    this.streamId = 1;
    this.rxBuf = Buffer.alloc(0);
    this.connected = false;
    this.tcp = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.MAX_RECONNECT_DELAY = 10_000;
    this.lastPingTime = 0;
    this.healthCheckTimer = null;
    this.PING_TIMEOUT = 120_000;
    this.HEALTH_CHECK_INTERVAL = 55_000;

  }

  async start(): Promise<void> {

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    log.info(`Connecting to ${this.host}:${this.apiPort}`);
    this.tcp = net.createConnection(this.apiPort, this.host, () => this.onConnect());
    this.tcp.setKeepAlive(true, 1000);
    this.tcp.on('connect', () => {
      this.emit('connected');
    });
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

  async stop(): Promise<void> {
    log.info('Stopping ESP Voice Client...');

    // Close mic socket first
    log.info('Closing mic socket... from stop()');
    this.closeMic();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.tcp) {
      this.tcp.destroy();
      this.tcp = null;
    }

    this.connected = false;
    this.emit('disconnected');
  }

  async connectApi(): Promise<void> {

  }

  scheduleReconnect(): void {
    
    if (this.reconnectTimer) {
      return;
    }

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
    
    this.send('HelloRequest',
      {
        clientInfo: 'echo-test',
        apiVersionMajor: 1,
        apiVersionMinor: 6
      });
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
      else if (this.lastPingTime > 0) {
        log.info('Connection is healthy. Last ping received ' + Math.round((now - this.lastPingTime) / 1000) + 's ago');
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
    
    if (this.tcp) {
      this.tcp.destroy();
      this.tcp = null;
    }
    this.scheduleReconnect();
  }

  async disconnect(): Promise<boolean> {
    log.info('Disconnecting ESP Voice Client');
    
    this.connected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  
    // Close mic socket
    log.info('Closing mic socket... from disconnect()');
    this.closeMic();

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.tcp) {
      this.tcp.destroy();
      this.tcp = null;
    }

    this.emit('disconnected');
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
      this.dispatch({ name: frame.name ?? '', message: frame.message });

      this.rxBuf = this.rxBuf.subarray(frame.bytes);
    }
  }

  async dispatch({ name, message }: { name: string; message: any }): Promise<void> {

    if (name === 'HelloResponse' && !this.connected) {
      this.send('ConnectRequest', { password: '' });
    }

    else if (name === 'ConnectResponse') {
      this.connected = true;
      this.emit('connected');
      this.send('ListEntitiesRequest', {});
    }

    else if (name === 'ListEntitiesDoneResponse') {
      this.send('SubscribeVoiceAssistantRequest', { subscribe: true });
    }

    else if (name === 'VoiceAssistantAnnounceFinished') {
      this.emit('announce_finished');
    }

    else if (name === 'MediaPlayerStateResponse' && message.state == 1) {
      //this.emit('end');
    }

    else if (name === 'VoiceAssistantRequest' && message.start) {
      this.emit('start');
    }

    else if (name === 'PingRequest') {
      this.lastPingTime = Date.now();
      this.send('PingResponse', {});
      //this.lastPongTime = Date.now();
    }
  }


  run_start(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_RUN_START, {}, 'RUN_START');
  }

  end_run(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_RUN_END, {}, 'RUN_END');
    this.streamId++;
  }

  stt_start(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_START, {}, 'STT_START');
  }

  stt_end(text: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_END, { text }, 'STT_END');
  }

  intent_start(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_INTENT_START, {}, 'INTENT_START');
  }

  intent_end(text: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_INTENT_END, { text }, 'INTENT_END');
  }

  tts_start(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_TTS_START, {}, 'TTS_START');
  }

  tts_end(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_TTS_END, {}, 'TTS_END');
  }

  stt_vad_start(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_VAD_START, {}, 'STT_VAD_START');
  }

  stt_vad_end(text: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_VAD_END, { text }, 'STT_VAD_END');
  }


  begin_mic_capture(): void {

    // Close existing mic socket if it exists
    if (this.mic) {
      log.info('Closing mic socket... from beginVoiceSession()');
      this.closeMic();
    }

    this.mic = dgram.createSocket('udp4');

    // Add error handling
    this.mic.on('error', (err) => {
      log.error('UDP socket error:', err);
      log.info('Closing mic socket... from udp error()');
      this.closeMic();
    });

    this.mic.on('message', (pcm: Buffer) => {
      this.emit('chunk', pcm);
    });

    this.mic.bind(() => {
      const mic_port = (this.mic.address() as net.AddressInfo).port;
      log.info(`UDP socket bound to port: ${mic_port}`);

      this.send('VoiceAssistantResponse', {
        port: mic_port,
        error: false,
        useUdpAudio: true,
      });
    });
  }

  closeMic(): void {
    if (this.mic) {
      try {
        // Remove all event listeners to prevent memory leaks
        this.mic.removeAllListeners();
        // Close the socket
        this.mic.close();
        log.info('UDP socket closed');
      } catch (err) {
        log.error('Error closing UDP socket:', err);
      } finally {
        // Always set to null to indicate it's no longer available
        this.mic = null!;
      }
    }
  }



  playAudioFromUrl(url: string, startConversation: boolean): void {
    this.send('VoiceAssistantAnnounceRequest', {
      mediaId: url,
      text: '',
      startConversation: startConversation,
    });
  }



  vaEvent(type: number, extra: Record<string, any> = {}, name: string): void {
    log.info(`VoiceAssistantEvent: ${name}`, "VoiceAssistantEvent", { ...extra });

    this.send('VoiceAssistantEventResponse',
      {
        eventType: type,
        streamId: this.streamId,
        ...extra
      },
      false
    );
  }

  send(name: string, payload: any, doLog: boolean = true): void {
    if (doLog) {
      log.info(name, 'TX', payload);
    }
    this.tcp?.write(encodeFrame(name, payload));
  }

  logRx(f: any): void {

    if (f.name === 'VoiceAssistantAudio') {
      return;
    }

    log.info(f.name || `unknown#${f.id}`, 'RX', f.message || { length: f.payload.length });
  }

}

export { EspVoiceClient, EspVoiceClientOptions };
