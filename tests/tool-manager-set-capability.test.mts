import { describe, it, expect, beforeEach } from 'vitest';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';
import { MockWeatherHelper } from './mocks/mock-weather-helper.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';

// S2/S3 gates on set_device_capability, driven through the real handler with
// the mock DeviceManager (standard zone = Office; mock data has 4 zones).
describe('ToolManager set_device_capability safety gates', () => {
    let toolManager: ToolManager;
    let deviceManager: MockDeviceManager;
    let setCapability: (args: any) => Promise<any>;

    // Reads the capability value the mock recorded for a device, e.g. 'onoff=true'.
    function capOf(deviceId: string, capabilityId: string): string | undefined {
        const page = deviceManager.getSmartHomeDevices();
        const dev = page.devices.find(d => d.id === deviceId);
        return dev?.capabilities.find(c => c.startsWith(`${capabilityId}=`));
    }

    beforeEach(async () => {
        settingsManager.reset();
        const mockHomey = new MockHomey();
        deviceManager = new MockDeviceManager();
        const mockGeoHelper = new MockGeoHelper();
        const mockWeatherHelper = new MockWeatherHelper();
        await deviceManager.init();
        await deviceManager.fetchData();
        await mockGeoHelper.init();
        await mockWeatherHelper.init();
        settingsManager.init(mockHomey);
        toolManager = new ToolManager(mockHomey, 'Office', deviceManager as any, mockGeoHelper as any, mockWeatherHelper as any);
        setCapability = toolManager.getToolHandlers()['set_device_capability'];
    });

    /* ---------- S3: capability whitelist + value coercion ---------- */

    it('S3 — rejects a non-whitelisted capability', async () => {
        const res = await setCapability({ deviceIds: ['device-12'], capabilityId: 'speaker_playing', newValue: true });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe('INVALID_CAPABILITY_WRITE');
        expect(capOf('device-12', 'speaker_playing')).toBeUndefined();
    });

    it('S3 — rejects a non-boolean onoff value', async () => {
        const res = await setCapability({ deviceIds: ['device-12'], capabilityId: 'onoff', newValue: 1 });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe('INVALID_CAPABILITY_WRITE');
    });

    it('S3 — recovers a percentage dim value and clamps to [0,1]', async () => {
        // 50 is a percentage the model forgot to divide -> 0.5.
        let res = await setCapability({ deviceIds: ['device-12'], capabilityId: 'dim', newValue: 50 });
        expect(res.ok).toBe(true);
        expect(capOf('device-12', 'dim')).toBe('dim=0.5');

        // Negative clamps to 0.
        res = await setCapability({ deviceIds: ['device-12'], capabilityId: 'dim', newValue: -0.3 });
        expect(res.ok).toBe(true);
        expect(capOf('device-12', 'dim')).toBe('dim=0');
    });

    it('S3 — clamps target_temperature to 5-35 °C', async () => {
        let res = await setCapability({ deviceIds: ['device-13'], capabilityId: 'target_temperature', newValue: 500 });
        expect(res.ok).toBe(true);
        expect(capOf('device-13', 'target_temperature')).toBe('target_temperature=35');

        res = await setCapability({ deviceIds: ['device-13'], capabilityId: 'target_temperature', newValue: -10 });
        expect(res.ok).toBe(true);
        expect(capOf('device-13', 'target_temperature')).toBe('target_temperature=5');
    });

    /* ---------- S2: cross-zone containment ---------- */

    it('S2 — filters out-of-zone devices and reports how many were blocked', async () => {
        // device-12 is in Office (standard zone), device-5 in Kitchen.
        const res = await setCapability({ deviceIds: ['device-12', 'device-5'], capabilityId: 'onoff', newValue: false });
        expect(res.ok).toBe(true);
        expect(res.meta.cross_zone_blocked).toBe(1);
        expect(capOf('device-12', 'onoff')).toBe('onoff=false'); // Office switched
        expect(capOf('device-5', 'onoff')).toBe('onoff=true');   // Kitchen untouched
    });

    it('S2 — rejects with CROSS_ZONE_BLOCKED when every device is out of zone', async () => {
        const res = await setCapability({ deviceIds: ['device-5', 'device-8'], capabilityId: 'onoff', newValue: false });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe('CROSS_ZONE_BLOCKED');
        expect(capOf('device-5', 'onoff')).toBe('onoff=true');
        expect(capOf('device-8', 'onoff')).toBe('onoff=false'); // was already false, and untouched
    });

    it('S2 — allow_cross_zone=true permits a whole-house write', async () => {
        const res = await setCapability({ deviceIds: ['device-12', 'device-5'], capabilityId: 'onoff', newValue: false, allow_cross_zone: true });
        expect(res.ok).toBe(true);
        expect(res.meta.cross_zone_blocked).toBe(0);
        expect(capOf('device-5', 'onoff')).toBe('onoff=false');
    });

    it('S2 — a user-named expected_zone is not cross-zone', async () => {
        // The user named Kitchen; the write is confined to Kitchen by the
        // narrowing filter and needs no allow_cross_zone.
        const res = await setCapability({ deviceIds: ['device-5', 'device-12'], capabilityId: 'onoff', newValue: false, expected_zone: 'Kitchen' });
        expect(res.ok).toBe(true);
        expect(capOf('device-5', 'onoff')).toBe('onoff=false');  // Kitchen switched
        expect(capOf('device-12', 'onoff')).toBe('onoff=true');  // Office ID filtered by narrowing
    });

    /* ---------- S3: unlock is single-target ---------- */

    it('S3 — refuses to unlock more than one device per call', async () => {
        // device-12 and device-14 are both in Office, so cross-zone doesn't interfere.
        const res = await setCapability({ deviceIds: ['device-12', 'device-14'], capabilityId: 'locked', newValue: false });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe('UNLOCK_SINGLE_DEVICE_ONLY');
        expect(capOf('device-12', 'locked')).toBeUndefined(); // nothing written
    });

    it('S3 — unlocking a single device works, and bulk LOCKING stays allowed', async () => {
        let res = await setCapability({ deviceIds: ['device-12'], capabilityId: 'locked', newValue: false });
        expect(res.ok).toBe(true);
        expect(capOf('device-12', 'locked')).toBe('locked=false');

        // Locking many at once is fine (securing, not exposing).
        res = await setCapability({ deviceIds: ['device-12', 'device-14'], capabilityId: 'locked', newValue: true });
        expect(res.ok).toBe(true);
        expect(capOf('device-12', 'locked')).toBe('locked=true');
        expect(capOf('device-14', 'locked')).toBe('locked=true');
    });

    /* ---------- existing gate, previously untested ---------- */

    it('requires confirmed=true for more than 10 devices', async () => {
        const ids = Array.from({ length: 11 }, (_, i) => `device-${i + 1}`);
        let res = await setCapability({ deviceIds: ids, capabilityId: 'onoff', newValue: false, allow_cross_zone: true });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe('CONFIRMATION_REQUIRED');

        res = await setCapability({ deviceIds: ids, capabilityId: 'onoff', newValue: false, allow_cross_zone: true, confirmed: true });
        expect(res.ok).toBe(true);
    });
});
