import { EventEmitter } from 'events';
import { createLogger } from '../helpers/logger.mjs';

/**
 * Improv Wi-Fi over BLE protocol client (https://www.improv-wifi.com/).
 *
 * Verified against the official SDKs (improv-wifi/sdk-js, sdk-cpp) and
 * ESPHome's esp32_improv component. Used during pairing to push Wi-Fi
 * credentials to a satellite that is not on the network yet (ThirdReality
 * V&M, Home Assistant Voice PE). Full background: docs/wifi-provisioning-improv-ble.md.
 *
 * All BLE I/O goes through Homey's `this.homey.ble` manager, but this module
 * only depends on small structural interfaces so tests can substitute fakes.
 */

// Homey's BLE stack (noble-style) represents 128-bit UUIDs as lowercase hex
// without dashes (see athombv/com.mipow-example).
export const IMPROV_SERVICE_UUID = '00467768622822724663277478268000';
export const IMPROV_CHAR_CURRENT_STATE = '00467768622822724663277478268001';
export const IMPROV_CHAR_ERROR_STATE = '00467768622822724663277478268002';
export const IMPROV_CHAR_RPC_COMMAND = '00467768622822724663277478268003';
export const IMPROV_CHAR_RPC_RESULT = '00467768622822724663277478268004';
export const IMPROV_CHAR_CAPABILITIES = '00467768622822724663277478268005';

// While unprovisioned the device also advertises Service Data under the
// 16-bit UUID 0x4677: [state, capabilities, 4x reserved].
export const IMPROV_SERVICE_DATA_UUID = '4677';

export enum ImprovState {
    AwaitingAuthorization = 0x01,
    Authorized = 0x02,
    Provisioning = 0x03,
    Provisioned = 0x04,
}

export enum ImprovErrorState {
    NoError = 0x00,
    InvalidRpcPacket = 0x01,
    UnknownRpcCommand = 0x02,
    UnableToConnect = 0x03,
    NotAuthorized = 0x04,
    Unknown = 0xff,
}

export enum ImprovRpcCommand {
    WifiSettings = 0x01,
    Identify = 0x02,
}

export const CAPABILITY_IDENTIFY = 0x01;

/** Thrown when the device reports a non-zero error state during provisioning. */
export class ImprovDeviceError extends Error {
    constructor(public readonly code: ImprovErrorState) {
        super(`Improv device error 0x${code.toString(16).padStart(2, '0')} (${ImprovErrorState[code] ?? 'unknown'})`);
        this.name = 'ImprovDeviceError';
    }
}

/** Thrown when a provisioning phase does not complete in time. */
export class ImprovTimeoutError extends Error {
    constructor(public readonly phase: 'authorization' | 'provisioning') {
        super(phase === 'authorization'
            ? 'Timed out waiting for authorization (press the button on the device)'
            : 'Timed out waiting for the device to join the Wi-Fi network');
        this.name = 'ImprovTimeoutError';
    }
}

// --- Structural interfaces over Homey's BLE classes (kept minimal for tests) ---

export interface BleCharacteristicLike {
    uuid: string;
    read(): Promise<Buffer>;
    write(data: Buffer): Promise<any>;
    subscribeToNotifications?(callback: (data: Buffer) => void): Promise<void>;
    unsubscribeFromNotifications?(): Promise<void>;
}

export interface BleServiceLike {
    uuid: string;
    characteristics?: BleCharacteristicLike[];
    discoverCharacteristics?(filter?: string[]): Promise<BleCharacteristicLike[]>;
}

export interface BlePeripheralLike {
    uuid: string;
    isConnected?: boolean;
    connect?(): Promise<any>;
    disconnect(): Promise<void>;
    discoverAllServicesAndCharacteristics(): Promise<BleServiceLike[]>;
}

export interface BleAdvertisementLike {
    uuid: string;
    address?: string;
    localName?: string;
    connectable?: boolean;
    rssi?: number;
    serviceUuids?: string[];
    serviceData?: { uuid: string; data: Buffer }[];
    connect(): Promise<BlePeripheralLike>;
}

export interface BleManagerLike {
    discover(serviceFilter?: string[]): Promise<BleAdvertisementLike[]>;
}

