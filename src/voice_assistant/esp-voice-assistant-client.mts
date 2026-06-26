import EventEmitter from 'node:events';
import net from 'node:net';
import { TypedEmitter } from "tiny-typed-emitter";
import { encodeFrame, decodeFrame, VA_EVENT } from './esp-messages.mjs';
import { createLogger } from '../helpers/logger.mjs';


interface EspVoiceClientOptions {
  host: string;
  apiPort?: number;
  discoveryMode?: boolean;
  // When set (and not NONE/0) the client subscribes to the device's OWN ESPHome
  // logs over the native API and surfaces them inline (see deviceLogger). Accepts
  // a LogLevel name ('DEBUG') or number (0-7). Defaults to the ESP_LOG_LEVEL env
  // var so it can be toggled for emulator debugging without a code change.
  logLevel?: string | number;
}

// ESPHome LogLevel enum (api.proto). Used to drive SubscribeLogsRequest.
const LOG_LEVELS: Record<string, number> = {
  NONE: 0, ERROR: 1, WARN: 2, INFO: 3, CONFIG: 4, DEBUG: 5, VERBOSE: 6, VERY_VERBOSE: 7,
};

// Resolve a level name/number/env string to a LogLevel int; anything unknown or
// out of range (incl. undefined) means "don't subscribe" (0 = NONE).
function resolveLogLevel(value: string | number | undefined): number {
  if (value === undefined || value === null || value === '') {
    return 0;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isNaN(n)) {
    return n >= 0 && n <= 7 ? n : 0;
  }
  return LOG_LEVELS[String(value).toUpperCase().replace(/[\s-]/g, '_')] ?? 0;
}

type EspVoiceEvents = {
  Healthy: () => void;
  Unhealthy: () => void;
  announce_finished: () => void;
  starting: () => void;
  started: () => void;
  chunk: (data: Buffer) => void;
  capabilities: (mediaPlayersCount: number, subscribeVoiceAssistantCount: number, voiceAssistantConfigurationCount: number, deviceType: string | null) => void;
  volume: (level: number) => void; // Volume change event
  mute: (isMuted: boolean) => void; // Mute state change event
}



class EspVoiceAssistantClient extends (EventEmitter as new () => TypedEmitter<EspVoiceEvents>) {
  private homey: any;
  private host: string;
  private readonly apiPort: number;
  private streamId: number;
  private rxBuf: Buffer;
  private connected: boolean;
  private tcp: net.Socket | null;
  private reconnectTimer: NodeJS.Timeout | null;
  private reconnectAttempt: number;
  private readonly MAX_RECONNECT_DELAY: number;
  private lastMessageReceivedTime: number;
  private healthCheckTimer: NodeJS.Timeout | null;
  private readonly PING_TIMEOUT: number;
  private readonly HEALTH_CHECK_INTERVAL: number;
  private mediaPlayersCount: number;
  private subscribeVoiceAssistantCount: number;
  private voiceAssistantConfigurationCount: number;
  private discoveryMode: boolean;
  // Whether the device advertised the TIMERS voice-assistant feature flag
  // (DeviceInfoResponse.voice_assistant_feature_flags & 8). Used to gate the
  // timer feature; the PE sets it.
  private timersSupported: boolean = false;
  // Whether to auto-reconnect on disconnect. Disabled for one-shot discovery
  // probes (which have their own timeout) so a failed/finished probe can never
  // spawn an orphaned reconnect loop that holds the device's API connection slot.
  private readonly autoReconnect: boolean;
  // Set once disconnect() is called: a terminal flag that permanently prevents
  // any further reconnect scheduling, even from a late socket error/close event.
  private closed: boolean = false;
  private deviceType: string | null;
  private logger = createLogger('ESP', false);
  // The device's OWN ESPHome firmware logs, streamed over the native API
  // (SubscribeLogsRequest) and printed under [PE] so the device-side view of the
  // voice flow interleaves with our [ESP] client logs and the app's flow logs.
  private deviceLogger = createLogger('PE', false);
  // Resolved LogLevel for the device-log subscription (0 = NONE = disabled).
  private readonly logLevel: number;
  private shouldAnnounceFinished: boolean = true;

  // Store entity keys by object_id for easier access
  private entityKeys: {
    [objectId: string]: number
  } = {};

