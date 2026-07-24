import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  KeyObject,
} from 'node:crypto';

/*
 * Noise encryption for the ESPHome native API:
 * Noise_NNpsk0_25519_ChaChaPoly_SHA256 over the 3-byte-header frame format.
 *
 * Self-contained (no Homey imports) so it is unit-testable the same way
 * improv-ble-client is. Wire format and error taxonomy follow aioesphomeapi's
 * _frame_helper/noise.py; the Noise state machine is a port of the approach in
 * hjdhjd/esphome-client's crypto-noise.ts (ISC license) — Node built-ins only,
 * no external crypto dependencies. See docs/esphome-noise-encryption.md.
 */

const PROTOCOL_NAME = 'Noise_NNpsk0_25519_ChaChaPoly_SHA256';
// "NoiseAPIInit" + 0x00 0x00 — fixed prologue every ESPHome peer mixes in.
const PROLOGUE = Buffer.concat([Buffer.from('NoiseAPIInit', 'ascii'), Buffer.from([0x00, 0x00])]);
const EMPTY = Buffer.alloc(0);

// Outer-frame indicator bytes. A Noise server only ever speaks 0x01; a 0x00
// from the peer means it is running the plaintext protocol.
const INDICATOR_PLAINTEXT = 0x00;
const INDICATOR_NOISE = 0x01;

// Handshake-frame status prefix (first byte inside the frame payload).
const HANDSHAKE_OK = 0x00;
const HANDSHAKE_FAILURE = 0x01;

// The exact failure text ESPHome sends when the PSK is wrong (Poly1305 tag
// mismatch on our handshake message). Must map to wrong_psk, not a generic error.
const MAC_FAILURE_TEXT = 'Handshake MAC failure';

// SPKI DER prefix that turns a raw 32-byte X25519 public key into something
// node:crypto's createPublicKey can import.
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export type NoiseErrorCode =
  | 'wrong_psk'          // PSK rejected (server MAC-failure text, or local tag failure on msg 2)
  | 'plaintext_server'   // peer answered with the plaintext indicator — no key set on the device
  | 'mac_mismatch'       // server hello MAC does not match the expected device
  | 'protocol_error';    // anything else (malformed frames, tampered ciphertext, …)

export type NoiseEvent =
  | { kind: 'ready'; serverName: string; serverMac: string }
  | { kind: 'message'; type: number; payload: Buffer }
  | { kind: 'error'; code: NoiseErrorCode; message: string };

export interface NoiseFrameCodecOptions {
  /** The device's API encryption key: base64, decoding to exactly 32 bytes. */
  psk: string;
  /**
   * When set, the MAC the server announces in its hello frame is checked
   * against this (any format; normalized to colon-free lowercase). Older
   * firmware omits the MAC — the check only runs when the server sent one.
   */
  expectedMac?: string;
}

/** Normalize a MAC to the colon-free lowercase form mDNS txt.mac uses. */
function normalizeMac(mac: string): string {
  return mac.replace(/[:\-\s]/g, '').toLowerCase();
}

function sha256(...chunks: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const c of chunks) h.update(c);
  return h.digest();
}

/** RFC 5869 HKDF-SHA256 as Noise defines it: chaining key as salt, empty info. */
function hkdf(chainingKey: Buffer, ikm: Buffer, length: 64 | 96): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, chainingKey, EMPTY, length));
}

