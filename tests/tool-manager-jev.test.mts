import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';
import { MockWeatherHelper } from './mocks/mock-weather-helper.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';
import { buildRequests, formatRanked } from '../src/llm/jev/jev-device-selector.mjs';

const DEVICE_TOOLS = ['get_zones', 'get_device_types', 'get_devices_in_standard_zone', 'get_devices', 'set_device_capability'];

/**
 * A stand-in for TypeSafe: every Score question about a device named in
 * `wanted` gets the top level, every other one the bottom level. Records the
 * request bodies so tests can inspect what was sent.
 */
function fakeTypeSafe(wanted: string[]) {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        const answers: Record<string, any> = {};
        for (const [id, q] of Object.entries<any>(body.questions)) {
            const levels = q.criteria.length;
            const top = wanted.includes(q.instructions.device.name);
            const legend = Object.fromEntries(q.criteria.map((c: string, i: number) => [String(i), c]));
            answers[id] = { type: 'score', score: top ? levels - 1 : 0, legend, probabilities: {}, confidence: 0.9 };
        }
        return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 10 } }), { status: 200 });
    });
    return { fetchImpl, bodies };
}

async function makeManager(homey: MockHomey) {
    const deviceManager = new MockDeviceManager();
    const geoHelper = new MockGeoHelper();
    const weatherHelper = new MockWeatherHelper();
    await deviceManager.init();
    await deviceManager.fetchData();
    await geoHelper.init();
    await weatherHelper.init();
    settingsManager.init(homey);
    const tm = new ToolManager(homey, 'Office', deviceManager as any, geoHelper as any, weatherHelper as any);
    return { tm, deviceManager };
}

function capOf(dm: MockDeviceManager, name: string, cap: string): string | undefined {
    const dev = dm.getSmartHomeDevices(undefined, undefined, 100).devices.find(d => d.name === name);
    return dev?.capabilities.find(c => c.startsWith(`${cap}=`));
}

describe('ToolManager Jev gating', () => {
    beforeEach(() => settingsManager.reset());

    it('keeps the device tools when Jev is off', async () => {
        const { tm } = await makeManager(new MockHomey());
        expect(tm.isJevActive()).toBe(false);
        for (const name of DEVICE_TOOLS) expect(tm.hasTool(name)).toBe(true);
        expect(tm.hasTool('smart_home')).toBe(false);
    });

    it('stays off when enabled without an API key', async () => {
        const homey = new MockHomey();
        homey.setMockSetting('jev_enabled', true);
        const { tm } = await makeManager(homey);
        expect(tm.isJevActive()).toBe(false);
        expect(tm.hasTool('set_device_capability')).toBe(true);
    });

    it('swaps the device tools for smart_home and back as the setting flips', async () => {
        const homey = new MockHomey();
        homey.setMockSetting('typesafe_api_key', 'ts-key');
        const { tm } = await makeManager(homey);

        homey.setMockSetting('jev_enabled', true);
        expect(tm.refreshJevTools()).toBe(true);
        for (const name of DEVICE_TOOLS) expect(tm.hasTool(name)).toBe(false);
        expect(tm.hasTool('smart_home')).toBe(true);

        homey.setMockSetting('jev_enabled', false);
        expect(tm.refreshJevTools()).toBe(false);
        for (const name of DEVICE_TOOLS) expect(tm.hasTool(name)).toBe(true);
        expect(tm.hasTool('smart_home')).toBe(false);
    });
});

