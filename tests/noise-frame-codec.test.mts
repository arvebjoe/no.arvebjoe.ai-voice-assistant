// NoiseFrameCodec — the ESPHome Noise_NNpsk0_25519_ChaChaPoly_SHA256 transport.
// The responder role ships in the same module (role-aware NoiseHandshakeState),
// so a full loopback handshake + traffic runs here with no network, mirroring
// how improv-ble-client is tested against fakes. Negative paths cover the whole
// error taxonomy from docs/esphome-noise-encryption.md §6.4.
import { describe, it, expect } from 'vitest';
import {
  NoiseFrameCodec,
  NoiseHandshakeState,
  CipherState,
  encodeNoiseFrame,
  NoiseEvent,
} from '../src/voice_assistant/noise-frame-codec.mjs';
import { EspVoiceAssistantClient } from '../src/voice_assistant/esp-voice-assistant-client.mjs';
import { decodeBody } from '../src/voice_assistant/esp-messages.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

const EMPTY = Buffer.alloc(0);
// Deterministic 32-byte PSK (any base64 string decoding to 32 bytes works).
const PSK = Buffer.alloc(32, 7).toString('base64');
const WRONG_PSK = Buffer.alloc(32, 9).toString('base64');

/** Split a raw byte stream into outer-frame payloads ([0x01][u16 BE len] each). */
function parseFrames(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let off = 0;
  while (off < buf.length) {
    expect(buf[off]).toBe(0x01);
    const len = buf.readUInt16BE(off + 1);
    frames.push(buf.subarray(off + 3, off + 3 + len));
    off += 3 + len;
  }
  return frames;
}

/**
 * The ESPHome-firmware side of the handshake, driven by the exported
 * responder-role primitives. Consumes the codec's startHandshake() bytes and
 * produces the server hello + message 2 frames plus the transport ciphers.
 */
class FakeNoiseServer {
  readonly handshake: NoiseHandshakeState;
  /** Decrypts client→server traffic (initiator TX cipher). */
  rx!: CipherState;
  /** Encrypts server→client traffic (responder TX cipher). */
  tx!: CipherState;

  constructor(psk: string = PSK) {
    this.handshake = new NoiseHandshakeState(Buffer.from(psk, 'base64'), 'responder');
  }

  /** Returns [serverHelloFrame, message2Frame] for the given client bytes. */
  accept(clientBytes: Buffer, { name = 'test-device', mac = 'AA:BB:CC:DD:EE:FF' as string | null } = {}): Buffer[] {
    const frames = parseFrames(clientBytes);
    expect(frames[0].length).toBe(0);          // empty client hello
    expect(frames[1][0]).toBe(0x00);           // handshake-proceed prefix
    expect(frames[1].length).toBe(49);         // 1 + 32-byte e + 16-byte tag
    this.handshake.readMessage1(frames[1].subarray(1));

    const identity = mac === null ? `${name}\0` : `${name}\0${mac}\0`;
    const serverHello = encodeNoiseFrame(Buffer.concat([Buffer.from([0x01]), Buffer.from(identity, 'utf8')]));
    const message2 = encodeNoiseFrame(Buffer.concat([Buffer.from([0x00]), this.handshake.writeMessage2()]));
    const [initiatorTx, responderTx] = this.handshake.split();
    this.rx = initiatorTx;
    this.tx = responderTx;
    return [serverHello, message2];
  }

  /** Encrypt one API message the way the firmware frames it. */
  sendMessage(type: number, payload: Buffer): Buffer {
    const inner = Buffer.alloc(4 + payload.length);
    inner.writeUInt16BE(type, 0);
    inner.writeUInt16BE(payload.length, 2);
    payload.copy(inner, 4);
    return encodeNoiseFrame(this.tx.encryptWithAd(EMPTY, inner));
  }
}

function readyCodec(options: { expectedMac?: string } = {}): { codec: NoiseFrameCodec; server: FakeNoiseServer } {
  const codec = new NoiseFrameCodec({ psk: PSK, ...options });
  const server = new FakeNoiseServer();
  const [serverHello, message2] = server.accept(codec.startHandshake());
  const events = codec.feed(Buffer.concat([serverHello, message2]));
  expect(events).toEqual([{ kind: 'ready', serverName: 'test-device', serverMac: 'AA:BB:CC:DD:EE:FF' }]);
  return { codec, server };
}

