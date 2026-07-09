// Minimal, dependency-free mDNS-SD (RFC 6762/6763) browser for the emulator's
// `discover` command. Browses a service type (e.g. `_esphomelib._tcp.local` —
// the same service the Homey app's mdns-sd discovery strategy watches) and
// returns the advertised instances with their SRV/TXT/A data.
//
// Only what discovery needs is implemented: building one PTR question and
// parsing PTR/SRV/TXT/A answer records (with name compression). The packet
// encode/parse functions are pure so they can be unit-tested without sockets.
import dgram from 'node:dgram';
import os from 'node:os';

export const TYPE_A = 1;
export const TYPE_PTR = 12;
export const TYPE_TXT = 16;
export const TYPE_SRV = 33;

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

export interface DnsRecord {
  name: string;
  type: number;
  /** PTR: target name. SRV: `{ port, target }`. TXT: key/value map. A: dotted IPv4. */
  data: any;
}

export interface MdnsService {
  /** Instance label, e.g. `voice-pe-abc123` (from `<instance>.<service>.<domain>`). */
  instance: string;
  /** SRV target hostname, e.g. `voice-pe-abc123.local`. */
  host?: string;
  address?: string;
  port?: number;
  txt: Record<string, string>;
}

// ---- packet building --------------------------------------------------------

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter((p) => p.length > 0);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const label = Buffer.from(part, 'utf8');
    if (label.length > 63) throw new Error(`DNS label too long: ${part}`);
    chunks.push(Buffer.from([label.length]), label);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/**
 * One-question standard query for `name` (PTR by default). `unicastResponse`
 * sets the QU bit so a responder may reply directly to our (ephemeral) source
 * port — the legacy-resolver path that works without binding port 5353.
 */
export function buildQuery(name: string, type: number = TYPE_PTR, unicastResponse: boolean = false): Buffer {
  const header = Buffer.alloc(12); // id 0, flags 0 (standard query), QDCOUNT 1
  header.writeUInt16BE(1, 4);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(type, 0);
  question.writeUInt16BE(unicastResponse ? 0x8001 : 0x0001, 2); // class IN (+QU)
  return Buffer.concat([header, encodeName(name), question]);
}

// ---- packet parsing ---------------------------------------------------------

/** Decode a (possibly compressed) name at `offset`; returns the name and the offset after it. */
function parseName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let next = -1; // set when we follow the first compression pointer
  let jumps = 0;

  while (true) {
    if (pos >= buf.length) throw new Error('DNS name runs past end of packet');
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      // Compression pointer (2 bytes). The name continues elsewhere; reading
      // resumes after the pointer once the whole name is assembled.
      if (pos + 1 >= buf.length) throw new Error('Truncated DNS compression pointer');
      if (++jumps > 32) throw new Error('DNS compression pointer loop');
      if (next === -1) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if ((len & 0xc0) !== 0) throw new Error(`Unsupported DNS label type 0x${len.toString(16)}`);
    if (pos + 1 + len > buf.length) throw new Error('DNS label runs past end of packet');
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('utf8'));
    pos += 1 + len;
  }

  return { name: labels.join('.'), next: next === -1 ? pos : next };
}