describe('smart_home tool', () => {
    let homey: MockHomey;

    beforeEach(() => {
        settingsManager.reset();
        homey = new MockHomey();
        homey.setMockSetting('jev_enabled', true);
        homey.setMockSetting('typesafe_api_key', 'ts-key');
    });
    afterEach(() => vi.unstubAllGlobals());

    async function setup(wanted: string[]) {
        const fake = fakeTypeSafe(wanted);
        vi.stubGlobal('fetch', fake.fetchImpl);
        const { tm, deviceManager } = await makeManager(homey);
        return { run: tm.getToolHandlers()['smart_home'], tm, deviceManager, ...fake };
    }

    it('turns off exactly the devices Jev selects', async () => {
        const { run, deviceManager } = await setup(['Kitchen Ceiling Light']);
        const res = await run({ action: 'turn_off', target: 'the kitchen ceiling light' });
        expect(res.ok).toBe(true);
        expect(res.changed).toEqual([{ name: 'Kitchen Ceiling Light', zone: 'Kitchen' }]);
        expect(capOf(deviceManager, 'Kitchen Ceiling Light', 'onoff')).toBe('onoff=false');
        expect(capOf(deviceManager, 'Office Desk Light', 'onoff')).toBe('onoff=true');
    });

    it('only offers Jev devices that can do the action', async () => {
        const { run, bodies } = await setup([]);
        await run({ action: 'set_temperature', target: 'the office', value: 21 });
        const asked = new Set(bodies.flatMap(b => Object.values<any>(b.questions).map(q => q.instructions.device.name)));
        expect([...asked]).toEqual(['Office Thermostat']);
        expect(bodies[0].state).toEqual({ command: 'the office', speaker_room: 'Office' });
    });

    it('offers the exact room names as the room enum, read when the definitions are', async () => {
        const { deviceManager } = await setup([]);
        const { tm } = await makeManager(homey);
        const room = () => (tm.getToolDefinition('smart_home')!.parameters as any).properties.room;
        expect(room().enum).toEqual(deviceManager.getZones());
        expect(room().description).toContain('(Office)');
        // Survives serialization, which is how every provider sends it.
        const sent = JSON.parse(JSON.stringify(tm.getToolDefinitions())).find((t: any) => t.name === 'smart_home');
        expect(sent.parameters.properties.room.enum).toEqual(deviceManager.getZones());
    });

    it('sends a named room to Jev as the targeted room, matched case-insensitively', async () => {
        const { run, bodies } = await setup([]);
        await run({ action: 'turn_off', target: 'the lights', room: 'kitchen' });
        expect(bodies[0].state).toEqual({ command: 'the lights', speaker_room: 'Kitchen' });
    });

    it('refuses a room that is not a zone without asking Jev', async () => {
        const { run, fetchImpl } = await setup([]);
        const res = await run({ action: 'turn_off', target: 'the lights', room: 'the gym' });
        expect(res.error.code).toBe('UNKNOWN_ROOM');
        expect(res.error.message).toContain('Kitchen');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reports the closest devices when nothing clears the threshold', async () => {
        const { run } = await setup([]);
        const res = await run({ action: 'turn_on', target: 'the disco ball' });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe('NO_MATCHING_DEVICES');
        expect(res.closest).toHaveLength(3);
    });

    it('skips devices already at the value', async () => {
        const { run } = await setup(['Office Desk Light', 'Office Ceiling Light']);
        const res = await run({ action: 'turn_on', target: 'the office lights' });
        expect(res.already_set).toEqual(['Office Desk Light']);
        expect(res.changed.map((c: any) => c.name)).toEqual(['Office Ceiling Light']);
    });

    it('converts percent to a fraction for brightness', async () => {
        const { run, deviceManager } = await setup(['Bedroom Main Light']);
        const res = await run({ action: 'set_brightness', target: 'the bedroom light', value: 30 });
        expect(res.ok).toBe(true);
        expect(capOf(deviceManager, 'Bedroom Main Light', 'dim')).toBe('dim=0.3');
    });

    it('opens a position cover by position and a state-only cover by state', async () => {
        const { run, deviceManager } = await setup(['Office Blinds', 'Office Curtains']);
        const res = await run({ action: 'close', target: 'the covers' });
        expect(res.ok).toBe(true);
        expect(capOf(deviceManager, 'Office Blinds', 'windowcoverings_set')).toBe('windowcoverings_set=0');
        expect(capOf(deviceManager, 'Office Curtains', 'windowcoverings_state')).toBe('windowcoverings_state=down');
    });

    it('requires a value for set_brightness', async () => {
        const { run, fetchImpl } = await setup([]);
        const res = await run({ action: 'set_brightness', target: 'the lamp' });
        expect(res.error.code).toBe('MISSING_VALUE');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('asks for confirmation above 10 devices', async () => {
        const { run, tm } = await setup([
            'Living Room Main Light', 'Living Room Floor Lamp', 'Living Room TV Socket', 'Kitchen Ceiling Light',
            'Kitchen Under Cabinet Lights', 'Kitchen Coffee Machine', 'Bedroom Main Light', 'Bedroom Bedside Lamp',
            'Bedroom Phone Charger', 'Office Desk Light', 'Office Ceiling Light', 'Office Reading Lamp',
        ]);
        // 12 selected, 7 already on -> 5 to change: under the gate.
        const res = await run({ action: 'turn_on', target: 'everything everywhere' });
        expect(res.ok).toBe(true);
        expect(res.already_set).toHaveLength(7);
        // Now all 12 are on -> 12 to change: gated.
        const off = await run({ action: 'turn_off', target: 'everything everywhere' });
        expect(off.error.code).toBe('CONFIRMATION_REQUIRED');
        tm.noteUserTurn(); // the user says yes
        // The model may reword target on the re-run; the request is the same.
        const confirmed = await run({ action: 'turn_off', target: 'all lights everywhere', confirmed: true });
        expect(confirmed.changed).toHaveLength(12);
    });

    describe('confirmation is granted by the tool, not the model', () => {
        const ALL = [
            'Living Room Main Light', 'Living Room Floor Lamp', 'Living Room TV Socket', 'Kitchen Ceiling Light',
            'Kitchen Under Cabinet Lights', 'Kitchen Coffee Machine', 'Bedroom Main Light', 'Bedroom Bedside Lamp',
            'Bedroom Phone Charger', 'Office Desk Light', 'Office Ceiling Light', 'Office Reading Lamp',
        ];

        it('refuses confirmed=true on a first call', async () => {
            const { run, tm } = await setup(ALL);
            tm.noteUserTurn();
            const res = await run({ action: 'turn_on', target: 'everything everywhere', confirmed: true });
            expect(res.ok).toBe(true); // 5 to change: under the gate
            const off = await run({ action: 'turn_off', target: 'everything everywhere', confirmed: true });
            expect(off.error.code).toBe('CONFIRMATION_REQUIRED');
            expect(off.error.message).toContain('was not accepted');
        });

        it('refuses a re-run in the same response, before the user has spoken', async () => {
            const { run } = await setup(ALL);
            await run({ action: 'turn_on', target: 'everything everywhere' });
            expect((await run({ action: 'turn_off', target: 'everything everywhere' })).error.code).toBe('CONFIRMATION_REQUIRED');
            const again = await run({ action: 'turn_off', target: 'everything everywhere', confirmed: true });
            expect(again.error.code).toBe('CONFIRMATION_REQUIRED');
        });

        it('does not carry a confirmation over to a different request', async () => {
            const { run, tm } = await setup(ALL);
            await run({ action: 'turn_on', target: 'everything everywhere' });
            expect((await run({ action: 'turn_off', target: 'everything everywhere' })).error.code).toBe('CONFIRMATION_REQUIRED');
            tm.noteUserTurn();
            // The fake selects the same 12 devices for any room, so this is a
            // different request (room set) over the limit: no grant for it.
            const other = await run({ action: 'turn_off', target: 'the lights', room: 'Kitchen', confirmed: true });
            expect(other.error.code).toBe('CONFIRMATION_REQUIRED');
        });

        it('expires', async () => {
            const { run, tm } = await setup(ALL);
            await run({ action: 'turn_on', target: 'everything everywhere' });
            vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
            try {
                expect((await run({ action: 'turn_off', target: 'everything everywhere' })).error.code).toBe('CONFIRMATION_REQUIRED');
                tm.noteUserTurn();
                vi.setSystemTime(Date.now() + ToolManager.CONFIRMATION_TTL_MS + 1);
                const late = await run({ action: 'turn_off', target: 'everything everywhere', confirmed: true });
                expect(late.error.code).toBe('CONFIRMATION_REQUIRED');
            } finally {
                vi.useRealTimers();
            }
        });

        it('guards set_device_capability the same way', async () => {
            const { tm, deviceManager } = await setup([]);
            const ids = deviceManager.getSmartHomeDevices(undefined, undefined, 100).devices
                .filter(d => d.capabilities.some(c => c.startsWith('onoff='))).map(d => d.id);
            expect(ids.length).toBeGreaterThan(10);
            homey.setMockSetting('jev_enabled', false);
            tm.refreshJevTools();
            const set = tm.getToolHandlers()['set_device_capability'];
            const args = { deviceIds: ids, capabilityId: 'onoff', newValue: false, allow_cross_zone: true };
            expect((await set({ ...args, confirmed: true })).error.code).toBe('CONFIRMATION_REQUIRED');
            tm.noteUserTurn();
            expect((await set({ ...args, confirmed: true })).ok).toBe(true);
        });
    });

    it('get_status returns the selected devices with their values and changes nothing', async () => {
        const { run } = await setup(['Bedroom Temperature Sensor']);
        const res = await run({ action: 'get_status', target: 'the bedroom temperature' });
        expect(res.devices).toEqual([expect.objectContaining({ name: 'Bedroom Temperature Sensor', capabilities: ['measure_temperature=21.2', 'measure_humidity=45'] })]);
    });

    it('surfaces a TypeSafe failure as JEV_FAILED', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })));
        const { tm } = await makeManager(homey);
        const res = await tm.getToolHandlers()['smart_home']({ action: 'turn_on', target: 'the lights' });
        expect(res.error.code).toBe('JEV_FAILED');
        expect(res.error.message).toContain('did not respond');
        expect(res.error.message).toContain('do not name any devices');
    });
});

