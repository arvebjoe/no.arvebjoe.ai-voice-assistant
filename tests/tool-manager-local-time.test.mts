import { describe, it, expect, beforeEach } from 'vitest';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { JobManager } from '../src/helpers/job-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';
import { MockWeatherHelper } from './mocks/mock-weather-helper.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';

describe('ToolManager get_local_time with GeoHelper', () => {
    let mockHomey: MockHomey;
    let mockDeviceManager: MockDeviceManager;
    let mockGeoHelper: MockGeoHelper;
    let mockWeatherHelper: MockWeatherHelper;
    let mockJobManager: JobManager;
    let toolManager: ToolManager;

    beforeEach(async () => {
        // Reset the singleton settings manager
        settingsManager.reset();
        
        mockHomey = new MockHomey();
        mockDeviceManager = new MockDeviceManager();
        mockGeoHelper = new MockGeoHelper();
        mockWeatherHelper = new MockWeatherHelper();
        mockJobManager = new JobManager(mockGeoHelper as any);
        
        await mockDeviceManager.init();
        await mockDeviceManager.fetchData();
        await mockGeoHelper.init();
        await mockWeatherHelper.init();
        
        // Initialize settings manager with fresh mock homey
        settingsManager.init(mockHomey);
        
        toolManager = new ToolManager(mockHomey, 'Office', mockDeviceManager as any, mockGeoHelper as any, mockWeatherHelper as any, mockJobManager);
    });

    it('should get local time using GeoHelper timezone and SettingsManager locale', () => {
        // Set up mock data
        mockGeoHelper.setMockTimezone('Europe/Stockholm');
        mockHomey.setMockSetting('selected_language_code', 'sv'); // Swedish

        const handlers = toolManager.getToolHandlers();
        const result = handlers.get_local_time({});

        expect(result.ok).toBe(true);
        expect(result.data.timezone).toBe('Europe/Stockholm');
        expect(result.data.locale).toBe('sv-SE'); // Should be mapped from 'sv' to 'sv-SE'
        expect(result.data.iso).toBeDefined();
        expect(result.data.formatted).toBeDefined();
        expect(result.data.location).toBeDefined();
        
        // The formatted time should be in Swedish
        expect(typeof result.data.formatted).toBe('string');
        expect(result.data.formatted.length).toBeGreaterThan(0);
    });

    it('should handle different language codes correctly', () => {
        // Test Norwegian
        mockGeoHelper.setMockTimezone('Europe/Oslo');
        mockHomey.setMockSetting('selected_language_code', 'no');

        const handlers = toolManager.getToolHandlers();
        const result = handlers.get_local_time({});

        expect(result.ok).toBe(true);
        expect(result.data.timezone).toBe('Europe/Oslo');
        expect(result.data.locale).toBe('nb-NO'); // Norwegian Bokmål
        expect(result.data.location).toContain('59.9139, 10.7522'); // Default mock location
    });

    it('should fallback to defaults when GeoHelper has no timezone', () => {
        mockGeoHelper.clearTimezone();
        mockHomey.setMockSetting('selected_language_code', 'en');

        const handlers = toolManager.getToolHandlers();
        const result = handlers.get_local_time({});

        expect(result.ok).toBe(true);
        expect(result.data.timezone).toBe('Europe/Oslo'); // Default fallback
        expect(result.data.locale).toBe('en-US');
    });

    it('should include location information in response', () => {
        mockGeoHelper.setMockLocation(55.6761, 12.5683); // Copenhagen
        mockGeoHelper.setMockTimezone('Europe/Copenhagen');
        mockHomey.setMockSetting('selected_language_code', 'da'); // Danish

        const handlers = toolManager.getToolHandlers();
        const result = handlers.get_local_time({});

        expect(result.ok).toBe(true);
        expect(result.data.location).toBe('55.6761, 12.5683 (Europe/Copenhagen)');
        expect(result.data.locale).toBe('da-DK');
    });

    it('should handle formatting errors gracefully', () => {
        // Set an invalid timezone to trigger an error
        mockGeoHelper.setMockTimezone('Invalid/Timezone');
        
        const handlers = toolManager.getToolHandlers();
        const result = handlers.get_local_time({});

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('TIME_FORMAT_ERROR');
        expect(result.error.message).toContain('Invalid/Timezone');
    });

    it('should have no required parameters', () => {
        const toolDef = toolManager.getToolDefinition('get_local_time');
        
        expect(toolDef).toBeDefined();
        expect(toolDef!.parameters.required).toEqual([]);
        expect(Object.keys(toolDef!.parameters.properties)).toEqual([]);
        expect(toolDef!.description).toContain('No parameters needed');
    });
});