function parseTxt(rdata: Buffer): Record<string, string> {
  const txt: Record<string, string> = {};
  let pos = 0;
  while (pos < rdata.length) {
    const len = rdata[pos];
    const entry = rdata.subarray(pos + 1, pos + 1 + len).toString('utf8');
    pos += 1 + len;
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq === -1) txt[entry] = '';
    else txt[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return txt;
}

/**
 * Parse a DNS response packet into the PTR/SRV/TXT/A records it carries
 * (answers, authority and additionals alike — mDNS responders put the SRV/TXT/A
 * for a PTR answer in the additional section). Other record types are skipped.
 * Malformed packets throw; callers treat that as "ignore this datagram".
 */
export function parseResponse(buf: Buffer): DnsRecord[] {
  if (buf.length < 12) throw new Error('DNS packet too short');
  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6);
  const nscount = buf.readUInt16BE(8);
  const arcount = buf.readUInt16BE(10);

  let pos = 12;

  // Skip questions (name + type/class).
  for (let i = 0; i < qdcount; i++) {
    pos = parseName(buf, pos).next + 4;
  }

  const records: DnsRecord[] = [];
  const total = ancount + nscount + arcount;
  for (let i = 0; i < total; i++) {
    const { name, next } = parseName(buf, pos);
    pos = next;
    if (pos + 10 > buf.length) throw new Error('Truncated DNS record header');
    const type = buf.readUInt16BE(pos);
    const rdlength = buf.readUInt16BE(pos + 8);
    pos += 10;
    if (pos + rdlength > buf.length) throw new Error('Truncated DNS rdata');
    const rdata = buf.subarray(pos, pos + rdlength);

    switch (type) {
      case TYPE_PTR:
        records.push({ name, type, data: parseName(buf, pos).name });
        break;
      case TYPE_SRV: {
        const port = rdata.readUInt16BE(4);
        // The target name may use compression, so parse it in packet context.
        const target = parseName(buf, pos + 6).name;
        records.push({ name, type, data: { port, target } });
        break;
      }
      case TYPE_TXT:
        records.push({ name, type, data: parseTxt(rdata) });
        break;
      case TYPE_A:
        if (rdlength === 4) {
          records.push({ name, type, data: `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}` });
        }
        break;
      default:
        break; // AAAA, NSEC, ... — not needed
    }
    pos += rdlength;
  }
  return records;
}

// ---- collation --------------------------------------------------------------

/**
 * Fold a packet's records into the per-instance service map. `serviceName` is
 * the browsed type (e.g. `_esphomelib._tcp.local`); PTR answers for it create
 * instances, SRV/TXT on the instance name and A on the SRV target fill them in.
 */
export function collate(records: DnsRecord[], serviceName: string, services: Map<string, MdnsService>): void {
  const svcLower = serviceName.toLowerCase();
  const hostAddrs = new Map<string, string>();

  for (const r of records) {
    if (r.type === TYPE_A) hostAddrs.set(r.name.toLowerCase(), r.data);
  }

  const ensure = (fullName: string): MdnsService => {
    const key = fullName.toLowerCase();
    let svc = services.get(key);
    if (!svc) {
      svc = { instance: fullName.slice(0, fullName.length - serviceName.length - 1), txt: {} };
      services.set(key, svc);
    }
    return svc;
  };

  for (const r of records) {
    const nameLower = r.name.toLowerCase();
    if (r.type === TYPE_PTR && nameLower === svcLower) {
      ensure(r.data);
    } else if (nameLower.endsWith(`.${svcLower}`)) {
      const svc = ensure(r.name);
      if (r.type === TYPE_SRV) {
        svc.port = r.data.port;
        svc.host = r.data.target;
      } else if (r.type === TYPE_TXT) {
        svc.txt = { ...svc.txt, ...r.data };
      }
    }
  }

  // Resolve addresses for any instance whose SRV target got an A record.
  for (const svc of services.values()) {
    if (!svc.address && svc.host) {
      const addr = hostAddrs.get(svc.host.toLowerCase());
      if (addr) svc.address = addr;
    }
  }
}

// ---- browsing ---------------------------------------------------------------

/** Non-internal, non-link-local IPv4 addresses, one per candidate LAN interface. */
function listIPv4Addresses(): string[] {
  const addrs: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254.')) {
        addrs.push(info.address);
      }
    }
  }
  return addrs;
}

