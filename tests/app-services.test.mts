import { describe, it, expect } from 'vitest';
import { getAppServices } from '../src/helpers/app-services.mjs';

// The single typed accessor replacing the `(this.homey as any).app.*` reaches:
// passes through a fully-populated app, fails fast (with the missing names)
// on a partial or absent one.
describe('getAppServices', () => {
    const services = {
        webServer: { buildStream: async () => ({}) },
        deviceManager: { registerDevice: () => 'Office' },
        geoHelper: { hasLocation: () => true },
        weatherHelper: {},
    };

    it('returns the app services when all are present', () => {
        const got = getAppServices({ app: services });
        expect(got.webServer).toBe(services.webServer);
        expect(got.deviceManager).toBe(services.deviceManager);
        expect(got.geoHelper).toBe(services.geoHelper);
        expect(got.weatherHelper).toBe(services.weatherHelper);
    });

    it('throws naming the missing services', () => {
        const partial: any = { ...services };
        delete partial.deviceManager;
        delete partial.weatherHelper;
        expect(() => getAppServices({ app: partial }))
            .toThrow(/missing: deviceManager, weatherHelper/);
    });

    it('throws when there is no app at all', () => {
        expect(() => getAppServices({})).toThrow(/App services not available/);
        expect(() => getAppServices(undefined)).toThrow(/App services not available/);
    });
});
