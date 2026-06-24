// Shim for the `homey` package. Provides the App / Device / Driver base classes
// the app subclasses, wired to the fake `homey` context. The Homey runtime would
// normally construct these and call onInit(); in the emulator the bootstrap
// (main.mts) does that explicitly.
import { EventEmitter } from 'node:events';
import { getHomey } from '../runtime/homey-context.mjs';

export class App extends EventEmitter {
  homey: any;
  manifest: any;

  constructor() {
    super();
    this.homey = getHomey();
    this.manifest = this.homey.manifest;
  }

  log(...args: any[]) { this.homey.log(...args); }
  error(...args: any[]) { this.homey.error(...args); }
  async onInit(): Promise<void> {}
  async onUninit(): Promise<void> {}
}

export class Device extends EventEmitter {
  homey: any;
  private _store: Record<string, any>;
  private _settings: Record<string, any>;
  private _data: Record<string, any>;
  private _caps: Set<string>;
  private _capValues: Record<string, any>;
  private _listeners: Record<string, (value: any, opts?: any) => any> = {};
  private _available = false;
  private _driver: any;

  constructor(config: any = {}) {
    super();
    this.homey = getHomey();
    this._store = { ...(config.store ?? {}) };
    this._settings = { ...(config.settings ?? {}) };
    this._data = { ...(config.data ?? {}) };
    this._caps = new Set<string>(config.capabilities ?? []);
    this._capValues = {};
    this._driver = config.driver ?? null;
  }

  getName(): string { return this._data?.name ?? this._store?.name ?? 'Emulated Device'; }
  getData(): any { return { ...this._data }; }
  getDriver(): any { return this._driver; }

  getStore(): any { return { ...this._store }; }
  getStoreValue(key: string): any { return this._store[key]; }
  async setStoreValue(key: string, value: any): Promise<void> { this._store[key] = value; }
  async unsetStoreValue(key: string): Promise<void> { delete this._store[key]; }

  getSettings(): any { return { ...this._settings }; }
  async setSettings(s: Record<string, any>): Promise<void> { Object.assign(this._settings, s); }

  hasCapability(cap: string): boolean { return this._caps.has(cap); }
  async addCapability(cap: string): Promise<void> { this._caps.add(cap); }
  async removeCapability(cap: string): Promise<void> { this._caps.delete(cap); }
  getCapabilities(): string[] { return [...this._caps]; }
  getCapabilityValue(cap: string): any { return this._capValues[cap]; }
  async setCapabilityValue(cap: string, value: any): Promise<void> { this._capValues[cap] = value; }

  registerCapabilityListener(cap: string, fn: (value: any, opts?: any) => any): void {
    this._listeners[cap] = fn;
  }

  /** Emulator-only: drive a capability from the REPL (e.g. press onoff). */
  async invokeCapabilityListener(cap: string, value: any): Promise<any> {
    const fn = this._listeners[cap];
    if (!fn) throw new Error(`No capability listener registered for '${cap}'`);
    return fn(value);
  }

  getAvailable(): boolean { return this._available; }
  async setAvailable(): Promise<void> { this._available = true; }
  async setUnavailable(_msg?: string): Promise<void> { this._available = false; }

  getDiscoveryStrategy(): any {
    return { getDiscoveryResults: () => ({}) };
  }

  log(...args: any[]) { this.homey.log(...args); }
  error(...args: any[]) { this.homey.error(...args); }
}

export class Driver extends EventEmitter {
  homey: any;
  private _discovery: any;

  constructor(config: any = {}) {
    super();
    this.homey = getHomey();
    this._discovery = config?.discovery ?? null;
  }

  getDiscoveryStrategy(): any {
    return this._discovery ?? { getDiscoveryResults: () => ({}) };
  }

  async getDevices(): Promise<any[]> { return []; }
  log(...args: any[]) { this.homey.log(...args); }
  error(...args: any[]) { this.homey.error(...args); }
  async onInit(): Promise<void> {}
  async onPairListDevices(): Promise<any[]> { return []; }
}

const Homey = { App, Device, Driver };
export default Homey;