describe('handshake', () => {
  it('completes the full NNpsk0 handshake and reports the server identity', () => {
    const { codec } = readyCodec();
    expect(codec.isReady).toBe(true);
    expect(codec.serverName).toBe('test-device');
    expect(codec.serverMac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('accepts a matching expectedMac in any format', () => {
    const { codec } = readyCodec({ expectedMac: 'aabbccddeeff' });
    expect(codec.isReady).toBe(true);
  });

  it('handles an old-firmware server hello without a MAC', () => {
    const codec = new NoiseFrameCodec({ psk: PSK, expectedMac: 'aabbccddeeff' });
    const server = new FakeNoiseServer();
    const [serverHello, message2] = server.accept(codec.startHandshake(), { mac: null });
    const events = codec.feed(Buffer.concat([serverHello, message2]));
    // No MAC announced → the check is skipped, not failed.
    expect(events).toEqual([{ kind: 'ready', serverName: 'test-device', serverMac: '' }]);
  });

  it('survives arbitrary TCP chunking (byte-by-byte delivery)', () => {
    const codec = new NoiseFrameCodec({ psk: PSK });
    const server = new FakeNoiseServer();
    const bytes = Buffer.concat(server.accept(codec.startHandshake()));
    const events: NoiseEvent[] = [];
    for (const b of bytes) {
      events.push(...codec.feed(Buffer.from([b])));
    }
    expect(events.map((e) => e.kind)).toEqual(['ready']);
  });
});

describe('transport', () => {
  it('round-trips messages in both directions with advancing nonces', () => {
    const { codec, server } = readyCodec();

    // client → server, twice (nonce 0 then 1)
    for (const n of [0, 1]) {
      const payload = Buffer.from(`hello-${n}`);
      const [framePayload] = parseFrames(codec.encodeMessage(90 + n, payload));
      const inner = server.rx.decryptWithAd(EMPTY, framePayload);
      expect(inner.readUInt16BE(0)).toBe(90 + n);
      expect(inner.readUInt16BE(2)).toBe(payload.length);
      expect(inner.subarray(4)).toEqual(payload);
    }

    // server → client, twice
    for (const n of [0, 1]) {
      const events = codec.feed(server.sendMessage(7, Buffer.from([n])));
      expect(events).toEqual([{ kind: 'message', type: 7, payload: Buffer.from([n]) }]);
    }
  });

  it('trusts the decrypted buffer size over the inner length field', () => {
    const { codec, server } = readyCodec();
    // Lie in the inner length field (says 1, actual 3).
    const inner = Buffer.concat([Buffer.from([0, 42, 0, 1]), Buffer.from('abc')]);
    const frame = encodeNoiseFrame(server.tx.encryptWithAd(EMPTY, inner));
    const events = codec.feed(frame);
    expect(events).toEqual([{ kind: 'message', type: 42, payload: Buffer.from('abc') }]);
  });

  it('refuses to encode before the handshake completes', () => {
    const codec = new NoiseFrameCodec({ psk: PSK });
    codec.startHandshake();
    expect(() => codec.encodeMessage(1, EMPTY)).toThrow(/handshake not complete/);
  });
});

describe('error taxonomy', () => {
  it('wrong PSK: the responder rejects handshake message 1 (server-side view)', () => {
    const codec = new NoiseFrameCodec({ psk: PSK });
    const server = new FakeNoiseServer(WRONG_PSK);
    // ESPHome fails exactly here, then sends the "Handshake MAC failure" frame.
    expect(() => server.accept(codec.startHandshake())).toThrow();
  });

  it("wrong PSK: the server's 'Handshake MAC failure' frame maps to wrong_psk", () => {
    const codec = new NoiseFrameCodec({ psk: PSK });
    codec.startHandshake();
    const serverHello = encodeNoiseFrame(Buffer.concat([Buffer.from([0x01]), Buffer.from('dev\0', 'utf8')]));
    const failure = encodeNoiseFrame(Buffer.concat([Buffer.from([0x01]), Buffer.from('Handshake MAC failure', 'utf8')]));
    const events = codec.feed(Buffer.concat([serverHello, failure]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'error', code: 'wrong_psk' });
  });

  it('wrong PSK: a tampered handshake message 2 fails locally as wrong_psk', () => {
    const codec = new NoiseFrameCodec({ psk: PSK });
    const server = new FakeNoiseServer();
    const [serverHello, message2] = server.accept(codec.startHandshake());
    message2[message2.length - 1] ^= 0xff; // corrupt the tag
    const events = codec.feed(Buffer.concat([serverHello, message2]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'error', code: 'wrong_psk' });
  });

  it('plaintext indicator from the peer maps to plaintext_server', () => {
    const codec = new NoiseFrameCodec({ psk: PSK });
    codec.startHandshake();
    const events = codec.feed(Buffer.from([0x00, 0x0a, 0x01]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'error', code: 'plaintext_server' });
  });

  it('a different device answering maps to mac_mismatch', () => {
    const codec = new NoiseFrameCodec({ psk: PSK, expectedMac: '11:22:33:44:55:66' });
    const server = new FakeNoiseServer();
    const [serverHello, message2] = server.accept(codec.startHandshake());
    const events = codec.feed(Buffer.concat([serverHello, message2]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'error', code: 'mac_mismatch' });
  });

  it('a tampered transport frame maps to protocol_error', () => {
    const { codec, server } = readyCodec();
    const frame = server.sendMessage(7, Buffer.from('x'));
    frame[frame.length - 1] ^= 0xff;
    const events = codec.feed(frame);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'error', code: 'protocol_error' });
  });

  it('is dead after an error — further feeds return nothing', () => {
    const codec = new NoiseFrameCodec({ psk: PSK });
    codec.startHandshake();
    codec.feed(Buffer.from([0x00, 0x00, 0x00]));
    const { server } = readyCodec();
    expect(codec.feed(server.sendMessage(1, EMPTY))).toEqual([]);
  });
});

describe('PSK validation', () => {
  it('accepts a 32-byte base64 key, with or without surrounding whitespace', () => {
    expect(NoiseFrameCodec.decodePsk(PSK)).toEqual(Buffer.alloc(32, 7));
    expect(NoiseFrameCodec.decodePsk(`  ${PSK}\n`)).toEqual(Buffer.alloc(32, 7));
  });

  it('rejects wrong lengths, invalid characters and empty strings', () => {
    expect(NoiseFrameCodec.decodePsk(Buffer.alloc(31, 1).toString('base64'))).toBeNull();
    expect(NoiseFrameCodec.decodePsk(Buffer.alloc(33, 1).toString('base64'))).toBeNull();
    expect(NoiseFrameCodec.decodePsk('not-valid-base64!!')).toBeNull();
    expect(NoiseFrameCodec.decodePsk('')).toBeNull();
  });

  it('the codec constructor throws on a malformed key', () => {
    expect(() => new NoiseFrameCodec({ psk: 'tooshort' })).toThrow(/32 bytes/);
  });
});

describe('EspVoiceAssistantClient seam', () => {
  function makeClient(options: Record<string, any> = {}): { client: EspVoiceAssistantClient; written: Buffer[] } {
    const client = new EspVoiceAssistantClient(new MockHomey(), {
      host: '127.0.0.1',
      discoveryMode: true, // one-shot: no reconnect scheduling in tests
      logLevel: 0,
      ...options,
    });
    const written: Buffer[] = [];
    (client as any).tcp = {
      write: (b: Buffer) => written.push(b),
      removeAllListeners: () => { },
      destroy: () => { },
    };
    return { client, written };
  }

  it('emits requires_encryption when a plaintext connect is answered with the Noise indicator', async () => {
    const { client } = makeClient();
    let fired = false;
    client.on('requires_encryption', () => { fired = true; });
    await (client as any).onTcpData(Buffer.from([0x01, 0x00, 0x2a]));
    expect(fired).toBe(true);
  });

  it('runs the Noise handshake and sends HelloRequest encrypted once ready', async () => {
    const { client, written } = makeClient({ encryptionKey: PSK });
    const codec = new NoiseFrameCodec({ psk: PSK });
    (client as any).noise = codec;
    (client as any).tcp.write(codec.startHandshake());

    const server = new FakeNoiseServer();
    const [serverHello, message2] = server.accept(written.shift()!);
    await (client as any).onTcpData(Buffer.concat([serverHello, message2]));

    // The deferred HelloRequest must have gone out, encrypted.
    expect(written).toHaveLength(1);
    const [framePayload] = parseFrames(written[0]);
    const inner = server.rx.decryptWithAd(EMPTY, framePayload);
    const decoded = decodeBody(inner.readUInt16BE(0), inner.subarray(4));
    expect(decoded.name).toBe('HelloRequest');
    expect(decoded.message.clientInfo).toBe('ai-voice-assistant');
  });

  it('surfaces a wrong key as encryption_error(wrong_key)', async () => {
    const { client } = makeClient({ encryptionKey: PSK });
    const codec = new NoiseFrameCodec({ psk: PSK });
    (client as any).noise = codec;
    codec.startHandshake();

    const errors: Array<[string, string]> = [];
    client.on('encryption_error', (code, message) => errors.push([code, message]));

    const serverHello = encodeNoiseFrame(Buffer.concat([Buffer.from([0x01]), Buffer.from('dev\0', 'utf8')]));
    const failure = encodeNoiseFrame(Buffer.concat([Buffer.from([0x01]), Buffer.from('Handshake MAC failure', 'utf8')]));
    await (client as any).onTcpData(Buffer.concat([serverHello, failure]));

    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('wrong_key');
  });
});
