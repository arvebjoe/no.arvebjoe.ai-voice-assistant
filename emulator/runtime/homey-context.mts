// Builds the fake `homey` instance object that the SDK normally injects into
// App / Device / Driver. Lazily constructed as a singleton on first getHomey()
// so that importing the shims doesn't trigger config reads prematurely.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from '../config.mjs';
import { flowCards } from './flow-cards.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../.homeycompose/app.json'), 'utf8'),
);

let homey: any = null;

export function getHomey(): any {
  if (homey) return homey;

  // Seed the in-memory settings store from settings.json -> global.
  const store = new Map<string, any>(Object.entries(config.global ?? {}));
  const settingsEmitter = new EventEmitter();

  homey = {
    manifest,
    version: manifest.version,
    platform: 'local',
    platformVersion: 1,
    app: null, // set by the bootstrap once the App is constructed

    settings: {
      get(key: string) { return store.has(key) ? store.get(key) : null; },
      async set(key: string, value: any) { store.set(key, value); settingsEmitter.emit('set', key); },
      async unset(key: string) { store.delete(key); settingsEmitter.emit('set', key); },
      getKeys() { return [...store.keys()]; },
      on(evt: string, cb: (...a: any[]) => void) { settingsEmitter.on(evt, cb); },
    },

    notifications: {
      async createNotification({ excerpt }: { excerpt: string }) {
        console.log(`\n🔔 [NOTIFICATION] ${excerpt}\n`);
      },
    },

    // Real card objects from the emulator registry: the driver's run-listeners
    // land there (runnable via the REPL's `and`/`then`), and trigger firings
    // are logged to the console instead of no-opped.
    flow: {
      getConditionCard: (id: string) => flowCards.getCard('condition', id),
      getActionCard: (id: string) => flowCards.getCard('action', id),
      getTriggerCard: (id: string) => flowCards.getCard('trigger', id),
      getDeviceTriggerCard: (id: string) => flowCards.getCard('trigger', id),
    },

    geolocation: {
      async getLatitude() { return config.geolocation?.latitude ?? 0; },
      async getLongitude() { return config.geolocation?.longitude ?? 0; },
      getMode() { return 'auto'; },
      on(_evt: string, _cb: (...a: any[]) => void) {},
    },

    clock: {
      getTimezone() { return config.timezone ?? 'UTC'; },
      on(_evt: string, _cb: (...a: any[]) => void) {},
    },

    // Timer helpers — delegate to the Node globals. Node's Timeout already has
    // .unref(), which the app's discovery code calls.
    setTimeout: (fn: (...a: any[]) => void, ms: number, ...args: any[]) => setTimeout(fn, ms, ...args),
    clearTimeout: (t: any) => clearTimeout(t),
    setInterval: (fn: (...a: any[]) => void, ms: number, ...args: any[]) => setInterval(fn, ms, ...args),
    clearInterval: (t: any) => clearInterval(t),

    __: (key: string) => key, // i18n passthrough

    log: (...args: any[]) => console.log(...args),
    error: (...args: any[]) => console.error(...args),
  };

  return homey;
}
