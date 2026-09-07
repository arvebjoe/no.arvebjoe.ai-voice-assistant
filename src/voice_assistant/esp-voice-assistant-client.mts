import EventEmitter from 'node:events';
import net from 'node:net';
import { TypedEmitter } from "tiny-typed-emitter";
import { encodeFrame, decodeFrame, encodeBody, decodeBody, VA_EVENT } from './esp-messages.mjs';
import { NoiseFrameCodec } from './noise-frame-codec.mjs';
import { resolveEntityObjectId } from './entity-object-id.mjs';
import { createLogger } from '../helpers/logger.mjs';


export interface EspVoiceClientOptions {
  host: string;
  apiPort?: number;
  discoveryMode?: boolean;
  // When set (and not NONE/0) the client subscribes to the device's OWN ESPHome
  // logs over the native API and surfaces them inline (see deviceLogger). Accepts
  // a LogLevel name ('DEBUG') or number (0-7). Defaults to the ESP_LOG_LEVEL env
  // var so it can be toggled for emulator debugging without a code change.
  logLevel?: string | number;
  // The device's ESPHome API encryption key (base64, 32 bytes decoded). When
  // set, every connection runs the Noise_NNpsk0 handshake and all traffic is
  // encrypted; when unset, the plaintext protocol is used unchanged.
  encryptionKey?: string;
  // MAC to verify against the Noise server hello (any format). Guards against
  // reaching a different device after a DHCP reshuffle. Only used when
  // encryptionKey is set; older firmware that omits the MAC skips the check.
  expectedMac?: string;
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

/**
 * One entry of VoiceAssistantEventResponse.data — the message's only payload
 * carrier (see vaEvent).
 */
interface VaEventData {
  name: string;
  value: string;
}

/** A wake word the satellite has on board (VoiceAssistantConfigurationResponse). */
export interface EspWakeWord {
  id: string;
  wakeWord: string;
  trainedLanguages: string[];
}

/**
 * Whether we hold the satellite's voice-assistant subscription.
 *
 * ESPHome tracks exactly ONE voice-assistant client
 * (`VoiceAssistant::client_subscription`): the first to subscribe wins, and a
 * second `SubscribeVoiceAssistantRequest` is rejected with nothing but an
 * `ESP_LOGE("Multiple API Clients attempting to connect to Voice Assistant")`
 * on the device itself. Every voice message we then send — mic-open announces,
 * pipeline events, timer events — is dropped by
 * `APIConnection::check_voice_assistant_api_connection_()`, silently, on a
 * connection that otherwise looks perfectly healthy from here.
 *
 * In practice the other client is Home Assistant, which the satellite is
 * usually still added to (it is why it has an encryption key at all). See
 * GitHub issue #54: an hour of logs where the app never received a single
 * voice request while HA answered every question on the same device.
 *
 * - `ok`        we demonstrably own it (the device talked to us on that path)
 * - `suspected` the empty wake-word list hints we do not — see the
 *               VoiceAssistantConfigurationResponse handler for why that is a
 *               hint and not proof
 * - `taken`     proof: a mic-open went unanswered
 */
export type VaOwnerState = 'ok' | 'suspected' | 'taken';

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
  // The satellite's wake-word configuration arrived/changed (available + active).
  wake_words: (available: EspWakeWord[], active: string[], maxActive: number) => void;
  // Our claim on the device's single voice-assistant subscription changed.
  // Fires only on a change, and re-derives itself on every reconnect.
  voice_assistant_owner: (state: VaOwnerState) => void;
  // A stateless Event entity fired on the device (EventResponse, msg id 108) —
  // e.g. the ThirdReality's physical top button. Carries the entity's object_id
  // and the event type string the firmware sent (e.g. 'single_press').
  entity_event: (objectId: string, eventType: string) => void;
  // The device answered our plaintext frames with the Noise indicator (0x01):
  // it has an API encryption key configured and refuses plaintext. The user
  // must supply the key (device setting / manual-entry pair field).
  requires_encryption: () => void;
  // The Noise path failed. Codes: 'invalid_key' (key is not base64/32 bytes),
  // 'wrong_key' (PSK rejected), 'plaintext_device' (key given but the device
  // has none set), 'mac_mismatch', 'protocol_error'.
  encryption_error: (code: string, message: string) => void;
}



