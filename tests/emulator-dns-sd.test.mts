import { describe, it, expect } from 'vitest';
import {
  buildQuery, parseResponse, collate,
  TYPE_A, TYPE_PTR, TYPE_TXT, TYPE_SRV,
  MdnsService,
} from '../emulator/runtime/dns-sd.mjs';

const SERVICE = '_esphomelib._tcp.local';

/**
 * Incremental DNS packet builder that tracks byte offsets, so the tests can
 * exercise name-compression pointers exactly the way real mDNS responders
 * (ESPHome's esp-idf mdns included) emit them.
 */
class PacketBuilder {
  private chunks: Buffer[] = [];
  private len = 0;
  private rdStack: { buf: Buffer; start: number }[] = [];

  get offset(): number { return this.len; }

  /** Reserve the 2-byte RDLENGTH field; endRdata() patches in the real size. */
  beginRdata(): void {
    const placeholder = Buffer.alloc(2);
    this.push(placeholder);
    this.rdStack.push({ buf: placeholder, start: this.len });
  }

  endRdata(): void {
    const { buf, start } = this.rdStack.pop()!;
    buf.writeUInt16BE(this.len - start);
  }

  push(buf: Buffer): number {
    const at = this.len;
    this.chunks.push(buf);
    this.len += buf.length;
    return at;
  }

  u16(v: number): number { const b = Buffer.alloc(2); b.writeUInt16BE(v); return this.push(b); }
  u32(v: number): number { const b = Buffer.alloc(4); b.writeUInt32BE(v); return this.push(b); }

  /** Write plain labels; returns the offset the name starts at. */
  name(labels: string[]): number {
    const parts: Buffer[] = [];
    for (const l of labels) parts.push(Buffer.from([l.length]), Buffer.from(l, 'utf8'));
    parts.push(Buffer.from([0]));
    return this.push(Buffer.concat(parts));
  }

  /** Write labels terminated by a compression pointer instead of a root byte. */
  nameWithPointer(labels: string[], pointerTo: number): number {
    const parts: Buffer[] = [];
    for (const l of labels) parts.push(Buffer.from([l.length]), Buffer.from(l, 'utf8'));
    parts.push(Buffer.from([0xc0 | (pointerTo >> 8), pointerTo & 0xff]));
    return this.push(Buffer.concat(parts));
  }

  pointer(to: number): number {
    return this.push(Buffer.from([0xc0 | (to >> 8), to & 0xff]));
  }

  build(): Buffer { return Buffer.concat(this.chunks); }
}

/** A realistic one-shot mDNS response: PTR answer + SRV/TXT/A additionals. */
function buildEsphomeResponse(): Buffer {
  const p = new PacketBuilder();

  // Header: response, 0 questions, 1 answer, 0 authority, 3 additional.
  p.u16(0);       // id
  p.u16(0x8400);  // QR=1, AA=1
  p.u16(0); p.u16(1); p.u16(0); p.u16(3);

  // PTR: _esphomelib._tcp.local -> voice-pe._esphomelib._tcp.local
  const serviceNameAt = p.name(['_esphomelib', '_tcp', 'local']);
  p.u16(TYPE_PTR); p.u16(1); p.u32(120);
  p.beginRdata();
  const instanceNameAt = p.offset;
  p.nameWithPointer(['voice-pe'], serviceNameAt);
  p.endRdata();

  // SRV on the instance name (via pointer): port 6053, target voice-pe.local
  p.pointer(instanceNameAt);
  p.u16(TYPE_SRV); p.u16(1); p.u32(120);
  p.beginRdata();
  p.u16(0); p.u16(0); p.u16(6053);
  const targetNameAt = p.name(['voice-pe', 'local']);
  p.endRdata();

  // TXT on the instance name
  const txtEntries = ['mac=aabbccddeeff', 'platform=ESP32', 'friendly_name=Living Room PE'];
  p.pointer(instanceNameAt);
  p.u16(TYPE_TXT); p.u16(1); p.u32(120);
  p.beginRdata();
  for (const e of txtEntries) p.push(Buffer.concat([Buffer.from([e.length]), Buffer.from(e)]));
  p.endRdata();

  // A on the SRV target (via pointer)
  p.pointer(targetNameAt);
  p.u16(TYPE_A); p.u16(1); p.u32(120);
  p.beginRdata();
  p.push(Buffer.from([192, 168, 1, 50]));
  p.endRdata();

  return p.build();
}