  // Track device state
  private currentVolume: number = 0.5;
  private isMutedValue: boolean = false;


  constructor(homey: any, { host, apiPort = 6053, discoveryMode = false, logLevel }: EspVoiceClientOptions) {
    super();

    this.homey = homey;
    this.host = host;
    this.apiPort = apiPort;
    this.discoveryMode = discoveryMode;
    // Opt-in via the option or the ESP_LOG_LEVEL env var (e.g. ESP_LOG_LEVEL=DEBUG).
    this.logLevel = resolveLogLevel(logLevel ?? process.env.ESP_LOG_LEVEL);
    // Discovery probes are one-shot; never reconnect them.
    this.autoReconnect = !discoveryMode;

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
      this.homey.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // A fresh start() means we are no longer in the terminal "closed" state
    // (relevant for the auto-reconnect path on the real device).
    this.closed = false;

    // Detach any handlers from a previous socket so its late close/error events
    // can't re-enter handleDisconnect() after we've moved on.
    if (this.tcp) {
      this.tcp.removeAllListeners();
      try { this.tcp.destroy(); } catch { }
      this.tcp = null;
    }

    this.logger.info(`Connecting to ${this.host}:${this.apiPort}`);
    this.tcp = net.createConnection(this.apiPort, this.host, () => this.onConnect());
    this.tcp.setKeepAlive(true, 1000);
    this.tcp.on('connect', () => {
      // Nothing to do here?
    });
    this.tcp.on('data', (data) => this.onTcpData(data));
    this.tcp.on('error', (err) => {
      this.logger.error('TCP connection error', err);
      this.handleDisconnect();
    });
    this.tcp.on('close', () => {
      if (this.connected) {
        this.logger.warn('TCP connection closed unexpectedly');
        this.handleDisconnect();
      }
    });
  }



  setHost(address: any) {
    this.host = address;
  }

  scheduleReconnect(): void {

    // Never reconnect a one-shot discovery probe, and never reconnect after the
    // client has been intentionally closed. This prevents orphaned reconnect
    // loops (e.g. a late error firing after disconnect() has already run) from
    // holding the device's limited API connection slots — which made repeated
    // pairing attempts fail with read ETIMEDOUT.
    if (this.closed || !this.autoReconnect) {
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), this.MAX_RECONNECT_DELAY);
    this.logger.warn('Scheduling reconnection attempt', { attempt: this.reconnectAttempt + 1, delayMs: delay });

