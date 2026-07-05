// The `discover` console command: browse the LAN for ESPHome satellites the
// same way Homey does (mDNS-SD `_esphomelib._tcp`, see
// .homeycompose/discovery/esphome.json), probe each hit over the native API to
// identify the assistant type ('pe' / 'xiaozhi' — same sniff the pairing flow
// uses), let the user pick which to add, and persist them to settings.json.
import type { Interface as ReadlineInterface } from 'node:readline';
import { EspVoiceAssistantClient } from '../../src/voice_assistant/esp-voice-assistant-client.mjs';
import { config, EmulatorSatellite, getSatellites } from '../config.mjs';
import { browse, MdnsService } from './dns-sd.mjs';
import { saveSatellites } from './settings-store.mjs';

const SERVICE = '_esphomelib._tcp.local';

interface Candidate {
  service: MdnsService;
  name: string;
  mac: string;      // canonical AA:BB:CC:DD:EE:FF
  address: string;
  port: number;
  /** 'pe' | 'xiaozhi' from the probe, or null when the probe couldn't identify it. */
  deviceType: string | null;
  probeError?: string;
}

/** txt.mac is bare lowercase hex; settings.json uses colon-separated uppercase. */
function formatMac(raw: string): string {
  const hex = raw.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length === 12 ? hex.match(/.{2}/g)!.join(':') : raw.toUpperCase();
}

/**
 * Connect once with the ESP client in discovery mode and wait for its
 * 'capabilities' event — the same probe VoiceAssistantDriver runs during
 * pairing, minus the per-driver type filter (the emulator wants to see both
 * PE and XiaoZhi devices in one scan).
 */
function probeDevice(homey: any, address: string, port: number, timeoutMs = 5000):
  Promise<{ deviceType: string | null; voiceCapable: boolean } | { error: string }> {
  return new Promise((resolve) => {
    const client = new EspVoiceAssistantClient(homey, { host: address, apiPort: port, discoveryMode: true });
    let done = false;

    const finish = async (result: Parameters<typeof resolve>[0]) => {
      if (done) return;
      done = true;
      client.removeAllListeners();
      try { await client.disconnect(); } catch { }
      resolve(result);
    };

    client.on('capabilities', (mediaPlayers, subscribeVa, vaConfig, deviceType) => {
      finish({
        deviceType,
        voiceCapable: mediaPlayers > 0 && subscribeVa > 0 && vaConfig > 0,
      });
    });
    client.on('Unhealthy', () => finish({ error: 'connection failed (encrypted API is not supported)' }));

    setTimeout(() => finish({ error: 'probe timed out' }), timeoutMs).unref?.();

    client.start().catch((e: any) => finish({ error: e?.message ?? 'connect error' }));
  });
}

/** rl.question wrapped in a promise. Safe inside the REPL: a pending question swallows the next line. */
function ask(rl: ReadlineInterface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer.trim())));
}

/** Parse "1,3" / "1 3" / "all" against a list length; returns indexes or null on bad input. */
function parseSelection(input: string, count: number): number[] | null {
  if (!input) return [];
  if (input.toLowerCase() === 'all') return Array.from({ length: count }, (_, i) => i);
  const picks = new Set<number>();
  for (const part of input.split(/[\s,]+/).filter(Boolean)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > count) return null;
    picks.add(n - 1);
  }
  return [...picks];
}

/**
 * Run the whole interactive discovery flow. Returns the satellites that were
 * added (already persisted to settings.json) so the caller can boot them live.
 */
export async function runDiscovery(rl: ReadlineInterface, homey: any, scanSeconds: number = 4): Promise<EmulatorSatellite[]> {
  console.log(`\nScanning for ESPHome devices (${SERVICE}, ${scanSeconds}s)...`);
  const found = await browse(SERVICE, scanSeconds * 1000);

  if (found.length === 0) {
    console.log('No ESPHome devices found. Are you on the same LAN as the satellites?');
    return [];
  }

  // Same shape filter as the Homey discovery condition: txt.platform ~ esp32.
  // Devices without a resolvable address can't be probed or added.
  const usable = found.filter((s) => s.address && s.port !== undefined);
  console.log(`Found ${found.length} ESPHome device(s), probing ${usable.length} for voice support...`);

  const candidates: Candidate[] = [];
  for (const service of usable) {
    const name = service.txt.friendly_name || service.instance;
    process.stdout.write(`  probing ${name} @ ${service.address}:${service.port} ... `);
    const probe = await probeDevice(homey, service.address!, service.port!);
    if ('error' in probe) {
      console.log(`✗ ${probe.error}`);
      candidates.push({
        service, name, address: service.address!, port: service.port!,
        mac: formatMac(service.txt.mac ?? ''), deviceType: null, probeError: probe.error,
      });
    } else {
      const type = probe.voiceCapable ? probe.deviceType : null;
      console.log(type ? `✓ voice satellite (${type})` : '✗ not a voice satellite');
      candidates.push({
        service, name, address: service.address!, port: service.port!,
        mac: formatMac(service.txt.mac ?? ''), deviceType: type,
      });
    }
  }

  const addable = candidates.filter((c) => c.deviceType && c.mac.includes(':'));
  const known = getSatellites();
  const isKnown = (c: Candidate) =>
    known.some((s) => s.mac.replace(/[^0-9A-F]/gi, '').toUpperCase() === c.mac.replace(/[^0-9A-F]/gi, '').toUpperCase());

  console.log('\nDiscovered devices:');
  candidates.forEach((c) => {
    const idx = addable.indexOf(c);
    const marker = idx !== -1 ? `[${idx + 1}]` : '[-]';
    const status = c.deviceType
      ? `${c.deviceType}${isKnown(c) ? ', already in settings.json' : ''}`
      : (c.probeError ?? 'not a voice satellite');
    console.log(`  ${marker} ${c.name}  @ ${c.address}:${c.port}  mac ${c.mac || '?'}  — ${status}`);
  });

  if (addable.length === 0) {
    console.log('\nNothing addable (only identified voice satellites with a mac can be added).');
    return [];
  }

  const selection = await ask(rl, `\nAdd which devices? (e.g. 1,3 or all, empty to cancel): `);
  const picks = parseSelection(selection, addable.length);
  if (picks === null) {
    console.log('Invalid selection — cancelled.');
    return [];
  }
  if (picks.length === 0) {
    console.log('Nothing selected.');
    return [];
  }

  // One zone for the whole batch; per-device tweaks are a settings.json edit away.
  const zones = config.zones ?? [];
  let zoneId = zones[0]?.id ?? '';
  if (zones.length > 1) {
    console.log('\nZones:');
    zones.forEach((z, i) => console.log(`  [${i + 1}] ${z.name} (${z.id})`));
    const zoneAnswer = await ask(rl, `Zone for the added device(s)? (1-${zones.length}, default 1): `);
    const zi = zoneAnswer ? Number(zoneAnswer) : 1;
    if (Number.isInteger(zi) && zi >= 1 && zi <= zones.length) {
      zoneId = zones[zi - 1].id;
    } else {
      console.log(`Unrecognized zone — using ${zones[0].name}.`);
    }
  }

  const sats: EmulatorSatellite[] = picks.map((i) => {
    const c = addable[i];
    return {
      name: c.name,
      type: c.deviceType as 'pe' | 'xiaozhi',
      mac: c.mac,
      address: c.address,
      port: c.port,
      zone: zoneId,
    };
  });

  const all = saveSatellites(sats);
  console.log(`\nSaved to settings.json (${all.length} satellite(s) configured).`);
  return sats;
}