describe('dns-sd packet building', () => {
  it('builds a PTR question for the service type', () => {
    const q = buildQuery(SERVICE);
    // Header: standard query with one question.
    expect(q.readUInt16BE(2)).toBe(0);
    expect(q.readUInt16BE(4)).toBe(1);
    // Question name as plain labels.
    expect(q.subarray(12, 24).toString('latin1')).toBe('\x0b_esphomelib');
    // Type PTR, class IN.
    expect(q.readUInt16BE(q.length - 4)).toBe(TYPE_PTR);
    expect(q.readUInt16BE(q.length - 2)).toBe(0x0001);
  });

  it('sets the QU bit when a unicast response is requested', () => {
    const q = buildQuery(SERVICE, TYPE_PTR, true);
    expect(q.readUInt16BE(q.length - 2)).toBe(0x8001);
  });
});

describe('dns-sd response parsing', () => {
  it('parses PTR/SRV/TXT/A records with name compression', () => {
    const records = parseResponse(buildEsphomeResponse());

    const ptr = records.find((r) => r.type === TYPE_PTR)!;
    expect(ptr.name).toBe(SERVICE);
    expect(ptr.data).toBe(`voice-pe.${SERVICE}`);

    const srv = records.find((r) => r.type === TYPE_SRV)!;
    expect(srv.name).toBe(`voice-pe.${SERVICE}`);
    expect(srv.data).toEqual({ port: 6053, target: 'voice-pe.local' });

    const txt = records.find((r) => r.type === TYPE_TXT)!;
    expect(txt.data).toEqual({
      mac: 'aabbccddeeff',
      platform: 'ESP32',
      friendly_name: 'Living Room PE',
    });

    const a = records.find((r) => r.type === TYPE_A)!;
    expect(a.name).toBe('voice-pe.local');
    expect(a.data).toBe('192.168.1.50');
  });

  it('rejects truncated packets instead of misparsing them', () => {
    const full = buildEsphomeResponse();
    expect(() => parseResponse(full.subarray(0, 40))).toThrow();
    expect(() => parseResponse(Buffer.alloc(4))).toThrow();
  });

  it('rejects compression pointer loops', () => {
    const p = new PacketBuilder();
    p.u16(0); p.u16(0x8400); p.u16(0); p.u16(1); p.u16(0); p.u16(0);
    p.pointer(12); // record name points at itself
    expect(() => parseResponse(p.build())).toThrow(/loop/i);
  });
});

describe('dns-sd collation', () => {
  it('folds records into one service instance', () => {
    const services = new Map<string, MdnsService>();
    collate(parseResponse(buildEsphomeResponse()), SERVICE, services);

    expect(services.size).toBe(1);
    const svc = [...services.values()][0];
    expect(svc.instance).toBe('voice-pe');
    expect(svc.host).toBe('voice-pe.local');
    expect(svc.address).toBe('192.168.1.50');
    expect(svc.port).toBe(6053);
    expect(svc.txt.mac).toBe('aabbccddeeff');
  });

  it('merges records arriving across multiple packets', () => {
    const full = parseResponse(buildEsphomeResponse());
    const services = new Map<string, MdnsService>();
    // First packet: PTR only. Second: the rest.
    collate(full.filter((r) => r.type === TYPE_PTR), SERVICE, services);
    expect([...services.values()][0].port).toBeUndefined();
    collate(full.filter((r) => r.type !== TYPE_PTR), SERVICE, services);
    const svc = [...services.values()][0];
    expect(svc.port).toBe(6053);
    expect(svc.address).toBe('192.168.1.50');
  });

  it('ignores records for other services', () => {
    const services = new Map<string, MdnsService>();
    collate(parseResponse(buildEsphomeResponse()), '_googlecast._tcp.local', services);
    expect(services.size).toBe(0);
  });
});
