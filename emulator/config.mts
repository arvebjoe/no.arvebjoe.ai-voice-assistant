// Loads the emulator configuration (settings.json) once, synchronously, at
// module evaluation. Both the fake Homey context and the fake device world
// read from this. Override the path with HE_SETTINGS=<path>.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export interface EmulatorZone {
  id: string;
  name: string;
  parent?: string | null;
}

export interface EmulatorDevice {
  id: string;
  name: string;
  zone: string;
  class: string;
  virtualClass?: string;
  /** Map of capabilityId -> initial value, e.g. { onoff: true, dim: 0.5 } */
  capabilities: Record<string, any>;
  /** Override the device's data.id (defaults to `id`). */
  dataId?: string;
}

export interface EmulatorPe {
  name: string;
  mac: string;
  address: string;
  port?: number;
  /** Zone id (from `zones`) the PE lives in. */
  zone: string;
  settings?: Record<string, any>;
}

export interface EmulatorConfig {
  global: Record<string, any>;
  geolocation?: { latitude: number; longitude: number };
  timezone?: string;
  pe: EmulatorPe;
  zones: EmulatorZone[];
  devices: EmulatorDevice[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
export const settingsPath = process.env.HE_SETTINGS
  ? resolve(process.env.HE_SETTINGS)
  : resolve(__dirname, 'settings.json');

let raw: EmulatorConfig;
try {
  raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
} catch (e: any) {
  console.error(`\n[EMULATOR] Could not read settings file:\n  ${settingsPath}\n`);
  console.error('[EMULATOR] Copy emulator/settings.example.json to emulator/settings.json and fill it in.');
  console.error(`[EMULATOR] (${e?.message ?? e})\n`);
  process.exit(1);
}

export const config: EmulatorConfig = raw;
