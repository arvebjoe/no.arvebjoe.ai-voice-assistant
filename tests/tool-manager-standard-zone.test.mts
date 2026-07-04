import { describe, it, expect, beforeEach } from 'vitest';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';
import { MockWeatherHelper } from './mocks/mock-weather-helper.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';

describe('ToolManager standard zone', () => {
    let toolManager: ToolManager;

    beforeEach(async () => {
        settingsManager.reset();
        const mockHomey = new MockHomey();
        const mockDeviceManager = new MockDeviceManager();
        const mockGeoHelper = new MockGeoHelper();
        const mockWeatherHelper = new MockWeatherHelper();
        await mockDeviceManager.init();
        await mockDeviceManager.fetchData();
        await mockGeoHelper.init();
        await mockWeatherHelper.init();
        settingsManager.init(mockHomey);
        toolManager = new ToolManager(mockHomey, 'Office', mockDeviceManager as any, mockGeoHelper as any, mockWeatherHelper as any);
    });

    it('reports the zone it was constructed with', () => {
        expect(toolManager.getStandardZone()).toBe('Office');
    });

    it('updates the standard zone when the device moves (H-h)', () => {
        toolManager.setStandardZone('Bedroom');
        expect(toolManager.getStandardZone()).toBe('Bedroom');
    });

    it('ignores empty or unchanged zones', () => {
        toolManager.setStandardZone('');
        expect(toolManager.getStandardZone()).toBe('Office');
        toolManager.setStandardZone('Office');
        expect(toolManager.getStandardZone()).toBe('Office');
    });
});
