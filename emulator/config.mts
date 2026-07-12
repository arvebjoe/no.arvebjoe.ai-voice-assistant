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

export interface EmulatorSatellite {
  name: string;
  mac: string;
  address: string;
  port?: number;
  /** Zone id (from `zones`) the satellite lives in. */
  zone: string;
  /** Which driver to boot it with: 'pe' (default) or 'xiaozhi'. */
  type?: 'pe' | 'xiaozhi';
  settings?: Record<string, any>;
}

/** Legacy single-satellite field; superseded by `satellites`. */
export type EmulatorPe = EmulatorSatellite;

export interface EmulatorConfig {
  global: Record<string, any>;
  geolocation?: { latitude: number; longitude: number };
  timezone?: string;
  /** Legacy: a single PE satellite. Used only when `satellites` is absent/empty. */
  pe?: EmulatorPe;
  /** The voice satellites to boot. The `discover` console command appends here. */
  satellites?: EmulatorSatellite[];
  zones: EmulatorZone[];
  devices: EmulatorDevice[];
  /**
   * Emulator-only environment variables read by the app code, e.g.
   * `HE_HOST_IP` (advertised playback host), `ESP_LOG_LEVEL`, and the settings
   * web UI's `HE_SETTINGS_PORT`/`HE_SETTINGS_HOST`. Applied to process.env at
   * load so you don't have to export them yourself. A real environment
   * variable always wins over the settings.json value.
   */
  env?: Record<string, string>;
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

/**
 * The effective satellite list: `satellites` when present, else the legacy
 * single `pe` entry. Types default to 'pe'. Everything that boots or lists
 * satellites should go through this instead of reading config.pe directly.
 */
export function getSatellites(): EmulatorSatellite[] {
  const list = (config.satellites && config.satellites.length > 0)
    ? config.satellites
    : (config.pe ? [config.pe] : []);
  return list.map((s) => ({ ...s, type: s.type ?? 'pe', port: s.port ?? 6053 }));
}

// Mark this process as emulator-hosted. App code uses this to authorize
// dev-only features that must never activate on a real Homey — e.g.
// `input_buffer_debug` (serves raw mic audio over the LAN audio URL).
process.env.HE_EMULATOR = '1';

// Push settings.json `env` values into process.env so the app code (which reads
// process.env.HE_HOST_IP, process.env.ESP_LOG_LEVEL, ...) picks them up without
// you having to export them by hand. An already-set real env var takes
// precedence, so you can still override on the command line.
if (config.env) {
  for (const [key, value] of Object.entries(config.env)) {
    if (key.startsWith('_')) continue; // `_`-prefixed keys are JSON comments, not env vars
    if (value == null || value === '') continue;
    if (process.env[key] != null && process.env[key] !== '') continue;
    process.env[key] = String(value);
  }
}