describe('Jev request building', () => {
    const device = (name: string, zone: string) => ({ id: name, name, zone, zones: [zone, 'Home'], type: 'light', capabilities: ['onoff=true', 'dim=0.5'] });

    it('embeds each device in its own questions and batches 20 devices per request', () => {
        const devices = Array.from({ length: 45 }, (_, i) => device(`Lamp ${i}`, i % 2 ? 'Kitchen' : 'Hall'));
        const requests = buildRequests('the lamps', 'Hall', devices);
        expect(requests).toHaveLength(3);
        expect(Object.keys(requests[0].questions)).toHaveLength(60);
        const q: any = requests[0].questions['d0__clarity'];
        // Values are stripped: capability names only.
        expect(q.instructions.device).toEqual({ name: 'Lamp 0', room: 'Hall', type: 'light', capabilities: ['onoff', 'dim'], inside: ['Home'] });
        expect(q.instructions.similar_devices_in_room.every((d: any) => d.name !== 'Lamp 0')).toBe(true);
    });

    it('lists only same-type roommates, and none when the device is alone of its type', () => {
        const devices = [
            { ...device('Ceiling', 'Hall'), type: 'light' },
            { ...device('Floor lamp', 'Hall'), type: 'light' },
            { ...device('Heater', 'Hall'), type: 'heater' },
        ];
        const [req] = buildRequests('the ceiling light', 'Hall', devices);
        const light: any = req.questions['d0__clarity'];
        expect(light.instructions.similar_devices_in_room).toEqual([{ name: 'Floor lamp', type: 'light' }]);
        const heater: any = req.questions['d2__clarity'];
        expect(heater.instructions.similar_devices_in_room).toBeUndefined();
        expect(heater.instructions.question).toContain('only device of its type');
    });
});

