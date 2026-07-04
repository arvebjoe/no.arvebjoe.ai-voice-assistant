// Test harness for VoiceAssistantDevice. Boots the REAL device (real onInit, real
// event handlers, real PcmSegmenter/ToolManager/TimerManager) with faked transport
// (ESP client + voice provider) and faked app singletons, so the conversation-flow
// logic can be driven and asserted without any network.
//
// IMPORTANT: the test file must register these vi.mock calls (hoisted) BEFORE
// importing this harness, so the device's base class and collaborators are faked:
//
//   vi.mock('homey', () => import('./mocks/mock-homey-sdk.mjs'));
//   vi.mock('../src/voice_assistant/esp-voice-assistant-client.mjs',
//           () => import('./mocks/mock-esp-client.mjs'));
//   vi.mock('../src/llm/voice-provider-factory.mjs',
//           () => import('./mocks/mock-voice-provider.mjs'));
//   vi.mock('../src/helpers/audio-encoders.mjs', () => ({
//       pcmToFlacBuffer: async (b: any) => (Buffer.isBuffer(b) ? b : Buffer.from(b)),
//       pcmToWavBuffer: (b: any) => b,
//   }));

import VoiceAssistantDevice from '../../src/homey/voice-assistant-device.mjs';
import { settingsManager } from '../../src/settings/settings-manager.mjs';
import { MockHomey } from './mock-homey.mjs';
import type { EspVoiceAssistantClient as FakeEsp } from './mock-esp-client.mjs';
import type { FakeVoiceProvider } from './mock-voice-provider.mjs';

// Concrete subclass — VoiceAssistantDevice is abstract (only needDelayedPlayback).
class TestVoiceDevice extends VoiceAssistantDevice {
    readonly needDelayedPlayback = false;
}

export interface HarnessOptions {
    settings?: Record<string, any>;
    globals?: Record<string, any>;
    /** ms delay for webServer.buildStream, keyed by the FIRST byte of the chunk. */
    buildStreamDelayByFirstByte?: Record<number, number>;
    initialZone?: string;
}

export interface Harness {
    device: TestVoiceDevice;
    esp: FakeEsp;
    provider: FakeVoiceProvider;
    homey: any;
    buildStreamCalls: Buffer[];
    zoneChangeCallback: ((changed: any) => void) | null;
    /** Let queued microtasks/timers settle. */
    settle: (ms?: number) => Promise<void>;
}

function makeFakeHomey(globals: Record<string, any>): any {
    const homey: any = new MockHomey();
    for (const [k, v] of Object.entries(globals)) homey.setMockSetting(k, v);
    homey.notifications = { createNotification: async () => { } };
    homey.flow = {
        getDeviceTriggerCard: () => ({ trigger: async () => { }, registerRunListener: () => { } }),
        getActionCard: () => ({ registerRunListener: () => { } }),
        getConditionCard: () => ({ registerRunListener: () => { } }),
    };
    return homey;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
    const globals = {
        openai_api_key: 'test-key',
        selected_voice: 'alloy',
        selected_language_code: 'en',
        selected_language_name: 'English',
        ai_instructions: '',
        voice_provider: 'openai-realtime',
        input_buffer_debug: false,
        ...(opts.globals ?? {}),
    };

    const homey = makeFakeHomey(globals);

    // The device reads global settings via the settingsManager singleton.
    settingsManager.reset();
    settingsManager.init(homey);

    const buildStreamCalls: Buffer[] = [];
    let zoneChangeCallback: ((changed: any) => void) | null = null;

    const webServer = {
        async buildStream(audioData: any) {
            const data: Buffer = audioData.data;
            buildStreamCalls.push(data);
            const delay = opts.buildStreamDelayByFirstByte?.[data[0]] ?? 0;
            if (delay > 0) await new Promise(r => setTimeout(r, delay));
            const id = buildStreamCalls.length;
            return { filename: `f${id}.flac`, filepath: `/userdata/audio/f${id}.flac`, url: `http://x/${data[0]}` };
        },
    };

    const deviceManager = {
        registerDevice(_mac: string, cb: (changed: any) => void) {
            zoneChangeCallback = cb;
            return opts.initialZone ?? 'Office';
        },
        unRegisterDevice() { },
        async fetchData() { },
        getSmartHomeDevices() { return { devices: [], next_page_token: null }; },
    };

    const geoHelper = { hasLocation: () => true, getTimezone: () => 'UTC' };
    const weatherHelper = {};

    homey.app = { webServer, deviceManager, geoHelper, weatherHelper };

    const device = new (TestVoiceDevice as any)({
        homey,
        store: { address: '127.0.0.1', port: 6053, mac: 'AA:BB:CC' },
        settings: opts.settings ?? {},
    });

    await device.onInit();

    return {
        device,
        esp: (device as any).esp,
        provider: (device as any).provider,
        homey,
        buildStreamCalls,
        get zoneChangeCallback() { return zoneChangeCallback; },
        settle: (ms = 0) => new Promise(r => setTimeout(r, ms)),
    } as Harness;
}
