import { describe, it, expect, beforeEach } from 'vitest';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';
import { MockWeatherHelper } from './mocks/mock-weather-helper.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';

const SHOPPING_TOOLS = ['get_shopping_list', 'add_to_shopping_list', 'update_shopping_list_item', 'remove_from_shopping_list'];

async function makeManager(homey: MockHomey): Promise<ToolManager> {
    const deviceManager = new MockDeviceManager();
    const geoHelper = new MockGeoHelper();
    const weatherHelper = new MockWeatherHelper();
    await deviceManager.init();
    await deviceManager.fetchData();
    await geoHelper.init();
    await weatherHelper.init();
    settingsManager.init(homey);
    return new ToolManager(homey, 'Office', deviceManager as any, geoHelper as any, weatherHelper as any);
}

describe('ToolManager Bring! shopping-list gating', () => {
    beforeEach(() => {
        settingsManager.reset();
    });

    it('does not register the shopping tools when the feature is disabled', async () => {
        const homey = new MockHomey();
        const tm = await makeManager(homey);
        expect(tm.isShoppingListActive()).toBe(false);
        for (const name of SHOPPING_TOOLS) expect(tm.hasTool(name)).toBe(false);
    });

    it('does not register the tools when enabled but credentials are missing', async () => {
        const homey = new MockHomey();
        homey.setMockSetting('bring_enabled', true);
        const tm = await makeManager(homey);
        expect(tm.isShoppingListActive()).toBe(false);
        for (const name of SHOPPING_TOOLS) expect(tm.hasTool(name)).toBe(false);
    });

    it('registers the tools when enabled with credentials present', async () => {
        const homey = new MockHomey();
        homey.setMockSetting('bring_enabled', true);
        homey.setMockSetting('bring_email', 'user@example.com');
        homey.setMockSetting('bring_password', 'secret');
        const tm = await makeManager(homey);
        expect(tm.isShoppingListActive()).toBe(true);
        for (const name of SHOPPING_TOOLS) expect(tm.hasTool(name)).toBe(true);
    });

    it('adds and removes the tools as the setting flips at runtime', async () => {
        const homey = new MockHomey();
        homey.setMockSetting('bring_email', 'user@example.com');
        homey.setMockSetting('bring_password', 'secret');
        const tm = await makeManager(homey);
        expect(tm.isShoppingListActive()).toBe(false);

        homey.setMockSetting('bring_enabled', true);
        expect(tm.refreshShoppingListTools()).toBe(true);
        expect(tm.hasTool('get_shopping_list')).toBe(true);

        homey.setMockSetting('bring_enabled', false);
        expect(tm.refreshShoppingListTools()).toBe(false);
        expect(tm.hasTool('get_shopping_list')).toBe(false);
    });

    it('accepts the string "true" from the settings store', async () => {
        const homey = new MockHomey();
        homey.setMockSetting('bring_enabled', 'true');
        homey.setMockSetting('bring_email', 'user@example.com');
        homey.setMockSetting('bring_password', 'secret');
        const tm = await makeManager(homey);
        expect(tm.isShoppingListActive()).toBe(true);
    });
});