    this.reconnectTimer = this.homey.setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempt++;
      await this.start();
    }, delay);
  }

  async onConnect(): Promise<void> {
    this.logger.info(`Connected to ${this.host}:${this.apiPort}`);
    this.reconnectAttempt = 0;
    this.startHealthCheck();

    this.send('HelloRequest',
      {
        clientInfo: 'ai-voice-assistant',
        apiVersionMajor: 1,
        apiVersionMinor: 6
      });
  }

  startHealthCheck(): void {

    if (this.healthCheckTimer) {
      this.homey.clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    this.healthCheckTimer = this.homey.setInterval(() => {
      const now = Date.now();
      if (this.lastMessageReceivedTime > 0 && (now - this.lastMessageReceivedTime) > this.PING_TIMEOUT) {
        this.logger.warn('Connection timeout - no ping received', {
          lastPing: Math.round((now - this.lastMessageReceivedTime) / 1000) + 's ago'
        });
        this.handleDisconnect();
      }
      else if (this.lastMessageReceivedTime > 0) {
        this.logger.info('Connection is healthy. Last ping received ' + Math.round((now - this.lastMessageReceivedTime) / 1000) + 's ago');
      }
    }, this.HEALTH_CHECK_INTERVAL);
  }

  handleDisconnect(): void {

    this.connected = false;
    this.emit('Unhealthy');

    if (this.healthCheckTimer) {
      this.homey.clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    this.lastMessageReceivedTime = 0;

    if (this.tcp) {
      this.tcp.removeAllListeners();
      this.tcp.destroy();
      this.tcp = null;
    }
    this.scheduleReconnect();
  }

  async disconnect(): Promise<boolean> {
    this.logger.info('Disconnecting ESP Voice Client');

    // Mark as disconnected and closed before anything else. `closed` is terminal:
    // it guarantees no reconnect can be scheduled afterwards, even if a late
    // socket error/close event calls handleDisconnect() after this point.
    this.connected = false;
    this.closed = true;

    try {
      // Clean up timers
      if (this.reconnectTimer) {
        this.homey.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // Clean up health check timer
      if (this.healthCheckTimer) {
        this.homey.clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = null;
      }      

      // Close mic socket - wrap in try-catch in case it's already closed
      try {
        this.logger.info('Closing mic socket... from disconnect()');
        this.closeMic();
      } catch (err) {
        this.logger.error('Error closing mic socket:', err);
      }



      // Close TCP socket - wrap in try-catch in case it's already closed.
      // Detach listeners first so its close/error events can't re-enter
      // handleDisconnect() and schedule a reconnect after we're done.
      if (this.tcp) {
        try {
          this.tcp.removeAllListeners();
          this.tcp.destroy();
        } catch (err) {
          this.logger.error('Error destroying TCP socket:', err);
        } finally {
          this.tcp = null;
        }
      }

      this.logger.info('ESP Voice Client disconnected');
      return true;

    } catch (err) {
      this.logger.error('Error during disconnect:', err);
      return false;

    } finally {
      // Always emit the disconnected event, but use a setTimeout to 
      // ensure it happens after the current execution context
      this.homey.setTimeout(() => {
        try {
          this.emit('Unhealthy');
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
        const rawMessage = JSON.stringify(frame.message).toLocaleLowerCase();
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
      await this.dispatch({name: frame.name ?? '', message: frame.message});

      this.rxBuf = this.rxBuf.subarray(frame.bytes);
    }
  }

  async dispatch({ name, message }: { name: string; message: any }): Promise<void> {


    if (name === 'HelloResponse' && !this.connected) {
      // Validate server API version - VoiceAssistantAnnounceRequest requires API >= 1.5
      const serverMajor = message?.apiVersionMajor ?? 0;
      const serverMinor = message?.apiVersionMinor ?? 0;
      if (serverMajor < 1 || (serverMajor === 1 && serverMinor < 5)) {
        this.logger.warn(`ESPHome API version ${serverMajor}.${serverMinor} is below minimum required 1.5. Some features may not work.`);
      } else {
        this.logger.info(`ESPHome API version: ${serverMajor}.${serverMinor}`);
      }

      // Send ConnectRequest for backward compatibility with pre-2026.1 ESPHome
      // firmware, which authenticates the connection via this message (empty
      // password = no auth). ESPHome 2026.1.0+ (PE firmware 26.x) removed
      // password authentication: the server ignores this message and never
      // replies with a ConnectResponse. We therefore must NOT gate the
      // connection on ConnectResponse - proceed immediately. TCP ordering
      // guarantees an old server processes ConnectRequest before the
      // ListEntitiesRequest that follows, so this is safe on both versions.
      this.send('ConnectRequest', { password: '' });
      this.onConnectionEstablished();
    }

    // Only pre-2026.1 firmware sends this; the connection is already up by the
    // time it arrives (see HelloResponse handling above). Just surface an auth
    // failure if the device actually had a password configured.
    else if (name === 'ConnectResponse') {
      if (message?.invalidPassword) {
        this.logger.warn('ESPHome reported invalid password during connect');
      }
    }


    else if (name === 'ListEntitiesMediaPlayerResponse') {
      this.mediaPlayersCount++;
      if (message.objectId && message.key) {
        this.entityKeys[message.objectId] = message.key;

        // Store the first media player key as our default media_player entity for volume control
        if (!this.entityKeys['media_player']) {
          this.entityKeys['media_player'] = message.key;
          this.logger.info(`Registered media player: ${message.objectId} with key ${message.key} (primary)`);
        } else {
          this.logger.info(`Registered media player: ${message.objectId} with key ${message.key}`);
        }
      }
    }

    else if (name === 'ListEntitiesSwitchResponse') {
      if (message.objectId && message.key) {
        this.entityKeys[message.objectId] = message.key;
        this.logger.info(`Registered switch: ${message.objectId} with key ${message.key}`);
      }
    }

    else if (name === 'ListEntitiesNumberResponse') {
      if (message.objectId && message.key) {
        this.entityKeys[message.objectId] = message.key;
        this.logger.info(`Registered number: ${message.objectId} with key ${message.key}`);

        // Check if this might be a volume control entity
        const objectIdLower = message.objectId.toLowerCase();
        if (objectIdLower.includes('volume')) {
          this.entityKeys['volume'] = message.key;
          this.logger.info(`Found potential volume control number entity: ${message.objectId}`);
        }
      }
    }

    else if (name === 'ListEntitiesSelectResponse') {
      if (message.objectId && message.key) {
        this.entityKeys[message.objectId] = message.key;
        this.logger.info(`Registered select: ${message.objectId} with key ${message.key}`);
      }
    }

    else if (name === 'ListEntitiesSensorResponse') {
      if (message.objectId && message.key) {
        this.entityKeys[message.objectId] = message.key;
        this.logger.info(`Registered sensor: ${message.objectId} with key ${message.key}`);
      }
    }

    else if (name === 'ListEntitiesBinarySensorResponse') {
      if (message.objectId && message.key) {
        this.entityKeys[message.objectId] = message.key;
        this.logger.info(`Registered binary sensor: ${message.objectId} with key ${message.key}`);
      }
    }

    else if (name === 'ListEntitiesDoneResponse') {

      const subscribe = {
        subscribe: true,
        flags: 1    // 1 = API (TCP)
      };

      this.send('SubscribeVoiceAssistantRequest', subscribe);

      // Subscribe to all entity state updates (standard ESPHome flow)
      // This delivers MediaPlayerStateResponse, SwitchStateResponse, NumberStateResponse, etc.
      this.send('SubscribeStatesRequest', {});

      this.homey.setTimeout(() => {
        if (this.connected) {
          this.send('DeviceInfoRequest', {});
        }
      }, 500);
    }

    else if (name === 'DeviceInfoResponse') {
      this.subscribeVoiceAssistantCount++;

      // Parse the voice-assistant feature flags so we know whether the device
      // supports timers. TIMERS = 1 << 3 = 8 (aioesphomeapi VoiceAssistantFeature).
      const featureFlags = message?.voiceAssistantFeatureFlags ?? 0;
      this.timersSupported = (featureFlags & 8) !== 0;
      this.logger.info(`Voice assistant feature flags: ${featureFlags} (timers ${this.timersSupported ? 'supported' : 'NOT advertised'})`);

      this.send('VoiceAssistantConfigurationRequest', {});

    }

    else if (name === 'VoiceAssistantConfigurationResponse') {
      this.voiceAssistantConfigurationCount++
      this.emit('capabilities', this.mediaPlayersCount, this.subscribeVoiceAssistantCount, this.voiceAssistantConfigurationCount, this.deviceType);

    }

    else if (name === 'VoiceAssistantAnnounceFinished') {
      if (this.shouldAnnounceFinished) {
        this.emit('announce_finished');
      }
      this.shouldAnnounceFinished = true;

    }

    else if (name === 'MediaPlayerStateResponse') {
      // Update our tracked volume if it changed
      if (typeof message.volume === 'number') {
        const previousVolume = this.currentVolume;
        this.currentVolume = message.volume;

        // Emit event if volume changed
        if (Math.abs(previousVolume - this.currentVolume) > 0.01) { // Small threshold to avoid noise
          this.emit('volume', this.currentVolume);
          this.logger.info(`Volume changed to ${Math.round(this.currentVolume * 100)}%`);
        }
      }
    }

    else if (name === 'SwitchStateResponse') {
      // Check if this is the mute switch
      const muteKey = this.entityKeys['mute'];
      if (muteKey && message.key === muteKey) {
        const previousMuteState = this.isMutedValue;
        this.isMutedValue = message.state;

        // Emit event if mute state changed
        if (previousMuteState !== this.isMutedValue) {
          this.emit('mute', this.isMutedValue);
          this.logger.info(`Mute state changed to ${this.isMutedValue ? 'muted' : 'unmuted'}`);
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
          this.logger.info(`Volume changed to ${Math.round(this.currentVolume * 100)}%`);
        }
      }
    }

    else if (name === 'VoiceAssistantRequest' && message.start) {
      this.emit('starting');

    } else if (name === 'VoiceAssistantRequest') {
      this.emit('started');

    } else if (name === 'VoiceAssistantAudio') {
      // Handle audio data received over the API (TCP) instead of UDP
      if (message.data && message.data.length > 0) {
        this.emit('chunk', Buffer.from(message.data));
      }

    } else if (name === 'SubscribeLogsResponse') {
      // The device's own firmware log line (bytes, field 3). It already carries
      // ESPHome's level tag + ANSI colors, so print it raw under [PE].
      if (message?.message && message.message.length > 0) {
        const line = Buffer.from(message.message).toString('utf8').replace(/\r?\n$/, '');
        this.deviceLogger.info(line);
      }

    } else if (name === 'PingRequest') {
      this.send('PingResponse', {});
    }
  }

  /**
   * Marks the connection as ready and kicks off entity discovery. Invoked right
   * after HelloResponse (and the backward-compat ConnectRequest), without
   * waiting for a ConnectResponse - ESPHome 2026.1.0+ no longer sends one.
   * Idempotent so a late ConnectResponse from older firmware is harmless.
   */
  private onConnectionEstablished(): void {
    if (this.connected) {
      return;
    }

    this.connected = true;
    this.emit('Healthy');

    this.mediaPlayersCount = 0;
    this.subscribeVoiceAssistantCount = 0;
    this.voiceAssistantConfigurationCount = 0;
    this.entityKeys = {};

    // Stream the device's own ESPHome logs over this same connection (opt-in).
    // Sent before ListEntities so we capture the device-side view from the start.
    // dump_config off — we only want the running log, not the boot config dump.
    if (this.logLevel > 0) {
      this.send('SubscribeLogsRequest', { level: this.logLevel, dumpConfig: false });
      this.logger.info(`Subscribed to device logs at LogLevel ${this.logLevel}`);
    }

    this.send('ListEntitiesRequest', {});
  }


  send_voice_assistant_request(): void {

    this.shouldAnnounceFinished = false;

    /* 
      Note to self:
      
      Strange behavior when announcing media
      The message must contain either "media_id" or "mediaId" for this to work.
      However, the "mediaId" field must be populated with a valid sound (flac) URL. Which the ESP then will play.
            mediaId: SOUND_URLS.wake_word_triggered   -> Works
      While "media_id" can be an empty string. It must be defined however.
            media_id: ''      -> Works also
      If none of these are included in the message, then it will not work.
      
      This could be a bug in firmware, be on the look out for this.
    */

    this.send('VoiceAssistantAnnounceRequest', {
      startConversation: true,
      media_id: '',

    });

  }

  run_start(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_RUN_START, {}, 'RUN_START');
  }

  run_end(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_RUN_END, {}, 'RUN_END');
    this.streamId++;
  }

  pipeline_error(code: string, message: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_ERROR, { code, message }, 'ERROR');
  }

  wake_word_end(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_WAKE_WORD_END, {}, 'WAKE_WORD_END');
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

  intent_progress(text: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_INTENT_PROGRESS, { text }, 'INTENT_PROGRESS');
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
    this.logger.info('Starting voice session via API (TCP)');

    // Send VoiceAssistantResponse to indicate we're ready to receive audio via API
    this.send('VoiceAssistantResponse', {
      port: 0,  // Port 0 indicates API mode, not UDP
      error: false
    });
  }

  closeMic(): void {
    // No longer needed - audio is received via API (TCP) instead of UDP
    this.logger.info('closeMic called - no action needed (API mode)');
  }




  /**
   * Subscribe to state updates for media player, volume number entity, and mute switch
   * This allows tracking of volume changes and playback state
   */
  subscribeToMediaPlayerState(): void {
    const mediaPlayerKey = this.entityKeys['media_player'];
    const volumeKey = this.entityKeys['volume'];
    const muteKey = this.entityKeys['mute'];

    this.logger.info('Subscribing to device state updates');

    // Subscribe to the media player entity if available
    if (mediaPlayerKey) {
      try {
        this.send('SubscribeMediaPlayerStateRequest', {
          key: mediaPlayerKey
        });
        this.logger.info(`Subscribed to media player state updates with key ${mediaPlayerKey}`);

      } catch (error) {
        this.logger.warn('Error subscribing to media player state:', error);
      }
    }

    // Subscribe to the volume number entity if available
    if (volumeKey) {
      try {
        this.send('SubscribeNumberStateRequest', {
          key: volumeKey
        });
        this.logger.info(`Subscribed to volume number entity state updates with key ${volumeKey}`);

      } catch (error) {
        this.logger.warn('Error subscribing to volume number state:', error);
      }
    }

    // Subscribe to the mute switch if available
    if (muteKey) {
      try {
        this.send('SubscribeSwitchStateRequest', {
          key: muteKey
        });
        this.logger.info(`Subscribed to mute switch state updates with key ${muteKey}`);

      } catch (error) {
        this.logger.warn('Error subscribing to mute switch state:', error);
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

  /** Whether the device advertised support for on-device timers. */
  get supportsTimers(): boolean {
    return this.timersSupported;
  }

  /** Whether the native-API TCP connection is established (handshake complete). */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a VoiceAssistantTimerEventResponse (id 115) to drive the device's
   * on-device timer (LED-ring countdown + finish chime). Despite the
   * "...Response" suffix this is a CLIENT→device message in the ESPHome model.
   * Driven by TimerManager; see docs/.../timer-feature.md.
   */
  sendTimerEvent(
    eventType: number,
    opts: { timerId: string; name?: string; totalSeconds: number; secondsLeft: number; isActive: boolean },
    quiet: boolean = false
  ): void {
    // quiet suppresses the TX log line — used for the periodic drift-resync
    // UPDATED so a long countdown doesn't spam the log every interval.
    this.send('VoiceAssistantTimerEventResponse', {
      eventType,
      timerId: opts.timerId,
      name: opts.name ?? '',
      totalSeconds: opts.totalSeconds,
      secondsLeft: opts.secondsLeft,
      isActive: opts.isActive,
    }, !quiet);
  }

  /**
   * Sets the volume level (0-1)
   * @param volume Volume level (0-1)
   */
  setVolume(volume: number): void {
    // Ensure volume is between 0 and 1
    volume = Math.max(0, Math.min(1, volume));
    this.logger.info(`Setting volume to ${Math.round(volume * 100)}%`);

    // Get media player entity key
    const mediaPlayerKey = this.entityKeys['media_player'];
    if (!mediaPlayerKey) {
      this.logger.warn('No media player entity found for volume control');
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
      this.logger.error('Error sending volume command:', error);
    }
  }

  /**
   * Mutes or unmutes the device using the dedicated mute switch
   * @param mute True to mute, false to unmute
   */
  setMute(mute: boolean): void {
    this.logger.info(`${mute ? 'Muting' : 'Unmuting'} device`);

    // Find the mute switch entity key
    const muteKey = this.entityKeys['mute'];

    if (!muteKey) {
      this.logger.warn('No mute switch entity found');
      return;
    }

    // Send switch command to control mute state
    try {
      this.send('SwitchCommandRequest', {
        key: muteKey,
        state: mute
      });

      // Track state locally
      this.isMutedValue = mute;

      // Emit event
      this.emit('mute', this.isMutedValue);

    } catch (error) {
      this.logger.error('Error setting mute state:', error);
    }
  }




  vaEvent(type: number, extra: Record<string, any> = {}, name: string): void {

    const payload = {
      eventType: type,
      streamId: this.streamId,
      ...extra
    };

    this.logger.info(`VoiceAssistantEvent: ${name}`, "TX", payload);

    this.send('VoiceAssistantEventResponse', payload, false);
  }

  send(name: string, payload: any, doLog: boolean = true): void {
    if (doLog) {
      this.logger.info(name, 'TX', payload);
    }
    this.tcp?.write(encodeFrame(name, payload));
  }

  logRx(f: any): void {


    // VoiceAssistantAudio is per-chunk mic audio (too noisy); SubscribeLogsResponse
    // is the device's own log, surfaced under [PE] in dispatch (skip the raw RX dump).
    if (f.name === 'VoiceAssistantAudio' || f.name === 'SubscribeLogsResponse') {
      return;
    }

    this.logger.info(f.name || `unknown#${f.id}`, 'RX', f.message || { length: f.payload.length });
  }

}

export { EspVoiceAssistantClient, EspVoiceClientOptions };
