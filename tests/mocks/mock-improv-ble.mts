import {
    BleAdvertisementLike,
    BleCharacteristicLike,
    BleManagerLike,
    BlePeripheralLike,
    BleServiceLike,
    buildRpcPacket,
    IMPROV_CHAR_CAPABILITIES,
    IMPROV_CHAR_CURRENT_STATE,
    IMPROV_CHAR_ERROR_STATE,
    IMPROV_CHAR_RPC_COMMAND,
    IMPROV_CHAR_RPC_RESULT,
    IMPROV_SERVICE_DATA_UUID,
    IMPROV_SERVICE_UUID,
    ImprovErrorState,
    ImprovRpcCommand,
    ImprovState,
} from '../../src/ble/improv-ble-client.mjs';

/**
 * Fake Improv BLE device mimicking ESPHome's esp32_improv state machine:
 *  - WIFI_SETTINGS only accepted in AUTHORIZED state (else error 0x04)
 *  - correct password: PROVISIONING -> RPC result (urls) -> PROVISIONED
 *  - wrong password: error UNABLE_TO_CONNECT (0x03), state back to AUTHORIZED
 *  - optional authorizer: starts AWAITING_AUTHORIZATION until pressButton()
 */

export type NotificationMode = 'ok' | 'throw' | 'missing';

export interface FakeImprovDeviceOptions {
    uuid?: string;
    name?: string;
    address?: string;
    correctPassword?: string;
    urls?: string[];
    requireAuthorization?: boolean;
    initialState?: ImprovState;
    capabilities?: number;
    notificationMode?: NotificationMode;
    /** Delay (ms) between PROVISIONING and the final result. */
    provisionDelayMs?: number;
    /** Advertise the 128-bit service uuid (true) or only Improv service data (false). */
    advertiseServiceUuid?: boolean;
    /**
     * Mimic the ThirdReality: after a FAILED provision attempt (wrong
     * password) the device silently kills the BLE link, so the next write
     * dies with an ATT error and the peripheral drops. A reconnect works.
     */
    dropLinkAfterFailedProvision?: boolean;
}

function encodeStrings(values: string[]): Buffer {
    return Buffer.concat(values.map((v) => {
        const bytes = Buffer.from(v, 'utf8');
        return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    }));
}

class FakeCharacteristic implements BleCharacteristicLike {
    subscribeToNotifications?: (callback: (data: Buffer) => void) => Promise<void>;
    unsubscribeFromNotifications?: () => Promise<void>;
    subscriber: ((data: Buffer) => void) | null = null;
    unsubscribed = false;

    constructor(
        public uuid: string,
        private readonly device: FakeImprovDevice,
        private readonly onRead: () => Buffer,
        private readonly onWrite?: (data: Buffer) => void,
    ) {
        const mode = device.options.notificationMode ?? 'ok';
        if (mode !== 'missing') {
            this.subscribeToNotifications = async (callback) => {
                if (mode === 'throw') throw new Error('notifications not supported');
                this.subscriber = callback;
            };
            this.unsubscribeFromNotifications = async () => {
                this.subscriber = null;
                this.unsubscribed = true;
            };
        }
    }

    async read(): Promise<Buffer> {
        this.device.assertConnected();
        return this.onRead();
    }

    async write(data: Buffer): Promise<Buffer> {
        if (this.device.linkPoisoned) {
            this.device.linkPoisoned = false;
            this.device.connected = false;
            throw new Error('Operation failed with ATT error: 0x0e');
        }
        this.device.assertConnected();
        this.onWrite?.(data);
        return data;
    }

    notify(data: Buffer): void {
        this.subscriber?.(data);
    }
}

class FakePeripheral implements BlePeripheralLike {
    constructor(public uuid: string, private readonly device: FakeImprovDevice) { }

    get isConnected(): boolean {
        return this.device.connected;
    }

    async disconnect(): Promise<void> {
        this.device.connected = false;
    }

    async discoverAllServicesAndCharacteristics(): Promise<BleServiceLike[]> {
        this.device.assertConnected();
        return this.device.services;
    }
}

export class FakeImprovDevice {
    connected = false;
    /** Set after a failed provision when dropLinkAfterFailedProvision: the next write throws + drops the link. */
    linkPoisoned = false;
    identifyCount = 0;
    lastWrittenPacket: Buffer | null = null;
    state: ImprovState;
    errorState: ImprovErrorState = ImprovErrorState.NoError;
    rpcResultBuffer: Buffer = Buffer.alloc(0);
    services: BleServiceLike[];

    readonly stateChar: FakeCharacteristic;
    readonly errorChar: FakeCharacteristic;
    readonly rpcCommandChar: FakeCharacteristic;
    readonly rpcResultChar: FakeCharacteristic;
    readonly capabilitiesChar: FakeCharacteristic;
    readonly advertisement: BleAdvertisementLike & { uuid: string };

