import { describe, it, expect } from 'vitest';
import {
    buildRpcPacket,
    buildWifiSettingsPacket,
    discoverImprovDevices,
    ImprovBleSession,
    ImprovDeviceError,
    ImprovErrorState,
    ImprovRpcCommand,
    ImprovState,
    ImprovTimeoutError,
    parseRpcResult,
} from '../src/ble/improv-ble-client.mjs';
import { FakeBleManager, FakeImprovDevice, makeUnrelatedAdvertisement } from './mocks/mock-improv-ble.mjs';

const checksumOf = (bytes: number[]) => bytes.reduce((sum, b) => sum + b, 0) & 0xff;

describe('Improv RPC framing', () => {
    it('builds a WIFI_SETTINGS packet exactly like the reference SDK', () => {
        // sdk-js: [command, data.length, ssidLen, ...ssid, passLen, ...pass, checksum]
        const packet = buildWifiSettingsPacket('ab', 'cd');
        const expectedBody = [0x01, 6, 2, 0x61, 0x62, 2, 0x63, 0x64];
        expect([...packet]).toEqual([...expectedBody, checksumOf(expectedBody)]);
    });

    it('supports open networks (empty password)', () => {
        const packet = buildWifiSettingsPacket('net', '');
        const expectedBody = [0x01, 5, 3, 0x6e, 0x65, 0x74, 0];
        expect([...packet]).toEqual([...expectedBody, checksumOf(expectedBody)]);
    });

    it('encodes SSID and password as UTF-8', () => {
        const packet = buildWifiSettingsPacket('æøå', 'pw');
        const ssidBytes = [...Buffer.from('æøå', 'utf8')];
        expect(packet[2]).toBe(ssidBytes.length);
        expect([...packet.subarray(3, 3 + ssidBytes.length)]).toEqual(ssidBytes);
    });

    it('rejects an empty SSID and oversized credentials', () => {
        expect(() => buildWifiSettingsPacket('', 'pw')).toThrow(/SSID/);
        expect(() => buildWifiSettingsPacket('x'.repeat(256), 'pw')).toThrow(/too long/);
        expect(() => buildWifiSettingsPacket('net', 'x'.repeat(256))).toThrow(/too long/);
    });

    it('round-trips an RPC result with multiple URLs', () => {
        const urls = ['https://my.esphome.io/x', 'http://192.168.1.50:80'];
        const payload = Buffer.concat(urls.map((u) => Buffer.concat([Buffer.from([u.length]), Buffer.from(u)])));
        const packet = buildRpcPacket(ImprovRpcCommand.WifiSettings, payload);
        expect(parseRpcResult(packet)).toEqual({ command: ImprovRpcCommand.WifiSettings, values: urls });
    });

    it('rejects results with a bad checksum or truncated strings', () => {
        const good = buildRpcPacket(ImprovRpcCommand.WifiSettings, Buffer.from([3, 0x61, 0x62, 0x63]));
        const badChecksum = Buffer.from(good);
        badChecksum[badChecksum.length - 1] ^= 0xff;
        expect(parseRpcResult(badChecksum)).toBeNull();

        // inner string length points past the payload
        const body = [0x01, 2, 9, 0x61];
        const truncated = Buffer.from([...body, checksumOf(body)]);
        expect(parseRpcResult(truncated)).toBeNull();

        expect(parseRpcResult(Buffer.from([0x01]))).toBeNull();
    });
});

describe('discoverImprovDevices', () => {
    it('finds devices via the filtered scan (advertised service uuid)', async () => {
        const device = new FakeImprovDevice({ initialState: ImprovState.Authorized, capabilities: 1 });
        const ble = new FakeBleManager([device.advertisement, makeUnrelatedAdvertisement('other-1')]);

        const found = await discoverImprovDevices(ble);
        expect(found).toHaveLength(1);
        expect(found[0].id).toBe(device.advertisement.uuid);
        expect(found[0].name).toContain('3RSPK');
        // state + capabilities parsed from Improv service data (uuid 0x4677)
        expect(found[0].state).toBe(ImprovState.Authorized);
        expect(found[0].capabilities).toBe(1);
    });

    it('falls back to matching Improv service data when the service uuid is not advertised', async () => {
        const device = new FakeImprovDevice({ advertiseServiceUuid: false });
        const ble = new FakeBleManager([device.advertisement, makeUnrelatedAdvertisement('other-1')]);

        const found = await discoverImprovDevices(ble);
        expect(found).toHaveLength(1);
        expect(found[0].id).toBe(device.advertisement.uuid);
    });

    it('deduplicates devices found by both passes and skips non-connectable ones', async () => {
        const device = new FakeImprovDevice({});
        const nonConnectable = new FakeImprovDevice({ uuid: 'fake-improv-0002' });
        (nonConnectable.advertisement as any).connectable = false;
        const ble = new FakeBleManager([device.advertisement, nonConnectable.advertisement]);

        const found = await discoverImprovDevices(ble);
        expect(found.map((d) => d.id)).toEqual([device.advertisement.uuid]);
    });
});

