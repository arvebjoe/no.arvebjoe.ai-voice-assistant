import { WebServer } from './webserver.mjs';
import { DeviceManager } from './device-manager.mjs';
import { GeoHelper } from './geo-helper.mjs';
import { WeatherHelper } from './weather-helper.mjs';

/**
 * The shared services the app constructs in onInit and devices consume.
 * `AiVoiceAssistantApp` implements this, so the compiler enforces the contract
 * on the producing side; `getAppServices()` is the single, guarded consuming
 * side (replacing the untyped `(this.homey as any).app.*` reaches).
 */
export interface AppServices {
    webServer: WebServer;
    deviceManager: DeviceManager;
    geoHelper: GeoHelper;
    weatherHelper: WeatherHelper;
}

const SERVICE_KEYS = ['webServer', 'deviceManager', 'geoHelper', 'weatherHelper'] as const;

/**
 * Resolve the app singleton's services from a `homey` instance. The SDK doesn't
 * type `homey.app`, so the one unavoidable cast lives here — behind a runtime
 * check that fails fast with a clear message if a service isn't constructed
 * yet, instead of an undefined-property crash somewhere downstream.
 */
export function getAppServices(homey: any): AppServices {
    const app = homey?.app as Partial<AppServices> | undefined;
    const missing = SERVICE_KEYS.filter((key) => !app?.[key]);
    if (!app || missing.length > 0) {
        throw new Error(`App services not available (missing: ${missing.join(', ') || 'app'}) — device initialized before the app finished onInit?`);
    }
    return app as AppServices;
}
