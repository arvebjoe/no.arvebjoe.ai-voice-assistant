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
    private _unavailableMessage: string | null = null;
    private _unavailableMessages: Array<string | null> = [];

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
    async setAvailable(): Promise<void> {
        this._available = true;
        this._unavailableMessage = null;
        this._unavailableMessages.push(null);
    }
    /**
     * The reason matters as much as the flag — "Unavailable" alone cannot say
     * whether the satellite or the voice engine is down — so record it, and
     * keep the history so a test can assert a reason CHANGING while the device
     * stays unavailable.
     */
    async setUnavailable(msg?: string): Promise<void> {
        this._available = false;
        this._unavailableMessage = msg ?? null;
        this._unavailableMessages.push(msg ?? null);
    }
    /** Last reason passed to setUnavailable() (null once available again). */
    get unavailableMessage(): string | null { return this._unavailableMessage; }
    /** Every availability message in order, for transition assertions. */
    get unavailableMessages(): Array<string | null> { return this._unavailableMessages; }

    private _warning: string | null = null;
    private _warnings: Array<string | null> = [];
    /**
     * The device banner, kept separate from availability on purpose: it carries
     * the things that are wrong with a device that is otherwise connected —
     * today, another API client holding its voice-assistant subscription.
     */
    async setWarning(msg?: string): Promise<void> {
        this._warning = msg ?? null;
        this._warnings.push(msg ?? null);
    }
    async unsetWarning(): Promise<void> {
        this._warning = null;
        this._warnings.push(null);
    }
    /** Currently shown warning, or null. */
    get warning(): string | null { return this._warning; }
    /** Every warning set/cleared in order, for transition assertions. */
    get warnings(): Array<string | null> { return this._warnings; }

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