/** Normalize a BLE UUID for comparison: lowercase, no dashes. */
export function normalizeUuid(uuid: string): string {
    return uuid.toLowerCase().replace(/-/g, '');
}

function isImprovServiceUuid(uuid: string): boolean {
    const n = normalizeUuid(uuid);
    // 16-bit form, 16-bit expanded onto the Bluetooth base UUID, or the full Improv UUID.
    return n === IMPROV_SERVICE_UUID
        || n === IMPROV_SERVICE_DATA_UUID
        || n.startsWith('00004677');
}

// --- RPC packet framing ---
// <command:1> <payload_len:1> <payload...> <checksum:1>
// checksum = sum of all preceding bytes & 0xFF

export function buildRpcPacket(command: ImprovRpcCommand, payload: Buffer): Buffer {
    if (payload.length > 255) {
        throw new Error(`Improv RPC payload too long (${payload.length} > 255 bytes)`);
    }
    const packet = Buffer.alloc(payload.length + 3);
    packet[0] = command;
    packet[1] = payload.length;
    payload.copy(packet, 2);
    let checksum = 0;
    for (let i = 0; i < packet.length - 1; i++) {
        checksum += packet[i];
    }
    packet[packet.length - 1] = checksum & 0xff;
    return packet;
}

export function buildWifiSettingsPacket(ssid: string, password: string): Buffer {
    const ssidBytes = Buffer.from(ssid, 'utf8');
    const passBytes = Buffer.from(password, 'utf8');
    if (ssidBytes.length === 0) {
        throw new Error('SSID must not be empty');
    }
    if (ssidBytes.length > 255 || passBytes.length > 255) {
        throw new Error('SSID or password too long');
    }
    const payload = Buffer.concat([
        Buffer.from([ssidBytes.length]), ssidBytes,
        Buffer.from([passBytes.length]), passBytes,
    ]);
    return buildRpcPacket(ImprovRpcCommand.WifiSettings, payload);
}

/**
 * Parse an RPC result notification: same framing as commands, payload is a
 * list of length-prefixed strings (e.g. URLs where the device is reachable
 * after provisioning). Returns null for packets that are malformed or fail
 * the checksum.
 */
export function parseRpcResult(packet: Buffer): { command: number; values: string[] } | null {
    if (packet.length < 3) return null;
    const command = packet[0];
    const payloadLength = packet[1];
    if (packet.length < payloadLength + 3) return null;

    let checksum = 0;
    for (let i = 0; i < payloadLength + 2; i++) {
        checksum += packet[i];
    }
    if ((checksum & 0xff) !== packet[payloadLength + 2]) return null;

    const values: string[] = [];
    let offset = 2;
    const end = 2 + payloadLength;
    while (offset < end) {
        const len = packet[offset];
        offset += 1;
        if (offset + len > end) return null;
        values.push(packet.subarray(offset, offset + len).toString('utf8'));
        offset += len;
    }
    return { command, values };
}

// --- Discovery ---

export interface ImprovDiscoveredDevice {
    /** Homey's peripheral id — the key used to connect later. */
    id: string;
    name: string;
    address?: string;
    rssi?: number;
    /** Parsed from advertised service data if present. May be stale (Homey caches advertisements ≥30 s). */
    state?: ImprovState;
    capabilities?: number;
    advertisement: BleAdvertisementLike;
}

/**
 * Scan for BLE peripherals that advertise the Improv service. Tries a
 * filtered discover first, then merges in an unfiltered scan matched on
 * service UUIDs / Improv service data (some stacks only expose one of the two).
 */
