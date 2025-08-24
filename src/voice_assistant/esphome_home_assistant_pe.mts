import EventEmitter from 'node:events';
import net from 'node:net';
import dgram from 'node:dgram';
import { TypedEmitter } from "tiny-typed-emitter";
import { encodeFrame, decodeFrame, VA_EVENT } from './esphome-messages.mjs';
import { createLogger } from '../helpers/logger.mjs';

const log = createLogger('ESP', false);

interface EspVoiceClientOptions {
  host: string;
  apiPort?: number;
  discoveryMode?: boolean;
}

type EspVoiceEvents = {
  connected: () => void;
  disconnected: () => void;
  announce_finished: () => void;
  start: () => void;
  chunk: (data: Buffer) => void;
  capabilities: (mediaPlayersCount: number, subscribeVoiceAssistantCount: number, voiceAssistantConfigurationCount: number, deviceType: string | null) => void;
  volume: (level: number) => void; // Volume change event
  mute: (isMuted: boolean) => void; // Mute state change event
}



class EspVoiceClient extends (EventEmitter as new () => TypedEmitter<EspVoiceEvents>) {
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
  private lastMessageReceivedTime: number;
  private healthCheckTimer: NodeJS.Timeout | null;
  private PING_TIMEOUT: number;
  private HEALTH_CHECK_INTERVAL: number;
  private mediaPlayersCount: number;
  private subscribeVoiceAssistantCount: number;
  private voiceAssistantConfigurationCount: number;
  private discoveryMode: boolean;
  private deviceType: string | null;

  // Store entity keys by object_id for easier access
  private entityKeys: {
    [objectId: string]: number
  } = {};

  // Track device state
  private currentVolume: number = 0.5;
  private isMuted: boolean = false;


  constructor({ host, apiPort = 6053, discoveryMode = false }: EspVoiceClientOptions) {
    super();
    this.host = host;
    this.apiPort = apiPort;
    this.discoveryMode = discoveryMode;

    this.streamId = 1;
    this.rxBuf = Buffer.alloc(0);
    this.connected = false;
    this.tcp = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.MAX_RECONNECT_DELAY = 10_000;
    this.lastMessageReceivedTime = 0;
    this.healthCheckTimer = null;
    this.PING_TIMEOUT = 120_000;
    this.HEALTH_CHECK_INTERVAL = 55_000;
    this.mediaPlayersCount = 0;
    this.subscribeVoiceAssistantCount = 0;
    this.voiceAssistantConfigurationCount = 0;
    this.deviceType = null;

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



  scheduleReconnect(): void {

    if (this.reconnectTimer) {
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), this.MAX_RECONNECT_DELAY);
    log.warn('Scheduling reconnection attempt', { attempt: this.reconnectAttempt + 1, delayMs: delay });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempt++;
      await this.start();
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
      if (this.lastMessageReceivedTime > 0 && (now - this.lastMessageReceivedTime) > this.PING_TIMEOUT) {
        log.warn('Connection timeout - no ping received', {
          lastPing: Math.round((now - this.lastMessageReceivedTime) / 1000) + 's ago'
        });
        this.handleDisconnect();
      }
      else if (this.lastMessageReceivedTime > 0) {
        log.info('Connection is healthy. Last ping received ' + Math.round((now - this.lastMessageReceivedTime) / 1000) + 's ago');
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

    this.lastMessageReceivedTime = 0;

    if (this.tcp) {
      this.tcp.destroy();
      this.tcp = null;
    }
    this.scheduleReconnect();
  }

  async disconnect(): Promise<boolean> {
    log.info('Disconnecting ESP Voice Client');

    // Mark as disconnected before anything else to prevent reconnect attempts
    this.connected = false;

    try {
      // Clean up timers
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // Close mic socket - wrap in try-catch in case it's already closed
      try {
        log.info('Closing mic socket... from disconnect()');
        this.closeMic();
      } catch (err) {
        log.warn('Error closing mic socket:', err);
      }

      // Clean up health check timer
      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = null;
      }

      // Close TCP socket - wrap in try-catch in case it's already closed
      if (this.tcp) {
        try {
          this.tcp.destroy();
        } catch (err) {
          log.warn('Error destroying TCP socket:', err);
        } finally {
          this.tcp = null;
        }
      }

      log.info('ESP Voice Client disconnected');
      return true;
    } catch (err) {
      log.error('Error during disconnect:', err);
      return false;
    } finally {
      // Always emit the disconnected event, but use a setTimeout to 
      // ensure it happens after the current execution context
      setTimeout(() => {
        try {
          this.emit('disconnected');
        } catch (err) {
          // Ignore errors during event emit on cleanup
        }
      }, 0);
    }
  }

