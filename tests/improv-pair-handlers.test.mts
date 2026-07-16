import { describe, it, expect } from 'vitest';
import { registerImprovPairHandlers, PairSessionLike } from '../src/ble/improv-pair-handlers.mjs';
import { ImprovState } from '../src/ble/improv-ble-client.mjs';
import { FakeBleManager, FakeImprovDevice } from './mocks/mock-improv-ble.mjs';

/** Minimal stand-in for Homey's PairSession socket. */
class FakePairSession implements PairSessionLike {
    handlers = new Map<string, (data?: any) => Promise<any>>();
    emitted: { event: string; data: any }[] = [];

    setHandler(event: string, handler: (data?: any) => Promise<any>) {
        this.handlers.set(event, handler);
        return this;
    }

    async emit(event: string, data?: any): Promise<any> {
        this.emitted.push({ event, data });
    }

    /** Simulate the pair view calling Homey.emit(event, data). */
    async invoke(event: string, data?: any): Promise<any> {
        const handler = this.handlers.get(event);
        if (!handler) throw new Error(`no handler for ${event}`);
        return handler(data);
    }
}

function setup(devices: FakeImprovDevice[], options: { correctPassword?: string } = {}) {
    const session = new FakePairSession();
    const ble = new FakeBleManager(devices.map((d) => d.advertisement));
    const controller = registerImprovPairHandlers({
        session,
        ble,
        sessionOptions: { pollIntervalMs: 15 },
        provisionOptions: { authorizationTimeoutMs: 500, provisioningTimeoutMs: 2000 },
    });
    return { session, ble, controller };
}

describe('registerImprovPairHandlers', () => {
    it('registers all wizard handlers', () => {
        const { session } = setup([]);
        for (const event of ['improv_scan', 'improv_connect', 'improv_provision', 'improv_identify', 'improv_disconnect', 'showView']) {
            expect(session.handlers.has(event), event).toBe(true);
        }
    });

    it('scan returns plain view-safe data', async () => {
        const device = new FakeImprovDevice({ capabilities: 1 });
        const { session } = setup([device]);

        const res = await session.invoke('improv_scan');
        expect(res.ok).toBe(true);
        expect(res.devices).toHaveLength(1);
        const entry = res.devices[0];
        expect(entry).toEqual({
            id: device.advertisement.uuid,
            name: device.advertisement.localName,
            address: device.advertisement.address,
            rssi: device.advertisement.rssi,
            state: ImprovState.Authorized,
        });
        expect(entry.advertisement).toBeUndefined();
    });

    it('connect requires a preceding scan and a known id', async () => {
        const device = new FakeImprovDevice({});
        const { session } = setup([device]);

        const before = await session.invoke('improv_connect', { id: device.advertisement.uuid });
        expect(before).toMatchObject({ ok: false, code: 'device_not_found' });

        await session.invoke('improv_scan');
        const unknown = await session.invoke('improv_connect', { id: 'nope' });
        expect(unknown).toMatchObject({ ok: false, code: 'device_not_found' });

        const ok = await session.invoke('improv_connect', { id: device.advertisement.uuid });
        expect(ok).toMatchObject({ ok: true, state: ImprovState.Authorized, alreadyProvisioned: false });
    });

    it('runs the full happy path and closes the BLE connection afterwards', async () => {
        const device = new FakeImprovDevice({ correctPassword: 'pw', urls: ['http://192.168.1.42'] });
        const { session } = setup([device]);

        await session.invoke('improv_scan');
        await session.invoke('improv_connect', { id: device.advertisement.uuid });
        const res = await session.invoke('improv_provision', { ssid: 'MyWifi', password: 'pw' });

        expect(res).toEqual({ ok: true, urls: ['http://192.168.1.42'] });
        expect(device.connected).toBe(false);
        // Live progress was forwarded to the view
        expect(session.emitted.some((e) => e.event === 'improv_status' && e.data.state === ImprovState.Provisioning)).toBe(true);
    });

    it('reports alreadyProvisioned for a device that is on Wi-Fi', async () => {
        const device = new FakeImprovDevice({ initialState: ImprovState.Provisioned });
        const { session } = setup([device]);

        await session.invoke('improv_scan');
        const res = await session.invoke('improv_connect', { id: device.advertisement.uuid });
        expect(res).toMatchObject({ ok: true, alreadyProvisioned: true });
    });

    it('maps wrong credentials to unable_to_connect and keeps the connection for a retry', async () => {
        const device = new FakeImprovDevice({ correctPassword: 'right' });
        const { session } = setup([device]);

        await session.invoke('improv_scan');
        await session.invoke('improv_connect', { id: device.advertisement.uuid });

        const bad = await session.invoke('improv_provision', { ssid: 'MyWifi', password: 'wrong' });
        expect(bad).toMatchObject({ ok: false, code: 'unable_to_connect' });
        expect(device.connected).toBe(true);

        const good = await session.invoke('improv_provision', { ssid: 'MyWifi', password: 'right' });
        expect(good.ok).toBe(true);
    });

    it('maps a never-pressed authorizer button to authorization_timeout', async () => {
        const device = new FakeImprovDevice({ requireAuthorization: true });
        const { session } = setup([device]);

        await session.invoke('improv_scan');
        await session.invoke('improv_connect', { id: device.advertisement.uuid });
        const res = await session.invoke('improv_provision', { ssid: 'MyWifi', password: 'pw' });
        expect(res).toMatchObject({ ok: false, code: 'authorization_timeout' });
    });

    it('validates input before touching the device', async () => {
        const device = new FakeImprovDevice({});
        const { session } = setup([device]);

        expect(await session.invoke('improv_provision', { ssid: '   ' })).toMatchObject({ ok: false, code: 'invalid_input' });
        expect(await session.invoke('improv_provision', { ssid: 'net' })).toMatchObject({ ok: false, code: 'device_not_found' });
    });

    it('disconnects BLE when the user navigates away from the wizard', async () => {
        const device = new FakeImprovDevice({});
        const { session } = setup([device]);

        await session.invoke('improv_scan');
        await session.invoke('improv_connect', { id: device.advertisement.uuid });
        expect(device.connected).toBe(true);

        await session.invoke('showView', 'improv_setup');
        expect(device.connected).toBe(true);

        await session.invoke('showView', 'list_devices');
        expect(device.connected).toBe(false);
    });

    it('forwards identify to the connected device', async () => {
        const device = new FakeImprovDevice({ capabilities: 1 });
        const { session } = setup([device]);

        await session.invoke('improv_scan');
        await session.invoke('improv_connect', { id: device.advertisement.uuid });
        const res = await session.invoke('improv_identify');
        expect(res.ok).toBe(true);
        expect(device.identifyCount).toBe(1);
    });

    it('dispose closes the connection and is idempotent', async () => {
        const device = new FakeImprovDevice({});
        const { session, controller } = setup([device]);

        await session.invoke('improv_scan');
        await session.invoke('improv_connect', { id: device.advertisement.uuid });
        expect(device.connected).toBe(true);

        await controller.dispose();
        await controller.dispose();
        expect(device.connected).toBe(false);
    });

    it('a rescan drops any half-finished connection first', async () => {
        const device = new FakeImprovDevice({});
        const { session } = setup([device]);

        await session.invoke('improv_scan');
        await session.invoke('improv_connect', { id: device.advertisement.uuid });
        expect(device.connected).toBe(true);

        await session.invoke('improv_scan');
        expect(device.connected).toBe(false);
    });
});