export async function discoverImprovDevices(ble: BleManagerLike): Promise<ImprovDiscoveredDevice[]> {
    const found = new Map<string, BleAdvertisementLike>();

    try {
        for (const adv of await ble.discover([IMPROV_SERVICE_UUID])) {
            found.set(adv.uuid, adv);
        }
    } catch {
        // filtered discovery not supported / failed — the unfiltered pass below covers it
    }

    try {
        for (const adv of await ble.discover()) {
            if (found.has(adv.uuid)) continue;
            const byServiceUuid = (adv.serviceUuids ?? []).some(isImprovServiceUuid);
            const byServiceData = (adv.serviceData ?? []).some((sd) => isImprovServiceUuid(sd.uuid));
            if (byServiceUuid || byServiceData) {
                found.set(adv.uuid, adv);
            }
        }
    } catch {
        // keep whatever the filtered pass returned
    }

    return Array.from(found.values())
        .filter((adv) => adv.connectable !== false)
        .map((adv) => {
            const improvData = (adv.serviceData ?? []).find((sd) => isImprovServiceUuid(sd.uuid));
            const device: ImprovDiscoveredDevice = {
                id: adv.uuid,
                name: adv.localName || `Improv device ${adv.address ?? adv.uuid.slice(-5)}`,
                address: adv.address,
                rssi: adv.rssi,
                advertisement: adv,
            };
            if (improvData && improvData.data.length >= 2) {
                device.state = improvData.data[0] as ImprovState;
                device.capabilities = improvData.data[1];
            }
            return device;
        });
}

// --- Session ---

export interface ImprovSessionInfo {
    state: ImprovState;
    error: ImprovErrorState;
    capabilities: number;
    supportsIdentify: boolean;
}

export interface ImprovProvisionOptions {
    /** Max time to wait for the user to authorize on-device (e.g. PE center button). */
    authorizationTimeoutMs?: number;
    /** Max time to wait for the device to join the network after credentials are sent. */
    provisioningTimeoutMs?: number;
}

export interface ImprovSessionOptions {
    /** Poll interval for the state/error characteristics (backstop when notifications are unavailable/unreliable). */
    pollIntervalMs?: number;
}

/**
 * A GATT session against one Improv device. Emits:
 *  - 'status'  ({ state, error }) whenever either changes
 *
 * Mirrors the reference sdk-js flow: connect -> discover characteristics ->
 * subscribe to notifications -> read initial state -> write WIFI_SETTINGS ->
 * wait for PROVISIONED (RPC result carries redirect URLs) or a non-zero error.
 */
export class ImprovBleSession extends EventEmitter {
    private logger = createLogger('Improv_BLE');
    private peripheral: BlePeripheralLike | null = null;
    private chars = new Map<string, BleCharacteristicLike>();
    private subscribedChars: BleCharacteristicLike[] = [];
    private pollTimer: NodeJS.Timeout | null = null;
    private closed = false;

    private state: ImprovState | null = null;
    private errorState: ImprovErrorState = ImprovErrorState.NoError;
    private rpcResult: { command: number; values: string[] } | null = null;
    private capabilities = 0;

    private readonly pollIntervalMs: number;

    constructor(private readonly advertisement: BleAdvertisementLike, options: ImprovSessionOptions = {}) {
        super();
        this.pollIntervalMs = options.pollIntervalMs ?? 500;
    }

    get currentState(): ImprovState | null {
        return this.state;
    }

    get currentError(): ImprovErrorState {
        return this.errorState;
    }

    get isConnected(): boolean {
        return this.peripheral !== null && !this.closed;
    }

    async connect(): Promise<ImprovSessionInfo> {
        if (this.closed) throw new Error('Session already closed');
        this.logger.info(`Connecting to ${this.advertisement.localName ?? this.advertisement.uuid}`);

        this.peripheral = await this.advertisement.connect();
        const services = await this.peripheral.discoverAllServicesAndCharacteristics();
        const service = services.find((s) => normalizeUuid(s.uuid) === IMPROV_SERVICE_UUID);
        if (!service) {
            await this.disconnect();
            throw new Error('Device does not expose the Improv Wi-Fi service (is it already set up?)');
        }

        const characteristics = service.characteristics && service.characteristics.length > 0
            ? service.characteristics
            : await service.discoverCharacteristics?.() ?? [];
        for (const char of characteristics) {
            this.chars.set(normalizeUuid(char.uuid), char);
        }
        for (const required of [IMPROV_CHAR_CURRENT_STATE, IMPROV_CHAR_ERROR_STATE, IMPROV_CHAR_RPC_COMMAND]) {
            if (!this.chars.has(required)) {
                await this.disconnect();
                throw new Error(`Improv service is missing characteristic ${required}`);
            }
        }

        // Capabilities are optional per spec ("firmware not according to spec" fallback in sdk-js)
        try {
            const capBuf = await this.chars.get(IMPROV_CHAR_CAPABILITIES)?.read();
            this.capabilities = capBuf && capBuf.length > 0 ? capBuf[0] : 0;
        } catch {
            this.capabilities = 0;
        }

        await this.subscribe(IMPROV_CHAR_CURRENT_STATE, (data) => this.onStateData(data));
        await this.subscribe(IMPROV_CHAR_ERROR_STATE, (data) => this.onErrorData(data));
        await this.subscribe(IMPROV_CHAR_RPC_RESULT, (data) => this.onRpcResultData(data));

        await this.refresh();
        this.logger.info(`Connected — state=${this.describeState()}, capabilities=0x${this.capabilities.toString(16)}`);

        return {
            state: this.state!,
            error: this.errorState,
            capabilities: this.capabilities,
            supportsIdentify: (this.capabilities & CAPABILITY_IDENTIFY) === CAPABILITY_IDENTIFY,
        };
    }