  async onTcpData(data: Buffer): Promise<void> {
    this.rxBuf = Buffer.concat([this.rxBuf, data]);

    while (true) {
      const frame = decodeFrame(this.rxBuf);

      if (!frame) {
        break;
      }

      if (this.discoveryMode && !this.deviceType && frame.message) {
        var rawMessage = JSON.stringify(frame.message).toLocaleLowerCase();
        if (rawMessage.includes('nabu casa') || rawMessage.includes('home assistant voice pe')) {
          this.deviceType = 'pe';
          this.discoveryMode = false;
        } else if (rawMessage.includes('xiaozhi')) {
          this.deviceType = 'xiaozhi';
          this.discoveryMode = false;
        }
      }

      this.lastMessageReceivedTime = Date.now();
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

      this.mediaPlayersCount = 0;
      this.subscribeVoiceAssistantCount = 0;
      this.voiceAssistantConfigurationCount = 0;
      this.entityKeys = {};

      this.send('ListEntitiesRequest', {});
    }


    else if (name === 'ListEntitiesMediaPlayerResponse') {
      this.mediaPlayersCount++;
      if (message.objectId && message.key) {
        this.entityKeys[message.objectId] = message.key;

        // Store the first media player key as our default media_player entity for volume control
        if (!this.entityKeys['media_player']) {
          this.entityKeys['media_player'] = message.key;
          log.info(`Registered media player: ${message.objectId} with key ${message.key} (primary)`);
        } else {
          log.info(`Registered media player: ${message.objectId} with key ${message.key}`);
        }
      }
    }

    else if (name === 'ListEntitiesSwitchResponse') {
      if (message.objectId && message.key) {
        this.entityKeys[message.objectId] = message.key;
        log.info(`Registered switch: ${message.objectId} with key ${message.key}`);
      }
    }

    else if (name === 'ListEntitiesNumberResponse') {
      if (message.objectId && message.key) {
        this.entityKeys[message.objectId] = message.key;
        log.info(`Registered number: ${message.objectId} with key ${message.key}`);

        // Check if this might be a volume control entity
        const objectIdLower = message.objectId.toLowerCase();
        if (objectIdLower.includes('volume')) {
          this.entityKeys['volume'] = message.key;
          log.info(`Found potential volume control number entity: ${message.objectId}`);
        }
      }
    }

    else if (name === 'ListEntitiesDoneResponse') {
      this.send('SubscribeVoiceAssistantRequest', { subscribe: true });

      // Subscribe to media player state updates to track volume changes
      this.subscribeToMediaPlayerState();

      setTimeout(() => {
        if (this.connected) {
          this.send('DeviceInfoRequest', {});
        }
      }, 500);
    }

    else if (name === 'DeviceInfoResponse') {
      this.subscribeVoiceAssistantCount++;
      this.send('VoiceAssistantConfigurationRequest', {});

    }

    else if (name === 'VoiceAssistantConfigurationResponse') {
      this.voiceAssistantConfigurationCount++
      this.emit('capabilities', this.mediaPlayersCount, this.subscribeVoiceAssistantCount, this.voiceAssistantConfigurationCount, this.deviceType);

    }

    else if (name === 'VoiceAssistantAnnounceFinished') {
      this.emit('announce_finished');
    }

    else if (name === 'MediaPlayerStateResponse') {
      // Update our tracked volume if it changed
      if (typeof message.volume === 'number') {
        const previousVolume = this.currentVolume;
        this.currentVolume = message.volume;

        // Emit event if volume changed
        if (Math.abs(previousVolume - this.currentVolume) > 0.01) { // Small threshold to avoid noise
          this.emit('volume', this.currentVolume);
          log.info(`Volume changed to ${Math.round(this.currentVolume * 100)}%`);
        }
      }
    }

    else if (name === 'SwitchStateResponse') {
      // Check if this is the mute switch
      const muteKey = this.entityKeys['mute'];
      if (muteKey && message.key === muteKey) {
        const previousMuteState = this.isMuted;
        this.isMuted = message.state;

        // Emit event if mute state changed
        if (previousMuteState !== this.isMuted) {
          this.emit('mute', this.isMuted);
          log.info(`Mute state changed to ${this.isMuted ? 'muted' : 'unmuted'}`);
        }
      }
    }

    else if (name === 'NumberStateResponse') {
      // Check if this is the volume entity
      const volumeKey = this.entityKeys['volume'];
      if (volumeKey && message.key === volumeKey && typeof message.state === 'number') {
        // Convert from percentage (0-100) to decimal (0-1) if needed
        let volumeLevel = message.state;
        if (volumeLevel > 1) {
          volumeLevel = volumeLevel / 100;
        }

        const previousVolume = this.currentVolume;
        this.currentVolume = volumeLevel;

        // Emit event if volume changed
        if (Math.abs(previousVolume - this.currentVolume) > 0.01) { // Small threshold to avoid noise
          this.emit('volume', this.currentVolume);
          log.info(`Volume changed to ${Math.round(this.currentVolume * 100)}%`);
        }
      }
    }

    else if (name === 'VoiceAssistantRequest' && message.start) {
      this.emit('start');
    }

    else if (name === 'PingRequest') {
      this.send('PingResponse', {});
    }
  }


