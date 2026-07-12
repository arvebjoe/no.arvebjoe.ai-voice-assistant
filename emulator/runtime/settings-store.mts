// Persists emulator state back into settings.json: satellites added by the
// `discover` console command, and global settings saved from the settings web
// UI. Reads the file fresh (rather than reusing the in-memory config) so
// hand-edits made while the emulator runs aren't clobbered, and migrates the
// legacy single `pe` field into the `satellites` array on first write so
// nothing is lost.
import { readFileSync, writeFileSync } from 'node:fs';
import { settingsPath, EmulatorSatellite } from '../config.mjs';

const sameMac = (a: string, b: string) =>
  a.replace(/[^0-9a-f]/gi, '').toLowerCase() === b.replace(/[^0-9a-f]/gi, '').toLowerCase();

/**
 * Add (or update, matched by MAC) satellites in settings.json.
 * Returns the full satellite list now on disk.
 */
export function saveSatellites(toAdd: EmulatorSatellite[]): EmulatorSatellite[] {
  const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));

  const satellites: EmulatorSatellite[] = Array.isArray(raw.satellites) ? raw.satellites : [];

  // Migrate the legacy `pe` entry so switching to `satellites` doesn't drop it.
  if (satellites.length === 0 && raw.pe && raw.pe.mac) {
    satellites.push({ type: 'pe', ...raw.pe });
    delete raw.pe;
  }

  for (const sat of toAdd) {
    const existing = satellites.find((s) => sameMac(s.mac, sat.mac));
    if (existing) {
      // Re-discovered device: refresh what mDNS knows, keep user-tuned fields.
      existing.address = sat.address;
      existing.port = sat.port;
      existing.name = existing.name || sat.name;
    } else {
      satellites.push(sat);
    }
  }

  raw.satellites = satellites;
  writeFileSync(settingsPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return satellites;
}

/**
 * Persist one global app setting into settings.json -> `global`, so saves made
 * in the settings web UI survive an emulator restart. null/undefined removes
 * the key. Fully synchronous, so the parallel PUT burst of a settings-page
 * Save can't interleave read-modify-write cycles.
 */
export function saveGlobalSetting(key: string, value: any): void {
  const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (!raw.global || typeof raw.global !== 'object') raw.global = {};
  if (value === null || value === undefined) delete raw.global[key];
  else raw.global[key] = value;
  writeFileSync(settingsPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}