function rawToPublicKey(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function publicKeyToRaw(key: KeyObject): Buffer {
  // The raw 32-byte X25519 key is the tail of the SPKI DER export.
  return (key.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
}

/**
 * One direction of ChaCha20-Poly1305 with the Noise nonce scheme:
 * 12 bytes = 4 zero bytes + 64-bit little-endian counter, +1 per operation.
 */
export class CipherState {
  private k: Buffer | null = null;
  private n = 0n;

  initializeKey(key: Buffer | null): void {
    this.k = key;
    this.n = 0n;
  }

  hasKey(): boolean {
    return this.k !== null;
  }

  private nonce(): Buffer {
    // 2^64-1 is reserved by the Noise spec; a voice session never gets close.
    if (this.n === 0xffffffffffffffffn) {
      throw new Error('nonce exhausted');
    }
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(this.n, 4);
    return nonce;
  }

  encryptWithAd(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.k) {
      return plaintext;
    }
    const cipher = createCipheriv('chacha20-poly1305', this.k, this.nonce(), { authTagLength: 16 });
    cipher.setAAD(ad, { plaintextLength: plaintext.length });
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    this.n++;
    return Buffer.concat([ct, cipher.getAuthTag()]);
  }

  /** Throws on authentication failure (bad tag = wrong key or tampering). */
  decryptWithAd(ad: Buffer, data: Buffer): Buffer {
    if (!this.k) {
      return data;
    }
    if (data.length < 16) {
      throw new Error('ciphertext shorter than the auth tag');
    }
    const ct = data.subarray(0, data.length - 16);
    const tag = data.subarray(data.length - 16);
    const decipher = createDecipheriv('chacha20-poly1305', this.k, this.nonce(), { authTagLength: 16 });
    decipher.setAAD(ad, { plaintextLength: ct.length });
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    this.n++;
    return pt;
  }
}

/** Noise SymmetricState: transcript hash h, chaining key ck, handshake cipher. */
class SymmetricState {
  h: Buffer;
  private ck: Buffer;
  readonly cipher = new CipherState();

  constructor() {
    // Protocol name is longer than 32 bytes, so h starts as its SHA-256.
    this.h = sha256(Buffer.from(PROTOCOL_NAME, 'ascii'));
    this.ck = this.h;
  }

  mixHash(data: Buffer): void {
    this.h = sha256(this.h, data);
  }

  mixKey(ikm: Buffer): void {
    const out = hkdf(this.ck, ikm, 64);
    this.ck = out.subarray(0, 32);
    this.cipher.initializeKey(out.subarray(32, 64));
  }

  /** The psk-specific operation: 3 HKDF outputs, the middle one hashed in. */
  mixKeyAndHash(ikm: Buffer): void {
    const out = hkdf(this.ck, ikm, 96);
    this.ck = out.subarray(0, 32);
    this.mixHash(out.subarray(32, 64));
    this.cipher.initializeKey(out.subarray(64, 96));
  }

  encryptAndHash(plaintext: Buffer): Buffer {
    const ct = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Buffer): Buffer {
    const pt = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  /** Handshake done: derive the two transport ciphers (initiator TX first). */
  split(): [CipherState, CipherState] {
    const out = hkdf(this.ck, EMPTY, 64);
    const c1 = new CipherState();
    c1.initializeKey(out.subarray(0, 32));
    const c2 = new CipherState();
    c2.initializeKey(out.subarray(32, 64));
    return [c1, c2];
  }
}

/**
 * HandshakeState for the fixed NNpsk0 pattern:
 *   -> psk, e
 *   <- e, ee
 * Role-aware so tests can run the responder side against the codec with the
 * same primitives (ESPHome firmware is the responder in production).
 */
export class NoiseHandshakeState {
  private readonly symmetric = new SymmetricState();
  private readonly psk: Buffer;
  private ephemeralPrivate: KeyObject | null = null;
  private ephemeralPublicRaw: Buffer | null = null;
  private remoteEphemeralRaw: Buffer | null = null;

  constructor(psk: Buffer, private readonly role: 'initiator' | 'responder') {
    if (psk.length !== 32) {
      throw new Error(`PSK must be 32 bytes, got ${psk.length}`);
    }
    this.psk = psk;
    this.symmetric.mixHash(PROLOGUE);
  }

  private generateEphemeral(): Buffer {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    this.ephemeralPrivate = privateKey;
    this.ephemeralPublicRaw = publicKeyToRaw(publicKey);
    return this.ephemeralPublicRaw;
  }

  private dhWithRemote(): Buffer {
    return diffieHellman({
      privateKey: this.ephemeralPrivate!,
      publicKey: rawToPublicKey(this.remoteEphemeralRaw!),
    });
  }

  /** Initiator: build handshake message 1 (psk, e + empty encrypted payload). */
  writeMessage1(): Buffer {
    if (this.role !== 'initiator') throw new Error('writeMessage1 is the initiator side');
    this.symmetric.mixKeyAndHash(this.psk);
    const e = this.generateEphemeral();
    this.symmetric.mixHash(e);
    // psk modes also mix the ephemeral into the key (Noise spec §9.1).
    this.symmetric.mixKey(e);
    const tag = this.symmetric.encryptAndHash(EMPTY);
    return Buffer.concat([e, tag]);
  }

  /** Responder (tests): consume message 1. Throws on a wrong PSK (tag failure). */
  readMessage1(message: Buffer): void {
    if (this.role !== 'responder') throw new Error('readMessage1 is the responder side');
    if (message.length < 48) throw new Error('handshake message 1 too short');
    this.symmetric.mixKeyAndHash(this.psk);
    this.remoteEphemeralRaw = Buffer.from(message.subarray(0, 32));
    this.symmetric.mixHash(this.remoteEphemeralRaw);
    this.symmetric.mixKey(this.remoteEphemeralRaw);
    this.symmetric.decryptAndHash(message.subarray(32));
  }

  /** Responder (tests): build handshake message 2 (e, ee). */
  writeMessage2(): Buffer {
    if (this.role !== 'responder') throw new Error('writeMessage2 is the responder side');
    const e = this.generateEphemeral();
    this.symmetric.mixHash(e);
    this.symmetric.mixKey(e);
    this.symmetric.mixKey(this.dhWithRemote());
    const tag = this.symmetric.encryptAndHash(EMPTY);
    return Buffer.concat([e, tag]);
  }

  /** Initiator: consume message 2. Throws on tag failure (wrong PSK / tamper). */
  readMessage2(message: Buffer): void {
    if (this.role !== 'initiator') throw new Error('readMessage2 is the initiator side');
    if (message.length < 48) throw new Error('handshake message 2 too short');
    this.remoteEphemeralRaw = Buffer.from(message.subarray(0, 32));
    this.symmetric.mixHash(this.remoteEphemeralRaw);
    this.symmetric.mixKey(this.remoteEphemeralRaw);
    this.symmetric.mixKey(this.dhWithRemote());
    this.symmetric.decryptAndHash(message.subarray(32));
  }

  /** [initiatorTx, responderTx] transport ciphers. */
  split(): [CipherState, CipherState] {
    return this.symmetric.split();
  }
}

/** Wrap a payload in the outer Noise frame: [0x01][u16 BE length][payload]. */
export function encodeNoiseFrame(payload: Buffer): Buffer {
  if (payload.length > 0xffff) {
    throw new Error(`frame payload too large: ${payload.length}`);
  }
  const header = Buffer.from([INDICATOR_NOISE, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

/**
 * Stateful codec for one encrypted connection: startHandshake() produces the
 * bytes to write on connect, feed() consumes socket data and yields events,
 * encodeMessage() frames outgoing API messages once ready. One instance per
 * TCP connection — reconnects need a fresh codec (fresh ephemeral keys).
 */
export class NoiseFrameCodec {
  private readonly handshake: NoiseHandshakeState;
  private readonly expectedMac: string | null;
  private pending: Buffer = Buffer.alloc(0);
  private state: 'idle' | 'server_hello' | 'handshake' | 'ready' | 'failed' = 'idle';
  private txCipher: CipherState | null = null;
  private rxCipher: CipherState | null = null;
  private name = '';
  private mac = '';

  constructor(options: NoiseFrameCodecOptions) {
    const psk = NoiseFrameCodec.decodePsk(options.psk);
    if (!psk) {
      throw new Error('invalid API encryption key: expected base64 decoding to exactly 32 bytes');
    }
    this.handshake = new NoiseHandshakeState(psk, 'initiator');
    this.expectedMac = options.expectedMac ? normalizeMac(options.expectedMac) : null;
  }

  /**
   * Strictly decode a PSK string; null when it is not base64 for exactly
   * 32 bytes. (Buffer.from(str, 'base64') alone is too lenient — it silently
   * ignores invalid characters.)
   */
  static decodePsk(psk: string): Buffer | null {
    const compact = (psk ?? '').replace(/\s+/g, '');
    if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
      return null;
    }
    const decoded = Buffer.from(compact, 'base64');
    return decoded.length === 32 ? decoded : null;
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  /** Device name announced in the server hello (empty until then). */
  get serverName(): string {
    return this.name;
  }

  /** MAC announced in the server hello (empty on older firmware). */
  get serverMac(): string {
    return this.mac;
  }

  /**
   * The combined client hello + handshake message 1, written as one buffer the
   * moment the TCP connection is up (same trick aioesphomeapi uses to save a
   * round trip).
   */
  startHandshake(): Buffer {
    if (this.state !== 'idle') {
      throw new Error('handshake already started');
    }
    this.state = 'server_hello';
    const clientHello = Buffer.from([INDICATOR_NOISE, 0x00, 0x00]);
    const message1 = encodeNoiseFrame(Buffer.concat([Buffer.from([HANDSHAKE_OK]), this.handshake.writeMessage1()]));
    return Buffer.concat([clientHello, message1]);
  }

  /** Encrypt + frame one API message. Only valid once the handshake is done. */
  encodeMessage(type: number, payload: Buffer): Buffer {
    if (this.state !== 'ready' || !this.txCipher) {
      throw new Error('handshake not complete');
    }
    const inner = Buffer.alloc(4 + payload.length);
    inner.writeUInt16BE(type, 0);
    inner.writeUInt16BE(payload.length, 2);
    payload.copy(inner, 4);
    return encodeNoiseFrame(this.txCipher.encryptWithAd(EMPTY, inner));
  }

  /**
   * Consume raw socket bytes. Returns the events they produced; after an
   * 'error' event the codec is dead and further data is ignored (the caller
   * drops the connection).
   */
  feed(data: Buffer): NoiseEvent[] {
    if (this.state === 'failed') {
      return [];
    }
    this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : data;

    const events: NoiseEvent[] = [];
    while (true) {
      if (this.pending.length < 3) {
        break;
      }
      const indicator = this.pending[0];
      if (indicator !== INDICATOR_NOISE) {
        events.push(this.fail(
          indicator === INDICATOR_PLAINTEXT && this.state !== 'ready' ? 'plaintext_server' : 'protocol_error',
          indicator === INDICATOR_PLAINTEXT
            ? 'peer answered in plaintext — the device has no encryption key set'
            : `unexpected frame indicator 0x${indicator.toString(16).padStart(2, '0')}`,
        ));
        break;
      }
      const length = this.pending.readUInt16BE(1);
      if (this.pending.length < 3 + length) {
        break;
      }
      const payload = this.pending.subarray(3, 3 + length);
      this.pending = this.pending.subarray(3 + length);
      const produced = this.handleFrame(payload);
      events.push(...produced);
      if (produced.some((ev) => ev.kind === 'error')) {
        break;
      }
    }
    return events;
  }

  private handleFrame(payload: Buffer): NoiseEvent[] {
    switch (this.state) {
      case 'server_hello':
        return this.handleServerHello(payload);
      case 'handshake':
        return this.handleHandshakeFrame(payload);
      case 'ready':
        return this.handleTransportFrame(payload);
      default:
        return [this.fail('protocol_error', `frame received in unexpected state '${this.state}'`)];
    }
  }

  private handleServerHello(payload: Buffer): NoiseEvent[] {
    if (payload.length < 1 || payload[0] !== INDICATOR_NOISE) {
      return [this.fail('protocol_error', 'server hello did not choose the Noise protocol')];
    }
    // [0x01][server_name NUL][mac NUL] — MAC only on newer firmware.
    const fields: string[] = [];
    let start = 1;
    for (let i = 1; i < payload.length && fields.length < 2; i++) {
      if (payload[i] === 0x00) {
        fields.push(payload.subarray(start, i).toString('utf8'));
        start = i + 1;
      }
    }
    this.name = fields[0] ?? payload.subarray(1).toString('utf8');
    this.mac = fields[1] ?? '';

    if (this.expectedMac && this.mac && normalizeMac(this.mac) !== this.expectedMac) {
      return [this.fail('mac_mismatch', `expected device ${this.expectedMac} but reached ${this.mac} (${this.name})`)];
    }
    this.state = 'handshake';
    return [];
  }

  private handleHandshakeFrame(payload: Buffer): NoiseEvent[] {
    if (payload.length < 1) {
      return [this.fail('protocol_error', 'empty handshake frame')];
    }
    if (payload[0] === HANDSHAKE_FAILURE) {
      const text = payload.subarray(1).toString('utf8');
      // The canonical wrong-key signal: our message-1 tag failed on the server.
      return [this.fail(
        text === MAC_FAILURE_TEXT ? 'wrong_psk' : 'protocol_error',
        text || 'handshake rejected by device',
      )];
    }
    if (payload[0] !== HANDSHAKE_OK) {
      return [this.fail('protocol_error', `unknown handshake status 0x${payload[0].toString(16)}`)];
    }
    try {
      this.handshake.readMessage2(payload.subarray(1));
    } catch {
      // Local tag failure on message 2 — the PSK does not match.
      return [this.fail('wrong_psk', 'handshake message failed to authenticate (wrong encryption key?)')];
    }
    const [initiatorTx, responderTx] = this.handshake.split();
    this.txCipher = initiatorTx;
    this.rxCipher = responderTx;
    this.state = 'ready';
    return [{ kind: 'ready', serverName: this.name, serverMac: this.mac }];
  }

  private handleTransportFrame(payload: Buffer): NoiseEvent[] {
    let inner: Buffer;
    try {
      inner = this.rxCipher!.decryptWithAd(EMPTY, payload);
    } catch {
      return [this.fail('protocol_error', 'failed to decrypt frame (tampered or out of order)')];
    }
    if (inner.length < 4) {
      return [this.fail('protocol_error', 'decrypted frame shorter than its header')];
    }
    const type = inner.readUInt16BE(0);
    // The inner length field is deliberately ignored — like aioesphomeapi, we
    // do not trust the remote end to send the correct length; the decrypted
    // buffer's size is authoritative.
    return [{ kind: 'message', type, payload: inner.subarray(4) }];
  }

  private fail(code: NoiseErrorCode, message: string): NoiseEvent {
    this.state = 'failed';
    return { kind: 'error', code, message };
  }
}
