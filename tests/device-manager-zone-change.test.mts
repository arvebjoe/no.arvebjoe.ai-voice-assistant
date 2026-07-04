import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeviceManager } from '../src/helpers/device-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

// Minimal fake ApiHelper that lets us capture the 'device.update' handler and
// drive it directly — this exercises the REAL DeviceManager zone-change logic
// (previously only the mock was tested).
function makeFakeApi() {
    let updateHandler: ((updated: any) => void) | null = null;
    return {
        captured: () => updateHandler,
        devices: {
            on: (event: string, handler: (u: any) => void) => {
                if (event === 'device.update') updateHandler = handler;
            },
            getDevices: async () => ({
                dev1: {
                    id: 'dev1',
                    name: 'Voice PE',
                    zone: 'zoneOffice',
                    capabilities: ['onoff'],
                    capabilitiesObj: { onoff: { value: true } },
                    class: 'speaker',
                    data: { id: 'AA:BB:CC' },
                },
            }),
            setCapabilityValue: async () => undefined,
        },
        zones: {
            getZones: async () => ({
                zoneOffice: { name: 'Office', parent: null },
                zoneBedroom: { name: 'Bedroom', parent: null },
            }),
        },
    };
}

describe('DeviceManager zone-change callback', () => {
    let dm: DeviceManager;
    let api: ReturnType<typeof makeFakeApi>;

    beforeEach(async () => {
        api = makeFakeApi();
        dm = new DeviceManager(new MockHomey() as any, api as any);
        await dm.init();       // registers the device.update handler
        await dm.fetchData();  // populates devices + zones
    });

    it('fires once on a real zone move and returns the initial zone', () => {
        const cb = vi.fn();
        const initialZone = dm.registerDevice('AA:BB:CC', cb);
        expect(initialZone).toBe('Office');

        api.captured()!({ id: 'dev1', zone: 'zoneBedroom' });

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0][0]).toMatchObject({ oldZone: 'Office', newZone: 'Bedroom' });
    });

    it('does NOT re-fire on subsequent updates with the same zone (H-h storm fix)', () => {
        const cb = vi.fn();
        dm.registerDevice('AA:BB:CC', cb);

        api.captured()!({ id: 'dev1', zone: 'zoneBedroom' }); // real move -> fire
        api.captured()!({ id: 'dev1', zone: 'zoneBedroom' }); // e.g. a capability update -> must NOT fire
        api.captured()!({ id: 'dev1', zone: 'zoneBedroom' });

        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('fires again when the device actually moves back', () => {
        const cb = vi.fn();
        dm.registerDevice('AA:BB:CC', cb);

        api.captured()!({ id: 'dev1', zone: 'zoneBedroom' }); // -> Bedroom
        api.captured()!({ id: 'dev1', zone: 'zoneOffice' });  // -> Office again

        expect(cb).toHaveBeenCalledTimes(2);
        expect(cb.mock.calls[1][0]).toMatchObject({ oldZone: 'Bedroom', newZone: 'Office' });
    });

    it('ignores updates for unregistered devices and unknown zones', () => {
        const cb = vi.fn();
        dm.registerDevice('AA:BB:CC', cb);

        api.captured()!({ id: 'other-device', zone: 'zoneBedroom' }); // not registered
        api.captured()!({ id: 'dev1', zone: 'zoneGhost' });           // unknown zone

        expect(cb).not.toHaveBeenCalled();
    });

    it('stops firing after unregister', () => {
        const cb = vi.fn();
        dm.registerDevice('AA:BB:CC', cb);
        dm.unRegisterDevice('AA:BB:CC');

        api.captured()!({ id: 'dev1', zone: 'zoneBedroom' });

        expect(cb).not.toHaveBeenCalled();
    });

    /* ---------- Org 3: MAC-keyed subscriptions, device resolved fresh ---------- */

    it('Org3 — the subscription survives a fetchData() rebuild of the catalog', async () => {
        const cb = vi.fn();
        dm.registerDevice('AA:BB:CC', cb);

        // Re-fetch: every Device object in the catalog is rebuilt. A subscription
        // holding a captured object reference would now be pointing at a corpse.
        await dm.fetchData();

        api.captured()!({ id: 'dev1', zone: 'zoneBedroom' });
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0][0]).toMatchObject({ oldZone: 'Office', newZone: 'Bedroom' });

        // And the rebuilt catalog entry was synced, so queries report the new zone.
        const office = dm.getSmartHomeDevices('Office');
        const bedroom = dm.getSmartHomeDevices('Bedroom');
        expect(office.devices).toHaveLength(0);
        expect(bedroom.devices.map(d => d.id)).toContain('dev1');
    });

    it('Org3 — registering before the catalog is loaded still subscribes (zone resolves on first update)', async () => {
        // Fresh manager: init but NO fetchData yet — the boot-order race.
        const freshApi = makeFakeApi();
        const freshDm = new DeviceManager(new MockHomey() as any, freshApi as any);
        await freshDm.init();

        const cb = vi.fn();
        const initialZone = freshDm.registerDevice('AA:BB:CC', cb);
        expect(initialZone).toBe('<Unknown Zone>'); // catalog empty at registration

        // Catalog arrives, then the device reports in. Previously registerDevice
        // silently never subscribed, so this device could never see zone changes.
        await freshDm.fetchData();
        freshApi.captured()!({ id: 'dev1', zone: 'zoneOffice', data: { id: 'AA:BB:CC' } });

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0][0]).toMatchObject({ oldZone: '<Unknown Zone>', newZone: 'Office' });
    });

    it('Org3 — resolves the subscription from the event MAC even when the device is not in the catalog', () => {
        const cb = vi.fn();
        dm.registerDevice('AA:BB:CC', cb);

        // Event carries data.id but a device id the catalog does not know (e.g.
        // re-added to Homey with a new id since the last fetch).
        api.captured()!({ id: 'brand-new-id', name: 'Voice PE', zone: 'zoneBedroom', data: { id: 'AA:BB:CC' } });

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0][0]).toMatchObject({ oldZone: 'Office', newZone: 'Bedroom' });
        expect(cb.mock.calls[0][0].device.name).toBe('Voice PE');
    });
});