class EspVoiceAssistantClient extends (EventEmitter as new () => TypedEmitter<EspVoiceEvents>) {
  private homey: any;
  private host: string;
  private readonly apiPort: number;
  private rxBuf: Buffer;
  private connected: boolean;
  private tcp: net.Socket | null;
  private reconnectTimer: NodeJS.Timeout | null;
  private reconnectAttempt: number;
  // Whether the current offline streak has already been reported as an error.
  // A satellite that is unplugged or unreachable fails a reconnect every few
  // seconds; only the first failure is worth a full error report (which goes
  // to Sentry) — the rest are downgraded to warn until a connect succeeds.
  private connectErrorReported: boolean = false;
  private readonly MAX_RECONNECT_DELAY: number;
  private lastMessageReceivedTime: number;
  private healthCheckTimer: NodeJS.Timeout | null;
  private readonly PING_TIMEOUT: number;
  private readonly HEALTH_CHECK_INTERVAL: number;
  private readonly MAX_RX_BUFFER: number;
  private mediaPlayersCount: number;
  private subscribeVoiceAssistantCount: number;
  private voiceAssistantConfigurationCount: number;
  private discoveryMode: boolean;
  // Immutable: was this client created purely to probe a device during pairing?
  // Unlike `discoveryMode` (which is flipped to false once the device type is
  // sniffed), this stays true for the connection's whole life, so we know never
  // to grab the device's voice-assistant subscription (which would steal it from
  // the real, in-use connection of an already-paired satellite).
  private readonly isDiscoveryProbe: boolean;
  // Whether the device advertised the TIMERS voice-assistant feature flag
  // (DeviceInfoResponse.voice_assistant_feature_flags & 8). Used to gate the
  // timer feature; the PE sets it.
  private timersSupported: boolean = false;
  // Whether DeviceInfoResponse advertised ANY voice-assistant feature flag, i.e.
  // whether the ESPHome voice_assistant component is compiled in at all. Every
  // voice satellite sets at least VOICE_ASSISTANT | API_AUDIO, so a zero here
  // means the device simply has no voice assistant to own — which the
  // ownership check below must not mistake for a stolen subscription.
  private isVoiceSatellite: boolean = false;
  // Our claim on the device's single voice-assistant subscription slot, or null
  // before any evidence has arrived on this connection. See VaOwnerState.
  private vaOwner: VaOwnerState | null = null;
  // Armed by send_voice_assistant_request(), disarmed by anything the device
  // sends back on the voice-assistant path. If it ever fires, our announces are
  // being discarded and someone else holds the subscription.
  private micOpenTimer: NodeJS.Timeout | null = null;
  // Generous: a mic-open announce is answered within ~0.3 s when the chime
  // plays, and the firmware's own start_playback_timeout_ caps the silent case
  // at 2 s. Anything past this is not slow, it is not listening.
  private readonly MIC_OPEN_TIMEOUT: number = 8000;
  // Whether to auto-reconnect on disconnect. Disabled for one-shot discovery
  // probes (which have their own timeout) so a failed/finished probe can never
  // spawn an orphaned reconnect loop that holds the device's API connection slot.
  private readonly autoReconnect: boolean;
  // Set once disconnect() is called: a terminal flag that permanently prevents
  // any further reconnect scheduling, even from a late socket error/close event.
  private closed: boolean = false;
  private deviceType: string | null;
  // Identity captured from DeviceInfoResponse during a probe. Used by the
  // manual-IP pair flow to build a stable device id (MAC, normalized to the
  // same colon-free lowercase form mDNS reports in txt.mac) and a display name
  // when there is no mDNS record to read them from.
  private macAddress: string = '';
  private friendlyName: string = '';
  // Firmware identity for the log dump's Devices block: HelloResponse.serverInfo
  // ("2026.3.2") and DeviceInfoResponse esphomeVersion/model/manufacturer/project.
  private firmwareInfo: string = '';
  // Noise encryption: the device's API encryption key (undefined = plaintext)
  // and the codec for the CURRENT connection. A codec is single-use (fresh
  // ephemeral keys per handshake), so start() builds a new one every connect.
  private encryptionKey: string | undefined;
  private readonly expectedMac: string | undefined;
  private noise: NoiseFrameCodec | null = null;
  private logger = createLogger('ESP', true);
  // The device's OWN ESPHome firmware logs, streamed over the native API
  // (SubscribeLogsRequest) and printed under [PE] so the device-side view of the
  // voice flow interleaves with our [ESP] client logs and the app's flow logs.
  private deviceLogger = createLogger('PE', true);
  // Resolved LogLevel for the device-log subscription (0 = NONE = disabled).
  private readonly logLevel: number;
  private shouldAnnounceFinished: boolean = true;

  // Store entity keys by object_id for easier access
  private entityKeys: {
    [objectId: string]: number
  } = {};

  // Reverse lookup for Event entities (key -> object_id) so an incoming
  // EventResponse can be attributed to the entity that fired it.
  private eventEntityIds: Map<number, string> = new Map();

  // Best mute-switch match seen in the current entity listing (see
  // scoreMuteCandidate). Reset with entityKeys on every re-listing so a
  // reconnect can't keep a stale winner.
  private muteEntityScore: number = 0;

  // Whether this listing already reported that the device omits object_id (see
  // resolveObjectId) — one line per connection, not one per entity.
  private derivedObjectIdLogged: boolean = false;

  // Track device state
  private currentVolume: number = 0.5;
  private isMutedValue: boolean = false;

  // Wake-word configuration reported by the satellite (gap analysis #7).
  private availableWakeWords: EspWakeWord[] = [];
  private activeWakeWords: string[] = [];
  private maxActiveWakeWords: number = 0;


