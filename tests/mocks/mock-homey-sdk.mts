// A self-contained fake of the `homey` package for unit tests — enough of the
// Device base class for VoiceAssistantDevice to run onInit() and its handlers.
// Modelled on emulator/shims/homey.mts but with NO config/settings.json reads, and
// `this.homey` is injected via the constructor config so tests stay hermetic.
import { EventEmitter } from 'node:events';

export interface FakeDeviceConfig {
    homey?: any;
    store?: Record<string, any>;
    settings?: Record<string, any>;
    data?: Record<string, any>;
    capabilities?: string[];
}

export class Device extends EventEmitter {
    homey: any;
    private _store: Record<string, any>;
    private _settings: Record<string, any>;
    private _data: Record<string, any>;
    private _caps: Set<string>;
    private _capValues: Record<string, any> = {};
    private _listeners: Record<string, (value: any, opts?: any) => any> = {};
    private _available = false;

    constructor(config: FakeDeviceConfig = {}) {
        super();
        this.homey = config.homey ?? {};
        this._store = { ...(config.store ?? {}) };
        this._settings = { ...(config.settings ?? {}) };
        this._data = { ...(config.data ?? {}) };
        this._caps = new Set<string>(config.capabilities ?? []);
    }

    getName(): string { return this._data?.name ?? 'Test Device'; }
    getData(): any { return { ...this._data }; }

    getStore(): any { return { ...this._store }; }
    getStoreValue(key: string): any { return this._store[key]; }

    getSettings(): any { return { ...this._settings }; }
    async setSettings(s: Record<string, any>): Promise<void> { Object.assign(this._settings, s); }
    /** Test helper: simulate the SDK persisting new settings after onSettings resolves. */
    __applySettings(s: Record<string, any>): void { Object.assign(this._settings, s); }

    hasCapability(cap: string): boolean { return this._caps.has(cap); }
    async addCapability(cap: string): Promise<void> { this._caps.add(cap); }
    async removeCapability(cap: string): Promise<void> { this._caps.delete(cap); }
    getCapabilities(): string[] { return [...this._caps]; }
    getCapabilityValue(cap: string): any { return this._capValues[cap]; }
    async setCapabilityValue(cap: string, value: any): Promise<void> { this._capValues[cap] = value; }

    registerCapabilityListener(cap: string, fn: (value: any, opts?: any) => any): void {
        this._listeners[cap] = fn;
    }
    async invokeCapabilityListener(cap: string, value: any): Promise<any> {
        const fn = this._listeners[cap];
        if (!fn) throw new Error(`No capability listener registered for '${cap}'`);
        return fn(value);
    }

    getAvailable(): boolean { return this._available; }
    async setAvailable(): Promise<void> { this._available = true; }
    async setUnavailable(_msg?: string): Promise<void> { this._available = false; }

    log(..._args: any[]) { /* silent in tests */ }
    error(..._args: any[]) { /* silent in tests */ }
}

export class App extends EventEmitter {
    homey: any;
    constructor(config: FakeDeviceConfig = {}) { super(); this.homey = config.homey ?? {}; }
    log() { } error() { }
    async onInit(): Promise<void> { }
    async onUninit(): Promise<void> { }
}

export class Driver extends EventEmitter {
    homey: any;
    constructor(config: FakeDeviceConfig = {}) { super(); this.homey = config.homey ?? {}; }
    log() { } error() { }
    async onInit(): Promise<void> { }
}

const Homey = { App, Device, Driver };
export default Homey;
