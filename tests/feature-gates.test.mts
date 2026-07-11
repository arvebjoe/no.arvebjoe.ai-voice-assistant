import { describe, it, expect, beforeEach } from 'vitest';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { computeFeatureCosts } from '../src/settings/feature-costs.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';
import { MockWeatherHelper } from './mocks/mock-weather-helper.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';

let mockHomey: MockHomey;
let mockDeviceManager: MockDeviceManager;
let mockGeoHelper: MockGeoHelper;
let mockWeatherHelper: MockWeatherHelper;

function makeToolManager(withTimers = false): ToolManager {
    const timerManager = withTimers ? ({} as any) : undefined;
    return new ToolManager(mockHomey, 'Office', mockDeviceManager as any, mockGeoHelper as any, mockWeatherHelper as any, timerManager);
}

function toolNames(tm: ToolManager): string[] {
    return tm.getToolDefinitions().map((d) => d.name);
}

beforeEach(async () => {
    settingsManager.reset();
    mockHomey = new MockHomey();
    mockDeviceManager = new MockDeviceManager();
    mockGeoHelper = new MockGeoHelper();
    mockWeatherHelper = new MockWeatherHelper();
    await mockDeviceManager.init();
    await mockDeviceManager.fetchData();
    await mockGeoHelper.init();
    await mockWeatherHelper.init();
    settingsManager.init(mockHomey);
});

describe('feature gates (weather / web search / timers)', () => {
    it('defaults: weather + web search on, timer tools follow the TimerManager', () => {
        const tm = makeToolManager(true);
        const names = toolNames(tm);
        expect(names).toContain('get_current_weather');
        expect(names).toContain('web_search');
        expect(names).toContain('set_timer');
        expect(tm.isWeatherActive()).toBe(true);
        expect(tm.isWebSearchActive()).toBe(true);
        expect(tm.areTimerToolsActive()).toBe(true);
    });

    it('weather_enabled=false removes all five weather tools', () => {
        mockHomey.setMockSetting('weather_enabled', false);
        settingsManager.refreshGlobals();
        const tm = makeToolManager();
        const names = toolNames(tm);
        for (const n of ['get_current_weather', 'get_weather_forecast', 'will_it_rain', 'get_weather_summary', 'get_outside_illumination']) {
            expect(names).not.toContain(n);
        }
        expect(tm.isWeatherActive()).toBe(false);
    });

    it('web_search_provider=disabled removes the web_search tool entirely', () => {
        mockHomey.setMockSetting('web_search_provider', 'disabled');
        settingsManager.refreshGlobals();
        const tm = makeToolManager();
        expect(toolNames(tm)).not.toContain('web_search');
        expect(tm.isWebSearchActive()).toBe(false);
    });

    it('timers_enabled=false removes the timer tools even with a TimerManager', () => {
        mockHomey.setMockSetting('timers_enabled', false);
        settingsManager.refreshGlobals();
        const tm = makeToolManager(true);
        for (const n of ['set_timer', 'cancel_timer', 'get_timer']) {
            expect(toolNames(tm)).not.toContain(n);
        }
        expect(tm.areTimerToolsActive()).toBe(false);
    });

    it('refresh methods reconcile with changed settings and report the flip', () => {
        const tm = makeToolManager(true);
        mockHomey.setMockSetting('weather_enabled', 'false');
        mockHomey.setMockSetting('web_search_provider', 'disabled');
        mockHomey.setMockSetting('timers_enabled', 'false');
        settingsManager.refreshGlobals();

        expect(tm.refreshWeatherTools()).toBe(false);
        expect(tm.refreshWebSearchTools()).toBe(false);
        expect(tm.refreshTimerTools()).toBe(false);
        const names = toolNames(tm);
        expect(names).not.toContain('get_current_weather');
        expect(names).not.toContain('web_search');
        expect(names).not.toContain('set_timer');

        mockHomey.setMockSetting('weather_enabled', 'true');
        settingsManager.refreshGlobals();
        expect(tm.refreshWeatherTools()).toBe(true);
        expect(toolNames(tm)).toContain('get_current_weather');
    });

    it('registerAllToolsForMeasurement registers every optional feature regardless of settings', () => {
        mockHomey.setMockSetting('weather_enabled', false);
        mockHomey.setMockSetting('web_search_provider', 'disabled');
        settingsManager.refreshGlobals();
        const tm = makeToolManager();
        tm.registerAllToolsForMeasurement();
        const names = toolNames(tm);
        for (const feature of Object.values(ToolManager.FEATURE_TOOLS)) {
            for (const n of feature) expect(names).toContain(n);
        }
    });
});

describe('computeFeatureCosts', () => {
    const services = () => ({
        homey: mockHomey,
        deviceManager: mockDeviceManager,
        geoHelper: mockGeoHelper,
        weatherHelper: mockWeatherHelper,
    });

    it('returns all six features with plausible, code-derived token counts', async () => {
        const report = await computeFeatureCosts(services(), 'en', 'English');
        expect(report.features.map((f) => f.id)).toEqual(['smart', 'weather', 'timers', 'shopping', 'music', 'websearch']);
        const byId = Object.fromEntries(report.features.map((f) => [f.id, f]));

        // Base: prompt + core tools, both nonzero and the biggest single block.
        expect(byId.smart.instructions).toBeGreaterThan(500);
        expect(byId.smart.tools).toBeGreaterThan(500);
        // Weather/web search have no instruction block, only tools.
        expect(byId.weather.instructions).toBe(0);
        expect(byId.weather.tools).toBeGreaterThan(100);
        expect(byId.websearch.instructions).toBe(0);
        expect(byId.websearch.tools).toBeGreaterThan(50);
        // Timers/shopping/music carry both.
        for (const id of ['timers', 'shopping', 'music'] as const) {
            expect(byId[id].instructions).toBeGreaterThan(50);
            expect(byId[id].tools).toBeGreaterThan(100);
            expect(byId[id].total).toBe(byId[id].instructions + byId[id].tools);
        }
    });

    it('prices non-Latin languages higher for instructions but not tools', async () => {
        const en = await computeFeatureCosts(services(), 'en', 'English');
        const ru = await computeFeatureCosts(services(), 'ru', 'Russian');
        const enSmart = en.features.find((f) => f.id === 'smart')!;
        const ruSmart = ru.features.find((f) => f.id === 'smart')!;
        expect(ru.charsPerToken).toBeLessThan(en.charsPerToken);
        // Tool JSON is identical (not translated).
        expect(ruSmart.tools).toBe(enSmart.tools);
    });

    it('measures features even when their settings are off', async () => {
        mockHomey.setMockSetting('weather_enabled', false);
        mockHomey.setMockSetting('bring_enabled', false);
        settingsManager.refreshGlobals();
        const report = await computeFeatureCosts(services(), 'en', 'English');
        const byId = Object.fromEntries(report.features.map((f) => [f.id, f]));
        expect(byId.weather.tools).toBeGreaterThan(100);
        expect(byId.shopping.tools).toBeGreaterThan(100);
    });
});
