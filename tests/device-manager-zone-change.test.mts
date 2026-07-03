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
});