describe('Jev selection rule', () => {
    // Answers each question with a fixed level per device and dimension
    // (levels: clarity 0-3, room 0-2, type 0-2).
    function client(levels: Record<string, { clarity: number; room: number; type: number }>) {
        return {
            systemOneBatch: async (requests: any[]) => ({
                stats: requests.map(() => ({ ms: 1, attempts: 1 })),
                responses: requests.map(r => ({
                    answers: Object.fromEntries(Object.entries<any>(r.questions).map(([id, q]) => {
                        const dim = id.split('__')[1] as 'clarity' | 'room' | 'type';
                        const legend = Object.fromEntries(q.criteria.map((c: string, i: number) => [String(i), c]));
                        return [id, { type: 'score', score: levels[q.instructions.device.name][dim], legend, probabilities: {}, confidence: 1 }];
                    })),
                })),
            }),
        } as any;
    }
    const dev = (name: string) => ({ id: name, name, zone: 'Gym', zones: ['Gym'], type: 'socket', capabilities: ['onoff=true'] });

    it('drops a device that fails one dimension even when the average clears the threshold', async () => {
        const { selectDevices } = await import('../src/llm/jev/jev-device-selector.mjs');
        const sel = await selectDevices(client({
            // clarity 1, room 1, type 1/2 -> average 0.83, but type is below its floor
            'Treadmill': { clarity: 3, room: 2, type: 1 },
            'Lamp socket': { clarity: 2, room: 2, type: 2 },
        }), 'the lights in the gym', 'Hall', [dev('Treadmill'), dev('Lamp socket')]);
        expect(sel.selected.map(d => d.name)).toEqual(['Lamp socket']);
        const treadmill = sel.ranked.find(r => r.device.name === 'Treadmill')!;
        expect(treadmill.weighted).toBeGreaterThan(0.7);
        expect(treadmill.vetoedBy).toEqual(['type']);
    });
});