    /**
     * Send Wi-Fi credentials. Waits for on-device authorization first if
     * needed (caller should instruct the user to press the device's button —
     * progress is observable via 'status' events). Resolves with the URLs the
     * device reports itself reachable at (may be empty).
     */
    async provision(ssid: string, password: string, options: ImprovProvisionOptions = {}): Promise<string[]> {
        const authorizationTimeoutMs = options.authorizationTimeoutMs ?? 60_000;
        const provisioningTimeoutMs = options.provisioningTimeoutMs ?? 60_000;

        if (!this.peripheral || this.closed) throw new Error('Not connected');
        const packet = buildWifiSettingsPacket(ssid, password);

        if (this.state === ImprovState.AwaitingAuthorization) {
            this.logger.info('Awaiting on-device authorization (button press)');
            // 'status' normally fires only on state TRANSITIONS, but the device
            // is already in AwaitingAuthorization when this wait begins — emit
            // the current state explicitly so the wizard can show the
            // "press the button on the device" instruction.
            this.emitStatus();
            await this.waitFor(
                () => this.state !== null && this.state !== ImprovState.AwaitingAuthorization,
                authorizationTimeoutMs,
                () => new ImprovTimeoutError('authorization'),
            );
        }
        if (this.state !== ImprovState.Authorized) {
            throw new Error(`Device is not ready for provisioning (state=${this.describeState()})`);
        }

        // Reset stale results so we only react to this attempt
        this.errorState = ImprovErrorState.NoError;
        this.rpcResult = null;

        this.logger.info(`Sending Wi-Fi credentials for "${ssid}" (${packet.length} byte packet)`);
        try {
            await this.chars.get(IMPROV_CHAR_RPC_COMMAND)!.write(packet);
        } catch (err: any) {
            // The credentials packet exceeds the 23-byte default ATT MTU; if the
            // stack can't do long writes this is where it shows up.
            throw new Error(`BLE write failed (${packet.length} byte packet — possible MTU/long-write limitation): ${err?.message ?? err}`);
        }

        await this.waitFor(
            () => this.state === ImprovState.Provisioned || this.errorState !== ImprovErrorState.NoError,
            provisioningTimeoutMs,
            () => new ImprovTimeoutError('provisioning'),
        );

        if (this.errorState !== ImprovErrorState.NoError) {
            throw new ImprovDeviceError(this.errorState);
        }

        // URLs arrive as an RPC result notification; fall back to reading the
        // characteristic in case the notification was missed.
        if (!this.rpcResult) {
            try {
                const buf = await this.chars.get(IMPROV_CHAR_RPC_RESULT)?.read();
                if (buf) this.rpcResult = parseRpcResult(buf);
            } catch {
                // non-fatal: provisioning already succeeded
            }
        }
        const urls = this.rpcResult?.command === ImprovRpcCommand.WifiSettings ? this.rpcResult.values : [];
        this.logger.info(`Provisioned — device reachable at [${urls.join(', ') || 'no URL reported'}]`);
        return urls;
    }