/**
 * Browse `serviceName` for `durationMs` and return every instance seen.
 *
 * Multicast egress does NOT follow the default route: on a multi-homed machine
 * (VPN adapters, WSL/Hyper-V vEthernets) the OS-default interface is often a
 * virtual one where no satellite lives. So queries are sent per interface:
 * - one ephemeral-port socket per IPv4 interface, `setMulticastInterface`'d to
 *   it, sending legacy (QU) queries — responders unicast the reply straight
 *   back to us, no multicast group needed;
 * - a best-effort socket bound to 5353 + joined to the mDNS group on every
 *   interface, catching responders that only ever answer via multicast.
 *   Binding 5353 can fail when another daemon holds it exclusively; that path
 *   is then silently skipped.
 */
export async function browse(serviceName: string, durationMs: number = 4000): Promise<MdnsService[]> {
  const services = new Map<string, MdnsService>();

  const onMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    let records: DnsRecord[];
    try {
      records = parseResponse(msg);
    } catch {
      return; // unrelated/malformed datagram
    }
    collate(records, serviceName, services);
    // Fallback: a responder that never included an A record still told us its
    // address by *sending* the packet.
    for (const svc of services.values()) {
      if (!svc.address && svc.port !== undefined) svc.address = rinfo.address;
    }
  };

  const legacySockets: dgram.Socket[] = [];
  const allSockets: dgram.Socket[] = [];
  const ifaceAddrs = listIPv4Addresses();

  // Legacy sockets: one ephemeral-port socket per interface, multicast egress
  // pinned to that interface. Fall back to a single OS-default socket when
  // interface enumeration comes up empty.
  const openLegacy = (ifaceAddr?: string) =>
    new Promise<dgram.Socket | null>((resolve) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => resolve(null));
      s.on('message', onMessage);
      s.bind(0, ifaceAddr, () => {
        try {
          if (ifaceAddr) s.setMulticastInterface(ifaceAddr);
          resolve(s);
        } catch {
          try { s.close(); } catch { }
          resolve(null);
        }
      });
    });

  for (const addr of ifaceAddrs.length > 0 ? ifaceAddrs : [undefined]) {
    const s = await openLegacy(addr);
    if (s) legacySockets.push(s);
  }
  allSockets.push(...legacySockets);

  // Multicast socket (best-effort): true mDNS listener on 5353, joined to the
  // group on every interface so multicast-only responders are heard wherever
  // they live.
  const multicast = await new Promise<dgram.Socket | null>((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;
    const fail = () => { if (!settled) { settled = true; try { s.close(); } catch { } resolve(null); } };
    s.on('error', fail);
    s.on('message', onMessage);
    s.bind(MDNS_PORT, () => {
      let joined = 0;
      for (const addr of ifaceAddrs.length > 0 ? ifaceAddrs : [undefined]) {
        try {
          s.addMembership(MDNS_ADDR, addr);
          joined++;
        } catch { }
      }
      if (joined > 0) {
        settled = true;
        resolve(s);
      } else {
        fail();
      }
    });
  });
  if (multicast) allSockets.push(multicast);

  if (allSockets.length === 0) {
    throw new Error('Could not open a UDP socket for mDNS discovery');
  }

  const sendQueries = () => {
    for (const s of allSockets) {
      const qu = legacySockets.includes(s); // QU only makes sense off-port-5353
      const query = buildQuery(serviceName, TYPE_PTR, qu);
      s.send(query, MDNS_PORT, MDNS_ADDR, () => { /* ignore send errors */ });
    }
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  try {
    // Re-ask a couple of times inside the window — mDNS responders answer
    // probabilistically-delayed, and a lost first query shouldn't cost the scan.
    sendQueries();
    const resendAt = [1000, 2500].filter((t) => t < durationMs);
    let elapsed = 0;
    for (const t of resendAt) {
      await sleep(t - elapsed);
      elapsed = t;
      sendQueries();
    }
    await sleep(durationMs - elapsed);
  } finally {
    for (const s of allSockets) {
      try { s.close(); } catch { }
    }
  }

  return [...services.values()];
}