describe('ImprovBleSession', () => {
    const fastPoll = { pollIntervalMs: 15 };

    it('connects, reads capabilities and state', async () => {
        const device = new FakeImprovDevice({ capabilities: 1 });
        const session = new ImprovBleSession(device.advertisement, fastPoll);
        const info = await session.connect();

        expect(info.state).toBe(ImprovState.Authorized);
        expect(info.error).toBe(ImprovErrorState.NoError);
        expect(info.supportsIdentify).toBe(true);
        expect(session.isConnected).toBe(true);
        await session.disconnect();
        expect(device.connected).toBe(false);
    });

    it('fails cleanly when the device has no Improv service', async () => {
        const device = new FakeImprovDevice({});
        device.services = [{ uuid: '180a', characteristics: [] }];
        const session = new ImprovBleSession(device.advertisement, fastPoll);

        await expect(session.connect()).rejects.toThrow(/Improv/);
        expect(device.connected).toBe(false);
    });

    it('provisions successfully and returns the reported URLs', async () => {
        const device = new FakeImprovDevice({ correctPassword: 'hunter22', urls: ['http://192.168.1.99'] });
        const session = new ImprovBleSession(device.advertisement, fastPoll);
        await session.connect();

        const statuses: any[] = [];
        session.on('status', (s) => statuses.push({ ...s }));

        const urls = await session.provision('MyWifi', 'hunter22');
        expect(urls).toEqual(['http://192.168.1.99']);
        expect(statuses.some((s) => s.state === ImprovState.Provisioning)).toBe(true);
        expect(statuses.some((s) => s.state === ImprovState.Provisioned)).toBe(true);
        await session.disconnect();
    });

    it('rejects with UnableToConnect on wrong credentials and stays connected for a retry', async () => {
        const device = new FakeImprovDevice({ correctPassword: 'right' });
        const session = new ImprovBleSession(device.advertisement, fastPoll);
        await session.connect();

        await expect(session.provision('MyWifi', 'wrong')).rejects.toMatchObject({
            name: 'ImprovDeviceError',
            code: ImprovErrorState.UnableToConnect,
        });
        expect(session.isConnected).toBe(true);
        expect(session.currentState).toBe(ImprovState.Authorized);

        // Same connection, correct password now succeeds
        const urls = await session.provision('MyWifi', 'right');
        expect(urls.length).toBeGreaterThan(0);
        await session.disconnect();
    });

    it('waits for on-device authorization before sending credentials', async () => {
        const device = new FakeImprovDevice({ requireAuthorization: true, correctPassword: 'pw' });
        const session = new ImprovBleSession(device.advertisement, fastPoll);
        const info = await session.connect();
        expect(info.state).toBe(ImprovState.AwaitingAuthorization);

        setTimeout(() => device.pressButton(), 40);
        const urls = await session.provision('MyWifi', 'pw', { authorizationTimeoutMs: 2000 });
        expect(urls.length).toBeGreaterThan(0);
        await session.disconnect();
    });

    it('times out when authorization never happens', async () => {
        const device = new FakeImprovDevice({ requireAuthorization: true });
        const session = new ImprovBleSession(device.advertisement, fastPoll);
        await session.connect();

        await expect(session.provision('MyWifi', 'pw', { authorizationTimeoutMs: 80 }))
            .rejects.toBeInstanceOf(ImprovTimeoutError);
        await session.disconnect();
    });

    it('provisions via polling when notifications are unavailable', async () => {
        const device = new FakeImprovDevice({ notificationMode: 'missing', correctPassword: 'pw', urls: ['http://10.0.0.7'] });
        const session = new ImprovBleSession(device.advertisement, fastPoll);
        await session.connect();

        // No notifications: the RPC result must be read back from the characteristic
        const urls = await session.provision('MyWifi', 'pw');
        expect(urls).toEqual(['http://10.0.0.7']);
        await session.disconnect();
    });

    it('provisions via polling when subscribing to notifications throws', async () => {
        const device = new FakeImprovDevice({ notificationMode: 'throw', correctPassword: 'pw' });
        const session = new ImprovBleSession(device.advertisement, fastPoll);
        await session.connect();

        const urls = await session.provision('MyWifi', 'pw');
        expect(urls.length).toBeGreaterThan(0);
        await session.disconnect();
    });

    it('sends an identify command', async () => {
        const device = new FakeImprovDevice({ capabilities: 1 });
        const session = new ImprovBleSession(device.advertisement, fastPoll);
        await session.connect();
        await session.identify();
        expect(device.identifyCount).toBe(1);
        await session.disconnect();
    });

    it('disconnect unsubscribes and is idempotent', async () => {
        const device = new FakeImprovDevice({});
        const session = new ImprovBleSession(device.advertisement, fastPoll);
        await session.connect();
        await session.disconnect();
        await session.disconnect();
        expect(device.connected).toBe(false);
        expect(device.stateChar.unsubscribed).toBe(true);
        await expect(session.provision('x', 'y')).rejects.toThrow(/Not connected/);
    });

    it('refuses to provision an already-provisioned device', async () => {
        const device = new FakeImprovDevice({ initialState: ImprovState.Provisioned });
        const session = new ImprovBleSession(device.advertisement, fastPoll);
        const info = await session.connect();
        expect(info.state).toBe(ImprovState.Provisioned);

        await expect(session.provision('MyWifi', 'pw')).rejects.toThrow(/not ready/);
        await session.disconnect();
    });
});