    /** Ask the device to identify itself (blink an LED). Best-effort. */
    async identify(): Promise<void> {
        if (!this.peripheral || this.closed) throw new Error('Not connected');
        await this.chars.get(IMPROV_CHAR_RPC_COMMAND)!.write(buildRpcPacket(ImprovRpcCommand.Identify, Buffer.alloc(0)));
    }

    async disconnect(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.stopPolling();
        for (const char of this.subscribedChars) {
            try {
                await char.unsubscribeFromNotifications?.();
            } catch { /* device may already be gone */ }
        }
        this.subscribedChars = [];
        try {
            await this.peripheral?.disconnect();
        } catch { /* device may already be gone */ }
        this.peripheral = null;
        this.removeAllListeners();
    }

    // --- internals ---

    private describeState(): string {
        return this.state === null ? 'unknown' : `${ImprovState[this.state] ?? this.state}`;
    }

    private async subscribe(uuid: string, callback: (data: Buffer) => void): Promise<void> {
        const char = this.chars.get(uuid);
        if (!char?.subscribeToNotifications) return;
        try {
            await char.subscribeToNotifications(callback);
            this.subscribedChars.push(char);
        } catch (err: any) {
            // Notifications are a nice-to-have; polling in waitFor() is the backstop
            this.logger.warn(`Could not subscribe to notifications on ${uuid}: ${err?.message ?? err}`);
        }
    }

    private onStateData(data: Buffer): void {
        if (data.length < 1) return;
        const next = data[0] as ImprovState;
        if (next !== this.state) {
            this.state = next;
            this.logger.info(`State -> ${this.describeState()}`);
            this.emitStatus();
        }
    }

    private onErrorData(data: Buffer): void {
        if (data.length < 1) return;
        const next = data[0] as ImprovErrorState;
        if (next !== this.errorState) {
            this.errorState = next;
            if (next !== ImprovErrorState.NoError) {
                this.logger.warn(`Error state -> 0x${next.toString(16)}`);
            }
            this.emitStatus();
        }
    }

    private onRpcResultData(data: Buffer): void {
        const parsed = parseRpcResult(data);
        if (parsed) {
            this.rpcResult = parsed;
        }
    }

    private emitStatus(): void {
        this.emit('status', { state: this.state, error: this.errorState });
    }

    /** Read state + error directly (also drives 'status' events when polling). */
    private async refresh(): Promise<void> {
        const stateChar = this.chars.get(IMPROV_CHAR_CURRENT_STATE);
        const errorChar = this.chars.get(IMPROV_CHAR_ERROR_STATE);
        if (stateChar) this.onStateData(await stateChar.read());
        if (errorChar) this.onErrorData(await errorChar.read());
    }

    private stopPolling(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /**
     * Wait until predicate() is true. Notifications update the cached state
     * asynchronously; a poll loop re-reads the characteristics as a backstop
     * (Homey notification delivery is not guaranteed).
     */
    private waitFor(predicate: () => boolean, timeoutMs: number, makeTimeoutError: () => Error): Promise<void> {
        if (predicate()) return Promise.resolve();

        return new Promise<void>((resolve, reject) => {
            let finished = false;
            let polling = false;

            const finish = (err?: Error) => {
                if (finished) return;
                finished = true;
                this.stopPolling();
                this.off('status', onStatus);
                clearTimeout(timeoutHandle);
                if (err) reject(err); else resolve();
            };

            const onStatus = () => {
                if (predicate()) finish();
            };
            this.on('status', onStatus);

            const timeoutHandle = setTimeout(() => finish(makeTimeoutError()), timeoutMs);

            this.stopPolling();
            this.pollTimer = setInterval(async () => {
                if (polling || finished) return;
                polling = true;
                try {
                    await this.refresh();
                    if (predicate()) finish();
                } catch (err: any) {
                    // A read failure usually means the BLE link dropped. A drop right
                    // after PROVISIONED is expected (devices disconnect clients).
                    if (predicate()) {
                        finish();
                    } else {
                        finish(new Error(`Lost BLE connection to the device: ${err?.message ?? err}`));
                    }
                } finally {
                    polling = false;
                }
            }, this.pollIntervalMs);
        });
    }
}