  constructor(homey: any, { host, apiPort = 6053, discoveryMode = false, logLevel, encryptionKey, expectedMac }: EspVoiceClientOptions) {
    super();

    this.homey = homey;
    this.host = host;
    this.apiPort = apiPort;
    this.encryptionKey = encryptionKey?.trim() || undefined;
    this.expectedMac = expectedMac;
    this.discoveryMode = discoveryMode;
    this.isDiscoveryProbe = discoveryMode;
    // Opt-in via the option or the ESP_LOG_LEVEL env var (e.g. ESP_LOG_LEVEL=DEBUG).
    this.logLevel = resolveLogLevel(logLevel ?? process.env.ESP_LOG_LEVEL);
    // Discovery probes are one-shot; never reconnect them.
    this.autoReconnect = !discoveryMode;

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
    // Well above any legitimate ESPHome frame; a stream that exceeds this without
    // yielding a decodable frame is treated as corrupt.
    this.MAX_RX_BUFFER = 2 * 1_048_576; // 2 MiB
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

    // Discard any partial frame left over from a previous connection. A stale
    // half-frame would otherwise be prepended to the new session's bytes and
    // desync the parser so no frame ever decodes again.
    this.rxBuf = Buffer.alloc(0);

    // Encrypted link: a codec is one-connection-only (fresh ephemeral keys),
    // so build a new one for every connect/reconnect. A malformed key can
    // never succeed — report once and stay down rather than retry-looping.
    this.noise = null;
    if (this.encryptionKey) {
      try {
        this.noise = new NoiseFrameCodec({ psk: this.encryptionKey, expectedMac: this.expectedMac });
      } catch (err: any) {
        this.logger.error('Invalid API encryption key — not connecting', err);
        this.emit('encryption_error', 'invalid_key', err?.message ?? 'invalid encryption key');
        return;
      }
    }

    this.logger.info(`Connecting to ${this.host}:${this.apiPort}${this.noise ? ' (encrypted)' : ''}`);
    this.tcp = net.createConnection(this.apiPort, this.host, () => this.onConnect());
    this.tcp.setKeepAlive(true, 1000);
    this.tcp.on('connect', () => {
      // Nothing to do here?
    });
    this.tcp.on('data', (data) => this.onTcpData(data));
    this.tcp.on('error', (err) => {
      if (this.connectErrorReported) {
        this.logger.warn('TCP connection error', err);
      } else {
        this.connectErrorReported = true;
        this.logger.error('TCP connection error', err);
      }
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

  // MAC captured from DeviceInfoResponse, colon-free lowercase (matches the mDNS
  // txt.mac form). Empty until DeviceInfoResponse has been received.
  getMacAddress(): string {
    return this.macAddress;
  }

  // Friendly name captured from DeviceInfoResponse (falls back to the device
  // name). Empty until DeviceInfoResponse has been received.
  getFriendlyName(): string {
    return this.friendlyName;
  }

  /** e.g. "ESPHome 2026.3.2, Nabu Casa Home Assistant Voice PE" — '' until the device has said hello. */
  getFirmwareInfo(): string {
    return this.firmwareInfo;
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
    this.connectErrorReported = false;
    // Seed the health-check clock so a connection that TCP-connects but never
    // sends a frame (hung/half-open peer) is still detected as timed-out. The
    // check requires lastMessageReceivedTime > 0.
    this.lastMessageReceivedTime = Date.now();
    this.startHealthCheck();

    if (this.noise) {
      // Client hello + Noise handshake message 1 in one write; HelloRequest is
      // held back until the codec reports the handshake complete (see
      // onNoiseData). If the handshake never completes, the health-check
      // timeout tears the connection down like any other silent peer.
      this.tcp?.write(this.noise.startHandshake());
      return;
    }

    this.sendHello();
  }

  private sendHello(): void {
    // API 1.14 is what current firmware expects (2026.3+ logs "'ai-voice-assistant'
    // using outdated API 1.6, update to 1.14+" for anything older). The ONLY
    // behaviour the server keys off this number that concerns us is object_id:
    // 2026.1.0-2026.6.x omit it for 1.14+ clients, and 2026.7.0+ omit it for
    // everyone. resolveObjectId() derives it either way, so advertising 1.14 is
    // safe on every firmware — but do NOT raise this again without checking the
    // `client_supports_api_version` call sites in ESPHome's api_connection.cpp,
    // which is where any future gate will appear.
    this.send('HelloRequest',
      {
        clientInfo: 'ai-voice-assistant',
        apiVersionMajor: 1,
        apiVersionMinor: 14
      });
  }

  startHealthCheck(): void {

    if (this.healthCheckTimer) {
      this.homey.clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    this.healthCheckTimer = this.homey.setInterval(() => {
      const now = Date.now();
      const idleMs = this.lastMessageReceivedTime > 0 ? now - this.lastMessageReceivedTime : 0;
      if (this.lastMessageReceivedTime > 0 && idleMs > this.PING_TIMEOUT) {
        this.logger.warn('Connection timeout - no ping received', {
          lastPing: Math.round(idleMs / 1000) + 's ago'
        });
        this.handleDisconnect();
      }
      else if (this.lastMessageReceivedTime > 0) {
        // The PE chatters on its own (pings, sensor updates), but the TR's Linux
        // firmware goes silent when idle — a passive watchdog then kills a healthy
        // link every PING_TIMEOUT. Ping the device once the link has been quiet;
        // its PingResponse refreshes lastMessageReceivedTime.
        if (idleMs > this.HEALTH_CHECK_INTERVAL / 2) {
          try {
            this.send('PingRequest', {});
          } catch {
            // A dead socket is caught by the timeout branch on the next tick.
          }
        }
        this.logger.info('Connection is healthy. Last ping received ' + Math.round(idleMs / 1000) + 's ago');
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

    // A mic-open that outlives its connection proves nothing about ownership.
    this.clearMicOpenWatchdog();

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

      this.clearMicOpenWatchdog();

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
    // Encrypted link: the Noise codec owns buffering, framing and decryption;
    // decrypted messages re-join the shared handleFrame path below.
    if (this.noise) {
      await this.onNoiseData(data);
      return;
    }

    this.rxBuf = Buffer.concat([this.rxBuf, data]);

    // An encrypted server answers our plaintext frames with the Noise
    // indicator byte (0x01). Without this check the frames just never decode
    // and we look hung until the health check gives up — surface it as the
    // precise "device requires an encryption key" condition instead.
    if (this.rxBuf.length && this.rxBuf[0] === 0x01) {
      this.logger.error('Device requires an API encryption key — it refuses the plaintext protocol');
      this.emit('requires_encryption');
      this.rxBuf = Buffer.alloc(0);
      this.handleDisconnect();
      return;
    }

    // Guard against a hostile/desynced peer buffering unboundedly: if we have
    // accumulated far more than any legitimate frame without decoding one, the
    // stream is corrupt — drop the connection and let reconnect resync.
    if (this.rxBuf.length > this.MAX_RX_BUFFER) {
      this.logger.warn('RX buffer exceeded limit, resetting connection', { bytes: this.rxBuf.length });
      this.rxBuf = Buffer.alloc(0);
      this.handleDisconnect();
      return;
    }

    while (true) {
      let frame: ReturnType<typeof decodeFrame>;
      try {
        frame = decodeFrame(this.rxBuf);
      } catch (err) {
        // Malformed frame (bad protobuf body, oversized payload, …). Without this
        // guard the throw would leave rxBuf un-advanced and every subsequent
        // packet would re-throw on the same bytes, wedging the pipeline forever.
        this.logger.error('Failed to decode frame, resetting connection', err);
        this.rxBuf = Buffer.alloc(0);
        this.handleDisconnect();
        return;
      }

      if (!frame) {
        break;
      }

      await this.handleFrame(frame);

      this.rxBuf = this.rxBuf.subarray(frame.bytes);
    }
  }

  /**
   * RX for an encrypted connection: feed the codec, act on its events. The
   * handshake failure taxonomy (wrong key / plaintext device / MAC mismatch)
   * is surfaced as 'encryption_error' so pairing and the device UI can show a
   * precise message instead of a generic connection failure.
   */
  private async onNoiseData(data: Buffer): Promise<void> {
    if (!this.noise) {
      return;
    }
    for (const ev of this.noise.feed(data)) {
      if (ev.kind === 'ready') {
        this.logger.info(`Encrypted link established with '${ev.serverName}'${ev.serverMac ? ` (${ev.serverMac})` : ''}`);
        this.sendHello();
      } else if (ev.kind === 'message') {
        await this.handleFrame(decodeBody(ev.type, ev.payload));
      } else {
        // Map the codec's protocol-level codes to the user-facing taxonomy.
        const code = ev.code === 'wrong_psk' ? 'wrong_key'
          : ev.code === 'plaintext_server' ? 'plaintext_device'
            : ev.code;
        this.logger.error(`Encryption error (${code}): ${ev.message}`);
        this.emit('encryption_error', code, ev.message);
        this.handleDisconnect();
        return;
      }
    }
  }

  /**
   * One decoded API message, framing-agnostic (plaintext and Noise both land
   * here): identity sniff for discovery probes, then dispatch.
   */
  private async handleFrame(frame: { name: string | null; id: number; message: any; payload: Buffer }): Promise<void> {
    // Identity sniff: ONLY the two identity-bearing messages count (S6). The
    // device name is in HelloResponse (serverInfo/name); manufacturer/model/
    // project/friendly name are in DeviceInfoResponse — both arrive during a
    // probe. Matching every frame let any string field anywhere (an entity
    // named "xiaozhi", a log line) "validate" a device's identity.
    if (this.discoveryMode && !this.deviceType && frame.message
      && (frame.name === 'HelloResponse' || frame.name === 'DeviceInfoResponse')) {
      const rawMessage = JSON.stringify(frame.message).toLocaleLowerCase();
      // Factory PE firmware reports "Nabu Casa" / "Home Assistant Voice PE".
      // Self-compiled firmware from the stock home-assistant-voice.yaml has no
      // project block and identifies only via its device name
      // ("home-assistant-voice-xxxxxx") / friendly name ("Home Assistant Voice"),
      // so match the hyphenated and PE-less forms too.
      if (rawMessage.includes('nabu casa')
        || rawMessage.includes('nabucasa')
        || rawMessage.includes('home assistant voice')
        || rawMessage.includes('home-assistant-voice')) {
        this.deviceType = 'pe';
        this.discoveryMode = false;
      } else if (rawMessage.includes('thirdreality')
        || rawMessage.includes('3rspk')) {
        // ThirdReality Voice & Music Assistant: DeviceInfoResponse reports
        // manufacturer "ThirdReality" / project "ThirdReality.Linux Voice
        // Assistant (C++)"; HelloResponse name is "3RSPK…". Pairs through its
        // own driver (see docs/thirdreality-voice-and-music/README.md).
        this.deviceType = 'tr';
        this.discoveryMode = false;
      } else if (rawMessage.includes('respeaker')
        || rawMessage.includes('xvf3800')) {
        // Seeed reSpeaker XVF3800 + XIAO ESP32S3. Unlike the PE/TR this is
        // DIY firmware the user compiles, so there is no fixed factory
        // identity — match the two product tokens rather than the example
        // config's full device name ("respeaker-xvf3800-assistant") or its
        // project ("formatbce.Respeaker XVF3800 Satellite"), both of which a
        // user is free to change. See docs/respeaker-xvf3800/README.md.
        this.deviceType = 'respeaker';
        this.discoveryMode = false;
      } else if (rawMessage.includes('xiaozhi')) {
        this.deviceType = 'xiaozhi';
        this.discoveryMode = false;
      } else if (rawMessage.includes('atoms3r')
        || rawMessage.includes('echo-base')
        || rawMessage.includes('echo base')
        || rawMessage.includes('m5stack')) {
        // M5Stack AtomS3R + Atomic Echo Base running M5Stack's official
        // ESPHome voice-assistant config (name "atoms3r-with-echo-base",
        // friendly name "AtomS3R Echo Base Voice Assistant", no project
        // block). User-flashed firmware, so match product tokens rather than
        // exact names. Checked AFTER xiaozhi: an identity carrying both
        // tokens is RealDeco XiaoZhi firmware on M5 hardware, and the
        // firmware shape — not the board — decides the driver.
        this.deviceType = 'm5stack';
        this.discoveryMode = false;
      }
    }

    this.lastMessageReceivedTime = Date.now();
    this.logRx(frame);
    await this.dispatch({ name: frame.name ?? '', message: frame.message });
  }

  async dispatch({ name, message }: { name: string; message: any }): Promise<void> {


    if (name === 'HelloResponse' && message?.serverInfo && !this.firmwareInfo) {
      this.firmwareInfo = `ESPHome ${message.serverInfo}`;
    }
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
      const objectId = this.resolveObjectId(message);
      if (message.key) {
        if (objectId) {
          this.entityKeys[objectId] = message.key;
        }

        // Store the first media player key as our default media_player entity for
        // volume control. Keyed on the key ALONE, deliberately: a media player
        // declared `name: None` has no name to derive an object_id from, and it is
        // still the entity we play through.
        if (!this.entityKeys['media_player']) {
          this.entityKeys['media_player'] = message.key;
          this.logger.info(`Registered media player: ${objectId || '(unnamed)'} with key ${message.key} (primary)`);
        } else {
          this.logger.info(`Registered media player: ${objectId || '(unnamed)'} with key ${message.key}`);
        }
      }
    }

    else if (name === 'ListEntitiesSwitchResponse') {
      const objectId = this.resolveObjectId(message);
      if (objectId && message.key) {
        this.entityKeys[objectId] = message.key;
        this.logger.info(`Registered switch: ${objectId} with key ${message.key}`);

        // setMute() reads entityKeys['mute']. The PE and TR name their mic-mute
        // switch exactly "Mute" (object_id `mute`), but that is a convention,
        // not part of the protocol — the ReSpeaker calls its switch
        // "Microphone Mute" (`microphone_mute`), which used to leave mute
        // silently dead. Score candidates instead of taking the first hit:
        // a plain `mute` wins, otherwise a switch mentioning both mic and mute.
        // Deliberately NOT a bare `includes('mute')` — the ReSpeaker also has a
        // `mute_sound` switch (whether to play the mute chime), which such a
        // match would happily mistake for the mic mute.
        const score = this.scoreMuteCandidate(objectId);
        if (score > this.muteEntityScore) {
          this.muteEntityScore = score;
          this.entityKeys['mute'] = message.key;
          this.logger.info(`Using switch '${objectId}' as the mute control (score ${score})`);
        }
      }
    }

    else if (name === 'ListEntitiesNumberResponse') {
      const objectId = this.resolveObjectId(message);
      if (objectId && message.key) {
        this.entityKeys[objectId] = message.key;
        this.logger.info(`Registered number: ${objectId} with key ${message.key}`);

        // Check if this might be a volume control entity
        const objectIdLower = objectId.toLowerCase();
        if (objectIdLower.includes('volume')) {
          this.entityKeys['volume'] = message.key;
          this.logger.info(`Found potential volume control number entity: ${objectId}`);
        }
      }
    }

    else if (name === 'ListEntitiesSelectResponse') {
      const objectId = this.resolveObjectId(message);
      if (objectId && message.key) {
        this.entityKeys[objectId] = message.key;
        this.logger.info(`Registered select: ${objectId} with key ${message.key}`);
      }
    }

    else if (name === 'ListEntitiesSensorResponse') {
      const objectId = this.resolveObjectId(message);
      if (objectId && message.key) {
        this.entityKeys[objectId] = message.key;
        this.logger.info(`Registered sensor: ${objectId} with key ${message.key}`);
      }
    }

    else if (name === 'ListEntitiesBinarySensorResponse') {
      const objectId = this.resolveObjectId(message);
      if (objectId && message.key) {
        this.entityKeys[objectId] = message.key;
        this.logger.info(`Registered binary sensor: ${objectId} with key ${message.key}`);
      }
    }

    else if (name === 'ListEntitiesEventResponse') {
      const objectId = this.resolveObjectId(message);
      if (objectId && message.key) {
        this.entityKeys[objectId] = message.key;
        this.eventEntityIds.set(message.key, objectId);
        this.logger.info(`Registered event entity: ${objectId} with key ${message.key} (types: ${(message.eventTypes ?? []).join(', ') || 'none'})`);
      }
    }

    else if (name === 'ListEntitiesDoneResponse') {

      // A discovery probe must NOT subscribe: ESPHome tracks a single voice-assistant
      // API subscriber, so subscribing here would re-bind an already-paired device's
      // voice pipeline to this short-lived probe connection and break the real one
      // until it reconnects. Identification only needs the entity list plus
      // DeviceInfoResponse (below), which drive the counts the pairing capability
      // check reads.
      if (!this.isDiscoveryProbe) {
        const subscribe = {
          subscribe: true,
          flags: 1    // 1 = API (TCP)
        };

        this.send('SubscribeVoiceAssistantRequest', subscribe);

        // Subscribe to all entity state updates (standard ESPHome flow)
        // This delivers MediaPlayerStateResponse, SwitchStateResponse, NumberStateResponse, etc.
        this.send('SubscribeStatesRequest', {});

        // Custom events the device fires at its API client — `homeassistant.event`
        // actions in the YAML, e.g. the ReSpeaker's esphome.tts_uri /
        // esphome.stt_text / esphome.wake_word_detected. Without this the firmware
        // discards each one and logs "dropped; client has not subscribed to actions
        // (yet)", several lines per turn. We act on none of them today; subscribing
        // keeps the device log readable and is what makes them available at all.
        this.send('SubscribeHomeassistantServicesRequest', {});
      }

      this.homey.setTimeout(() => {
        if (this.connected) {
          this.send('DeviceInfoRequest', {});
        }
      }, 500);
    }

    else if (name === 'DeviceInfoResponse') {
      this.subscribeVoiceAssistantCount++;

      // Capture identity for the manual-IP pair flow. mac_address arrives as
      // "AC:BC:32:89:0E:A9"; normalize to colon-free lowercase so it matches the
      // mDNS discovery id ({{txt.mac}}) and lets onDiscoveryResult still track
      // the device if it later shows up over mDNS.
      if (message?.macAddress) {
        this.macAddress = String(message.macAddress).replace(/:/g, '').toLowerCase();
      }
      if (message?.friendlyName || message?.name) {
        this.friendlyName = message.friendlyName || message.name;
      }
      {
        const version = message?.esphomeVersion ? `ESPHome ${message.esphomeVersion}` : this.firmwareInfo;
        const make = [message?.manufacturer, message?.model].filter(Boolean).join(' ');
        const project = message?.projectName ? `${message.projectName}${message.projectVersion ? ` ${message.projectVersion}` : ''}` : '';
        this.firmwareInfo = [version, make, project].filter(Boolean).join(', ');
      }

      // Parse the voice-assistant feature flags so we know whether the device
      // supports timers. TIMERS = 1 << 3 = 8 (aioesphomeapi VoiceAssistantFeature).
      const featureFlags = message?.voiceAssistantFeatureFlags ?? 0;
      this.timersSupported = (featureFlags & 8) !== 0;
      this.isVoiceSatellite = featureFlags !== 0 || (message?.legacyVoiceAssistantVersion ?? 0) !== 0;
      this.logger.info(`Voice assistant feature flags: ${featureFlags} (timers ${this.timersSupported ? 'supported' : 'NOT advertised'})`);

      // A discovery probe must NOT ask for the voice-assistant configuration:
      // on ESPHome 2025.8.0 - 2026.5.0 that request CRASHES an unsubscribed
      // device. VoiceAssistantConfigurationResponse.active_wake_words became a
      // POINTER in 2025.8.0 (`const std::vector<std::string> *`, default null),
      // and the unsubscribed branch of
      // APIConnection::send_voice_assistant_get_configuration_response_() sends
      // the response without ever setting it — so calculate_size() runs
      // `this->active_wake_words->empty()` on nullptr and the ESP32 panics with
      // LoadProhibited and reboots. That is the "sent the request, then total
      // silence until the probe times out" field report; the satellite is not
      // ignoring us, it is rebooting. 2026.6.0 fixed it by pointing the field at
      // a stack-local empty vector, and <= 2025.7.0 was safe because the field
      // was still a by-value vector.
      //
      // Subscribing first would also avoid the crash, but a probe must never
      // subscribe: ESPHome tracks a single voice-assistant API subscriber, so
      // probing an ALREADY-PAIRED device (which pairing does — list_devices
      // probes everything mDNS returns) would re-bind its pipeline to this
      // short-lived connection and leave it deaf until it reconnects.
      //
      // Nothing is lost: DeviceInfoResponse.voice_assistant_feature_flags is
      // sent unconditionally, needs no subscription, and is non-zero for every
      // voice satellite — get_feature_flags() always ORs in FEATURE_VOICE_
      // ASSISTANT | FEATURE_API_AUDIO when the component is compiled in. The
      // wake-word list is the only extra the config response carries, and a
      // probe has no use for it; the real (subscribed) connection still asks.
      if (this.isDiscoveryProbe) {
        const legacyVersion = message?.legacyVoiceAssistantVersion ?? 0;
        const isVoiceSatellite = featureFlags !== 0 || legacyVersion !== 0;
        this.voiceAssistantConfigurationCount = isVoiceSatellite ? 1 : 0;
        this.logger.info(`Probe: voice assistant ${isVoiceSatellite ? 'supported' : 'NOT supported'} (flags ${featureFlags}, legacy version ${legacyVersion})`);
        this.emit('capabilities', this.mediaPlayersCount, this.subscribeVoiceAssistantCount, this.voiceAssistantConfigurationCount, this.deviceType);
        return;
      }

      this.send('VoiceAssistantConfigurationRequest', {});

    }

    else if (name === 'VoiceAssistantConfigurationResponse') {
      this.voiceAssistantConfigurationCount++

      // Wake-word configuration (gap analysis #7): what the satellite has on
      // board and which are active. Kept in sync on every response — a
      // setActiveWakeWords() re-requests the config so this refreshes.
      this.availableWakeWords = (message?.availableWakeWords ?? []).map((w: any) => ({
        id: w?.id ?? '',
        wakeWord: w?.wakeWord ?? '',
        trainedLanguages: w?.trainedLanguages ?? [],
      })).filter((w: EspWakeWord) => w.id);
      this.activeWakeWords = message?.activeWakeWords ?? [];
      this.maxActiveWakeWords = message?.maxActiveWakeWords ?? 0;
      if (this.availableWakeWords.length) {
        this.logger.info(`Wake words: available=[${this.availableWakeWords.map(w => w.id).join(', ')}], active=[${this.activeWakeWords.join(', ')}], max=${this.maxActiveWakeWords}`);
        this.emit('wake_words', this.getAvailableWakeWords(), this.getActiveWakeWords(), this.maxActiveWakeWords);
      }

      // Ownership signal #1. ESPHome answers this request with an EMPTY response
      // when the asking connection is not the voice assistant's owner — that is
      // the whole unsubscribed branch of
      // APIConnection::send_voice_assistant_get_configuration_response_(), which
      // returns before it copies a single wake word. A satellite we own always
      // lists its on-board wake words (`available=[hey_homey, okay_nabu, ...]`),
      // so an empty list on a device that advertised voice-assistant feature
      // flags means our SubscribeVoiceAssistantRequest was rejected.
      //
      // Not proof, which is why it only ever reaches 'suspected': a satellite
      // with no on-board wake word engine (wake word detected upstream instead)
      // owns its voice assistant and still answers with an empty list. Only an
      // unanswered mic-open separates the two, and that is signal #2.
      if (this.availableWakeWords.length) {
        this.setVaOwner('ok');
      } else if (this.isVoiceSatellite) {
        this.setVaOwner('suspected');
      }

      this.emit('capabilities', this.mediaPlayersCount, this.subscribeVoiceAssistantCount, this.voiceAssistantConfigurationCount, this.deviceType);

    }

    else if (name === 'VoiceAssistantAnnounceFinished') {
      // on_voice_assistant_announce_request() is owner-gated too, so an announce
      // that finishes is an announce that was accepted.
      this.setVaOwner('ok');
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

    else if (name === 'EventResponse') {
      // Delivered through the SubscribeStatesRequest subscription like any other
      // entity state. The ThirdReality's top button is its only Event entity.
      const objectId = this.eventEntityIds.get(message.key) ?? '';
      const eventType = message.eventType ?? '';
      this.logger.info(`Event entity fired: ${objectId || `key ${message.key}`} -> ${eventType}`);
      this.emit('entity_event', objectId, eventType);
    }

    else if (name === 'VoiceAssistantRequest' && message.start) {
      // The device only ever sends this to the client holding its subscription.
      this.setVaOwner('ok');
      this.emit('starting');

    } else if (name === 'VoiceAssistantRequest') {
      this.setVaOwner('ok');
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

    } else if (name === 'HomeassistantServiceResponse') {
      // A custom event/action the device fired at us (see the subscribe call).
      // Nothing consumes these yet — logged so a device's own signalling is
      // visible when diagnosing a field report, rather than silently discarded
      // the way the firmware discarded them before we subscribed.
      // HomeassistantServiceMap is {key, value} — NOT the {name, value} shape
      // VoiceAssistantEventResponse.data uses.
      const data = (message?.data ?? [])
        .map((d: { key: string, value: string }) => `${d.key}=${d.value}`)
        .join(' ');
      this.logger.info(`Device ${message?.isEvent ? 'event' : 'action'}: ${message?.service ?? '(unnamed)'}${data ? ` ${data}` : ''}`, 'RX');

    } else if (name === 'PingRequest') {
      this.send('PingResponse', {});
    }
  }

  /**
   * Our own IPv4 address on the socket carrying this device's API connection —
   * i.e. the address the satellite is demonstrably able to reach us on. The
   * WebServer prefers it over interface sniffing when building audio URLs,
   * because interface names alone cannot distinguish Homey's LAN address from
   * the app container's Docker-bridge address (both present as `eth0`).
   *
   * Null while disconnected, and for IPv6 sockets — the audio URLs are built as
   * bare `http://<host>/…`, which an IPv6 literal would need brackets for, and
   * no satellite has ever connected over IPv6.
   */
  get localAddress(): string | null {
    const addr = this.tcp?.localAddress;
    if (!addr || this.tcp?.localFamily !== 'IPv4') {
      return null;
    }
    return addr;
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
    // Ownership is a property of THIS connection: a reconnect can win the slot
    // a previous one lost (and vice versa). Cleared without emitting — the
    // config response re-derives it a second from now, so the device keeps
    // showing the last known state until there is something better to say.
    this.vaOwner = null;
    this.clearMicOpenWatchdog();
    this.entityKeys = {};
    this.eventEntityIds.clear();
    this.muteEntityScore = 0;
    this.derivedObjectIdLogged = false;

    // Stream the device's own ESPHome logs over this same connection (opt-in).
    // Sent before ListEntities so we capture the device-side view from the start.
    // dump_config off — we only want the running log, not the boot config dump.
    if (this.logLevel > 0) {
      this.send('SubscribeLogsRequest', { level: this.logLevel, dumpConfig: false });
      this.logger.info(`Subscribed to device logs at LogLevel ${this.logLevel}`);
    }

    this.send('ListEntitiesRequest', {});
  }


  /**
   * Open the satellite's mic: an announce with startConversation:true is the
   * ONLY client->device mic-open in the native API (VoiceAssistantRequest is
   * device->client). `mediaUrl` should carry a short real clip (the listening
   * chime): the firmware ends an announce promptly only when its media player
   * actually played — with empty media nothing plays and the announce is ended
   * by voice_assistant.cpp's hardcoded 2 s fallback timeout
   * (start_playback_timeout_), delaying the mic-open by ~2.1 s. That firmware
   * timeout is also the graceful fallback whenever the clip can't play (e.g.
   * a mid-conversation PE dropping announce media): worst case is the old
   * slow-but-working behavior.
   *
   * protobufjs field-name gotcha: the camelCase `mediaId` is the real proto
   * field (media_id); a snake_case `media_id` key is silently dropped, which
   * is why the old `media_id: ''` "worked" — proto3 defaults absent strings
   * to '' on the wire.
   */
  send_voice_assistant_request(mediaUrl: string = ''): void {

    this.shouldAnnounceFinished = false;

    this.send('VoiceAssistantAnnounceRequest', {
      startConversation: true,
      mediaId: mediaUrl,
      text: '',
    });

    this.armMicOpenWatchdog();
  }

  /**
   * Ownership signal #2, and the only one that is proof.
   *
   * A mic-open is the one thing we ask of the satellite that it MUST answer:
   * accepted, it comes back as VoiceAssistantAnnounceFinished and then a
   * VoiceAssistantRequest; unplayable media does not change that, because the
   * firmware ends the announce on its own 2 s start_playback_timeout_. Total
   * silence has exactly one cause — check_voice_assistant_api_connection_()
   * threw our announce away because another client owns the voice assistant.
   */
  private armMicOpenWatchdog(): void {
    this.clearMicOpenWatchdog();
    this.micOpenTimer = this.homey.setTimeout(() => {
      this.micOpenTimer = null;
      this.setVaOwner('taken');
    }, this.MIC_OPEN_TIMEOUT);
  }

  private clearMicOpenWatchdog(): void {
    if (this.micOpenTimer) {
      this.homey.clearTimeout(this.micOpenTimer);
      this.micOpenTimer = null;
    }
  }

  /**
   * Record what we now know about the subscription slot, emitting only on a
   * change so a reconnect storm cannot spam the device with warnings. 'ok' is
   * always believed (it comes from the device answering us) and cancels a
   * pending watchdog; the two bad states never overwrite it silently — they
   * log at warn, because this is the failure that looks like nothing is wrong.
   */
  private setVaOwner(state: VaOwnerState): void {
    if (state === 'ok') {
      this.clearMicOpenWatchdog();
    }
    if (this.vaOwner === state) {
      return;
    }
    this.vaOwner = state;

    if (state === 'taken') {
      this.logger.warn('The satellite never answered a microphone open. Another API client (almost certainly Home Assistant) holds its voice assistant — ESPHome allows only one, and everything we send on that path is being discarded.');
    } else if (state === 'suspected') {
      this.logger.warn('The satellite reported no on-board wake words, which is how ESPHome answers a client that does NOT own the voice assistant. If it is still added to Home Assistant, remove it there.');
    } else {
      this.logger.info('Voice assistant subscription confirmed - the device is talking to us.');
    }

    this.emit('voice_assistant_owner', state);
  }

  /** Our claim on the device's voice-assistant slot, or null before any evidence. */
  get voiceAssistantOwner(): VaOwnerState | null {
    return this.vaOwner;
  }

  run_start(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_RUN_START, [], 'RUN_START');
  }

  run_end(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_RUN_END, [], 'RUN_END');
  }

  // The firmware reads `code` and `message` off this event and passes both to
  // its on_error trigger (which is what drives the error chime / red ring).
  // Note it treats the code 'duplicate_wake_up_detected' specially — it goes
  // idle instead of erroring — so never reuse that string for anything else.
  pipeline_error(code: string, message: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_ERROR, [
      { name: 'code', value: code },
      { name: 'message', value: message },
    ], 'ERROR');
  }

  wake_word_end(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_WAKE_WORD_END, [], 'WAKE_WORD_END');
  }

  stt_start(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_START, [], 'STT_START');
  }

  // Carries the transcript. A text-less STT_END is discarded by the firmware
  // ("No text in STT_END event") and its on_stt_end trigger never fires, so an
  // empty transcript is sent as the bare event on purpose — that is exactly
  // what an empty turn means.
  stt_end(text: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_END,
      text ? [{ name: 'text', value: text }] : [], 'STT_END');
  }

  intent_start(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_INTENT_START, [], 'INTENT_START');
  }

