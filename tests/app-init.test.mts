import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Fake only the true externals; the app's own helpers run for real.
vi.mock('homey', () => import('./mocks/mock-homey-sdk.mjs'));
vi.mock('homey-log', () => ({ default: { Log: class { constructor(_opts: any) { } } } }));
vi.mock('homey-api', () => ({
    HomeyAPI: {
        createAppAPI: async (_opts: any) => ({
            devices: {
                connect: vi.fn(async () => { }),
                on: vi.fn(),
                getDevices: vi.fn(async () => ({})),
            },
            zones: {
                getZones: vi.fn(async () => ({})),
            },
        }),
    },
}));
vi.mock('../src/helpers/file-helper.mjs', async (importOriginal) => ({
    ...(await importOriginal() as object),
    initAudioFolder: vi.fn(async () => { }), // don't touch /userdata in tests
}));

import AiVoiceAssistantApp from '../app.mjs';
import { getAppServices } from '../src/helpers/app-services.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

// Boots the REAL app onInit: real GeoHelper (no geolocation -> warns, stays
// uninitialized), real WeatherHelper, real WebServer, real DeviceManager over
// the faked homey-api. Verifies the producer side of the AppServices contract.
describe('AiVoiceAssistantApp.onInit', () => {
    let homey: any;
    let app: AiVoiceAssistantApp;
    // setupGlobalErrorHandling registers real process handlers — track and
    // remove them so they can't leak into other tests.
    const handlersBefore: Record<string, Function[]> = {};
    const EVENTS = ['uncaughtException', 'unhandledRejection', 'warning'] as const;

    beforeEach(() => {
        settingsManager.reset();
        homey = new MockHomey();
        for (const e of EVENTS) handlersBefore[e] = process.listeners(e as any);
        app = new (AiVoiceAssistantApp as any)({ homey });
    });

    afterEach(() => {
        for (const e of EVENTS) {
            for (const l of process.listeners(e as any)) {
                if (!handlersBefore[e].includes(l)) process.removeListener(e as any, l as any);
            }
        }
    });

    it('assigns all AppServices fields — getAppServices() accepts the booted app', async () => {
        await app.onInit();

        // The consumer-side accessor must accept exactly what onInit produced.
        const services = getAppServices({ app });
        expect(services.webServer).toBe(app.webServer);
        expect(services.deviceManager).toBe(app.deviceManager);
        expect(services.geoHelper).toBe(app.geoHelper);
        expect(services.weatherHelper).toBe(app.weatherHelper);
    });

    it('wires the dependency graph: weather gets the geo instance, deviceManager gets the apiHelper', async () => {
        await app.onInit();

        expect((app.weatherHelper as any).geoHelper).toBe(app.geoHelper);
        expect((app.deviceManager as any).apiHelper).toBe((app as any).apiHelper);
        // fetchData ran against the (fake) API during boot.
        const api = (app as any).apiHelper.devices;
        expect(api.connect).toHaveBeenCalledTimes(1);
        expect(api.getDevices).toHaveBeenCalledTimes(1);
    });

    it('registers the global process error handlers', async () => {
        await app.onInit();
        for (const e of EVENTS) {
            expect(process.listeners(e as any).length).toBeGreaterThan(handlersBefore[e].length);
        }
    });

    it('onUninit stops the web server', async () => {
        await app.onInit();
        const stopSpy = vi.spyOn(app.webServer, 'stop');
        await app.onUninit();
        expect(stopSpy).toHaveBeenCalledTimes(1);
    });
});
