import { describe, it, expect, beforeEach } from 'vitest';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';
import { MockWeatherHelper } from './mocks/mock-weather-helper.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';

describe('ToolManager.execute (Org 2: shared tool execution)', () => {
    let toolManager: ToolManager;

    beforeEach(async () => {
        settingsManager.reset();
        const homey = new MockHomey();
        const deviceManager = new MockDeviceManager();
        const geoHelper = new MockGeoHelper();
        const weatherHelper = new MockWeatherHelper();
        await deviceManager.init();
        await deviceManager.fetchData();
        await geoHelper.init();
        await weatherHelper.init();
        settingsManager.init(homey);
        toolManager = new ToolManager(homey, 'Office', deviceManager as any, geoHelper as any, weatherHelper as any);
    });

    it('runs a registered tool and returns its output with failed=false', async () => {
        toolManager.registerTool({
            type: 'function',
            name: 'echo_tool',
            description: 'echoes',
            parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
            handler: (args: any) => ({ ok: true, got: args.value }),
        } as any);

        const result = await toolManager.execute('echo_tool', { value: 42 });
        expect(result).toEqual({ output: { ok: true, got: 42 }, failed: false });
    });

    it('wraps a throwing handler as a structured error with failed=true', async () => {
        toolManager.registerTool({
            type: 'function',
            name: 'broken_tool',
            description: 'throws',
            parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
            handler: async () => { throw new Error('device unreachable'); },
        } as any);

        const result = await toolManager.execute('broken_tool', {});
        expect(result).toEqual({ output: { error: 'device unreachable' }, failed: true });
    });

    it('returns a structured error for an unknown tool without failing the turn', async () => {
        const result = await toolManager.execute('no_such_tool', {});
        expect(result).toEqual({ output: { error: 'Unknown tool: no_such_tool' }, failed: false });
    });

    it('defaults null/undefined args to an empty object', async () => {
        toolManager.registerTool({
            type: 'function',
            name: 'args_probe',
            description: 'reports its args',
            parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
            handler: (args: any) => ({ argsWasObject: !!args && typeof args === 'object' }),
        } as any);

        const result = await toolManager.execute('args_probe', null);
        expect(result.output).toEqual({ argsWasObject: true });
    });

    it('executes the real registered tools (get_zones) through execute()', async () => {
        const result = await toolManager.execute('get_zones', {});
        expect(result.failed).toBe(false);
        expect(result.output.ok).toBe(true);
    });
});