  run_start(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_RUN_START, {}, 'RUN_START');
  }

  run_end(): void {
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




  /**
   * Subscribe to state updates for media player, volume number entity, and mute switch
   * This allows tracking of volume changes and playback state
   */
  subscribeToMediaPlayerState(): void {
    const mediaPlayerKey = this.entityKeys['media_player'];
    const volumeKey = this.entityKeys['volume'];
    const muteKey = this.entityKeys['mute'];

    log.info('Subscribing to device state updates');

    // Subscribe to the media player entity if available
    if (mediaPlayerKey) {
      try {
        this.send('SubscribeMediaPlayerStateRequest', {
          key: mediaPlayerKey
        });
        log.info(`Subscribed to media player state updates with key ${mediaPlayerKey}`);
      } catch (error) {
        log.warn('Error subscribing to media player state:', error);
      }
    }

    // Subscribe to the volume number entity if available
    if (volumeKey) {
      try {
        this.send('SubscribeNumberStateRequest', {
          key: volumeKey
        });
        log.info(`Subscribed to volume number entity state updates with key ${volumeKey}`);
      } catch (error) {
        log.warn('Error subscribing to volume number state:', error);
      }
    }

    // Subscribe to the mute switch if available
    if (muteKey) {
      try {
        this.send('SubscribeSwitchStateRequest', {
          key: muteKey
        });
        log.info(`Subscribed to mute switch state updates with key ${muteKey}`);
      } catch (error) {
        log.warn('Error subscribing to mute switch state:', error);
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

  /**
   * Sets the volume level (0-1)
   * @param volume Volume level (0-1)
   */
  setVolume(volume: number): void {
    // Ensure volume is between 0 and 1
    volume = Math.max(0, Math.min(1, volume));
    log.info(`Setting volume to ${Math.round(volume * 100)}%`);

    // Get media player entity key
    const mediaPlayerKey = this.entityKeys['media_player'];
    if (!mediaPlayerKey) {
      log.warn('No media player entity found for volume control');
      return;
    }

    try {
      // Send MediaPlayerCommandRequest
      this.send('MediaPlayerCommandRequest', {
        key: mediaPlayerKey,
        hasVolume: true,
        volume: volume
      });

      // Track state locally
      this.currentVolume = volume;
    } catch (error) {
      log.error('Error sending volume command:', error);
    }
  }

  /**
   * Mutes or unmutes the device using the dedicated mute switch
   * @param mute True to mute, false to unmute
   */
  setMute(mute: boolean): void {
    log.info(`${mute ? 'Muting' : 'Unmuting'} device`);

    // Find the mute switch entity key
    const muteKey = this.entityKeys['mute'];

    if (!muteKey) {
      log.warn('No mute switch entity found');
      return;
    }

    // Send switch command to control mute state
    try {
      this.send('SwitchCommandRequest', {
        key: muteKey,
        state: mute
      });

      // Track state locally
      this.isMuted = mute;

      // Emit event
      this.emit('mute', this.isMuted);
    } catch (error) {
      log.error('Error setting mute state:', error);
    }
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