describe('Jev ranking log', () => {
    it('shows each dimension, the selection mark and the vetoes', () => {
        const dev = (name: string, zone: string) => ({ id: name, name, zone, zones: [zone], type: 'light', capabilities: [] });
        const s = (clarity: number, room: number, type: number) => ({
            clarity: { value: clarity, confidence: 1 }, room: { value: room, confidence: 1 }, type: { value: type, confidence: 1 },
        });
        const line = formatRanked([
            { device: dev('Utelys', 'Ute'), scores: s(2 / 3, 1, 1), weighted: 8 / 9, vetoedBy: [], selected: true },
            { device: dev('Taklys', 'Trimrom'), scores: s(1 / 3, 0, 1), weighted: 4 / 9, vetoedBy: ['room'], selected: false },
        ]);
        expect(line).toBe('Utelys [Ute] ✓ 0.89 c0.67 r1 t1; Taklys [Trimrom] veto:room 0.44 c0.33 r0 t1');
    });
});

describe('Jev prompt', () => {
    it('replaces the device procedure and keeps the translated timer block', async () => {
        const { InstructionState } = await import('../src/llm/instruction-state.mjs');
        const state = new InstructionState();
        await state.reload({ languageCode: 'no', languageName: 'Norwegian', supportsTimers: true, supportsJev: true });
        expect(state.text).toContain('smart_home(action, target');
        expect(state.text).not.toContain('get_devices_in_standard_zone');
        expect(state.text).toContain('set_timer(duration_seconds');

        await state.reload({ languageCode: 'no', languageName: 'Norwegian', supportsTimers: false, supportsJev: true });
        expect(state.text).not.toContain('set_timer');
    });

    it('is Norwegian for no and falls back to English for untranslated languages', async () => {
        const { InstructionState } = await import('../src/llm/instruction-state.mjs');
        const state = new InstructionState();
        await state.reload({ languageCode: 'no', languageName: 'Norwegian', additionalInstructions: 'Si hei', supportsJev: true });
        expect(state.text).toContain('Du er en smarthus-operatør');
        expect(state.text).toContain('Tilleggsinstruksjoner:\nSi hei');

        await state.reload({ languageCode: 'de', languageName: 'German', supportsJev: true });
        expect(state.text).toContain('You are a smart-home operator. Respond in German.');
    });
});