    constructor(public readonly options: FakeImprovDeviceOptions = {}) {
        this.state = options.initialState
            ?? (options.requireAuthorization ? ImprovState.AwaitingAuthorization : ImprovState.Authorized);

        this.stateChar = new FakeCharacteristic(IMPROV_CHAR_CURRENT_STATE, this, () => Buffer.from([this.state]));
        this.errorChar = new FakeCharacteristic(IMPROV_CHAR_ERROR_STATE, this, () => Buffer.from([this.errorState]));
        this.rpcCommandChar = new FakeCharacteristic(IMPROV_CHAR_RPC_COMMAND, this, () => Buffer.alloc(0), (data) => this.handleRpcWrite(data));
        this.rpcResultChar = new FakeCharacteristic(IMPROV_CHAR_RPC_RESULT, this, () => this.rpcResultBuffer);
        this.capabilitiesChar = new FakeCharacteristic(IMPROV_CHAR_CAPABILITIES, this, () => Buffer.from([this.options.capabilities ?? 0]));

        const improvService: BleServiceLike = {
            uuid: IMPROV_SERVICE_UUID,
            characteristics: [this.stateChar, this.errorChar, this.rpcCommandChar, this.rpcResultChar, this.capabilitiesChar],
        };
        // An unrelated service, to prove lookup filters correctly
        const otherService: BleServiceLike = { uuid: '180a', characteristics: [] };
        this.services = [otherService, improvService];

        const uuid = options.uuid ?? 'fake-improv-0001';
        const device = this;
        this.advertisement = {
            uuid,
            localName: options.name ?? '3RSPK-TEST Improv',
            address: options.address ?? 'aa:bb:cc:dd:ee:ff',
            connectable: true,
            rssi: -60,
            serviceUuids: (options.advertiseServiceUuid ?? true) ? [IMPROV_SERVICE_UUID] : [],
            serviceData: [{
                uuid: IMPROV_SERVICE_DATA_UUID,
                data: Buffer.from([device.state, options.capabilities ?? 0, 0, 0, 0, 0]),
            }],
            async connect(): Promise<BlePeripheralLike> {
                device.connected = true;
                return new FakePeripheral(uuid, device);
            },
        };
    }

    assertConnected(): void {
        if (!this.connected) throw new Error('not connected');
    }

    /** Simulate the user pressing the on-device authorize button. */
    pressButton(): void {
        this.setState(ImprovState.Authorized);
    }

    setState(state: ImprovState): void {
        this.state = state;
        this.stateChar.notify(Buffer.from([state]));
    }

    setError(error: ImprovErrorState): void {
        this.errorState = error;
        this.errorChar.notify(Buffer.from([error]));
    }

    private handleRpcWrite(packet: Buffer): void {
        this.lastWrittenPacket = packet;

        // Validate framing + checksum like the sdk-cpp reference parser
        if (packet.length < 3 || packet[1] !== packet.length - 3) {
            this.setError(ImprovErrorState.InvalidRpcPacket);
            return;
        }
        let checksum = 0;
        for (let i = 0; i < packet.length - 1; i++) checksum += packet[i];
        if ((checksum & 0xff) !== packet[packet.length - 1]) {
            this.setError(ImprovErrorState.InvalidRpcPacket);
            return;
        }

        const command = packet[0];
        if (command === ImprovRpcCommand.Identify) {
            this.identifyCount += 1;
            return;
        }
        if (command !== ImprovRpcCommand.WifiSettings) {
            this.setError(ImprovErrorState.UnknownRpcCommand);
            return;
        }

        if (this.state !== ImprovState.Authorized) {
            this.setError(ImprovErrorState.NotAuthorized);
            return;
        }

        const ssidLength = packet[2];
        const passStart = 3 + ssidLength + 1;
        const passLength = packet[3 + ssidLength];
        const password = packet.subarray(passStart, passStart + passLength).toString('utf8');

        this.setState(ImprovState.Provisioning);
        const delay = this.options.provisionDelayMs ?? 10;
        setTimeout(() => {
            const expected = this.options.correctPassword ?? 'correct-password';
            if (password === expected) {
                this.rpcResultBuffer = buildRpcPacket(
                    ImprovRpcCommand.WifiSettings,
                    encodeStrings(this.options.urls ?? ['http://192.168.1.123']),
                );
                this.rpcResultChar.notify(this.rpcResultBuffer);
                this.setState(ImprovState.Provisioned);
            } else {
                this.setState(ImprovState.Authorized);
                this.setError(ImprovErrorState.UnableToConnect);
                if (this.options.dropLinkAfterFailedProvision) {
                    this.linkPoisoned = true;
                }
            }
        }, delay);
    }
}

/** A non-Improv advertisement, for scan-filtering tests. */
export function makeUnrelatedAdvertisement(uuid: string): BleAdvertisementLike {
    return {
        uuid,
        localName: 'Some Sensor',
        connectable: true,
        serviceUuids: ['180d'],
        serviceData: [],
        async connect(): Promise<BlePeripheralLike> {
            throw new Error('should not be connected to');
        },
    };
}

/**
 * Fake Homey BLE manager. Filtered discover only matches advertisements that
 * expose the requested service uuid; unfiltered returns everything —
 * mirroring how Homey's discover(serviceFilter) behaves.
 */
export class FakeBleManager implements BleManagerLike {
    constructor(public advertisements: BleAdvertisementLike[] = []) { }
    discoverCalls: (string[] | undefined)[] = [];

    async discover(serviceFilter?: string[]): Promise<BleAdvertisementLike[]> {
        this.discoverCalls.push(serviceFilter);
        if (!serviceFilter || serviceFilter.length === 0) {
            return this.advertisements;
        }
        return this.advertisements.filter((adv) => (adv.serviceUuids ?? [])
            .some((uuid) => serviceFilter.includes(uuid.toLowerCase().replace(/-/g, ''))));
    }
}