  // The streaming reply, one chunk at a time. `chat_log_delta` is the name Home
  // Assistant uses; the firmware ignores it (only `tts_start_streaming` means
  // anything to it) and the event itself is what lets it react early.
  intent_progress(text: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_INTENT_PROGRESS,
      [{ name: 'chat_log_delta', value: text }], 'INTENT_PROGRESS');
  }

  // INTENT_END is the ONLY event the firmware parses `continue_conversation` from:
  // '1' keeps the device's conversation mode alive (it reopens the mic once this
  // reply finishes playing), '0' sends it to IDLE — closing the conversation.
  // Without it the flag keeps its previous value (it is sticky: a
  // startConversation:true announce sets it, and it stays true until overwritten),
  // which made the PE reopen the mic after EVERY in-band reply, goodbye included.
  // Omit the param (undefined) to leave the device's flag untouched. Payload uses
  // the repeated `data` {name,value} field — a spread property like the old {text}
  // is dropped by protobufjs as an unknown field and never transmits.
  intent_end(text: string, continueConversation?: boolean): void {
    const data: { name: string; value: string }[] = [];
    if (text) {
      data.push({ name: 'text', value: text });
    }
    if (continueConversation !== undefined) {
      data.push({ name: 'continue_conversation', value: continueConversation ? '1' : '0' });
    }
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_INTENT_END, data, 'INTENT_END');
  }

  // The firmware DISCARDS a TTS_START without a `text` data entry ("No text in
  // TTS_START event" warning) — the on_tts_start trigger never fires, so the
  // device never enters its "replying" phase (LED ring stays in thinking).
  // Announce-path playback still showed the replying phase only because the
  // firmware's announcement handler fires tts_start_trigger_ by itself; in-band
  // (TTS_END url) replies have no announcement, so they NEED this text.
  tts_start(text?: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_TTS_START,
      text ? [{ name: 'text', value: text }] : [], 'TTS_START');
  }

  // Optionally carries the reply audio URL. In the start_conversation follow-up
  // flow the PE is in "conversation" mode and silently drops a standalone
  // VoiceAssistantAnnounceRequest (acks AnnounceFinished without fetching), so the
  // reply must be delivered in-band on TTS_END as the pipeline's tts_output. The
  // URL goes in the repeated `data` field as {name:'url', value:url}, NOT a spread
  // property (which protobufjs would drop as an unknown field).
  tts_end(url?: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_TTS_END,
      url ? [{ name: 'url', value: url }] : [], 'TTS_END');
  }

  stt_vad_start(): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_VAD_START, [], 'STT_VAD_START');
  }

  // The VAD events carry no payload of their own (the transcript belongs to
  // STT_END); the parameter is always '' today and only travels if something
  // ever passes one.
  stt_vad_end(text: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_STT_VAD_END,
      text ? [{ name: 'text', value: text }] : [], 'STT_VAD_END');
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

  /** Wake words the satellite has on board (empty until the config response). */
  getAvailableWakeWords(): EspWakeWord[] {
    return this.availableWakeWords.map((w) => ({ ...w, trainedLanguages: [...w.trainedLanguages] }));
  }

  /** Currently active wake-word ids. */
  getActiveWakeWords(): string[] {
    return [...this.activeWakeWords];
  }

  /**
   * Activate the given wake words on the satellite (VoiceAssistantSetConfiguration,
   * id 123 — the same call Home Assistant uses). The device persists the choice
   * itself. A configuration re-request follows so our cached state (and the
   * 'wake_words' event) reflects what the device actually applied.
   */
  setActiveWakeWords(ids: string[]): void {
    this.send('VoiceAssistantSetConfiguration', { activeWakeWords: ids });
    this.send('VoiceAssistantConfigurationRequest', {});
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
   * The object_id of one ListEntities*Response entity — as sent, or derived from
   * the entity name when the device omits it.
   *
   * ESPHome 2026.7.0+ NEVER sends object_id (and 2026.1-2026.6 skip it for
   * clients advertising API >= 1.14, which we now do), so every entity lookup
   * here — the mute switch, the volume number, the media player — depends on the
   * derivation in entity-object-id.mts. See that file for the version timeline.
   */
  private resolveObjectId(message: any): string {
    const objectId = resolveEntityObjectId(message);

    if (objectId && !message?.objectId && !this.derivedObjectIdLogged) {
      this.derivedObjectIdLogged = true;
      this.logger.info(`Device omits object_id (ESPHome 2026.7.0+); deriving from entity names, e.g. '${message.name}' -> '${objectId}'`);
    }

    return objectId;
  }

  /**
   * How well a switch's object_id looks like *the microphone mute*, used to
   * pick one when a satellite doesn't follow the PE's `mute` naming.
   *
   *   2 — exactly `mute` (PE, ThirdReality)
   *   1 — mentions both a microphone and mute, in either order
   *       (`microphone_mute` on the ReSpeaker, `mute_mic`, …)
   *   0 — not a mute control
   *
   * Anything that merely contains "mute" scores 0 on purpose: the ReSpeaker's
   * `mute_sound` switch only decides whether the mute chime plays.
   */
  private scoreMuteCandidate(objectId: string): number {
    const id = objectId.toLowerCase();
    if (id === 'mute') return 2;
    if (id.includes('mute') && /(^|_)mic(rophone)?(_|$)/.test(id)) return 1;
    return 0;
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




  /**
   * Send a VoiceAssistantEventResponse.
   *
   * EVERY value must travel in the repeated `data` field as a {name, value}
   * pair: the message has only `event_type` and `data`, so a spread property
   * like `{ text }` is dropped by protobufjs as an unknown field and never
   * reaches the device — silently, since proto3 has no strictness to complain
   * with. That trap swallowed the STT_END transcript and the ERROR code/message
   * for a long time, so this signature takes the data array explicitly and
   * there is no other way to put something on the wire.
   *
   * The names are the ones Home Assistant sends (see the event table in
   * docs/home-assistant-voice-preview-edition/esphome-native-api.md); the
   * firmware looks each one up by name and ignores what it doesn't know.
   */
  vaEvent(type: number, data: VaEventData[], name: string): void {

    const payload = {
      eventType: type,
      ...(data.length > 0 ? { data } : {}),
    };

    this.logger.info(`VoiceAssistantEvent: ${name}`, "TX", payload);

    this.send('VoiceAssistantEventResponse', payload, false);
  }

  send(name: string, payload: any, doLog: boolean = true): void {
    if (doLog) {
      this.logger.info(name, 'TX', payload);
    }
    if (this.noise) {
      if (!this.noise.isReady) {
        // Nothing legitimate is sent before HelloRequest, which is itself held
        // back until the handshake completes — anything landing here is a
        // late/stray call during connection setup.
        this.logger.warn(`Dropping '${name}' — encrypted link not established yet`);
        return;
      }
      const { id, body } = encodeBody(name, payload);
      this.tcp?.write(this.noise.encodeMessage(id, body));
      return;
    }
    this.tcp?.write(encodeFrame(name, payload));
  }

  /**
   * Change the API encryption key for FUTURE connections (undefined/empty =
   * plaintext). Takes effect on the next start(); callers changing the key on
   * a live device should disconnect() + start() to apply it.
   */
  setEncryptionKey(key: string | undefined): void {
    this.encryptionKey = key?.trim() || undefined;
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

export { EspVoiceAssistantClient };
