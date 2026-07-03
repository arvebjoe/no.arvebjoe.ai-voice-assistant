import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks (hoisted) must be registered before the harness imports the device. ---
vi.mock('homey', () => import('./mocks/mock-homey-sdk.mjs'));
vi.mock('../src/voice_assistant/esp-voice-assistant-client.mjs', () => import('./mocks/mock-esp-client.mjs'));
vi.mock('../src/llm/voice-provider-factory.mjs', () => import('./mocks/mock-voice-provider.mjs'));
vi.mock('../src/helpers/audio-encoders.mjs', () => ({
    pcmToFlacBuffer: async (b: any) => (Buffer.isBuffer(b) ? b : Buffer.from(b)),
}));

import { createHarness, Harness } from './mocks/device-harness.mjs';
import { __resetProviderRegistry, createdProviders } from './mocks/mock-voice-provider.mjs';

// Drive a full wake -> mic-open turn (the synchronous part of the 'starting' flow).
function startTurn(h: Harness) {
    h.esp.emit('starting');
}

describe('VoiceAssistantDevice (harness)', () => {
    beforeEach(() => {
        __resetProviderRegistry();
    });

    describe('C1 — wake-death recovery', () => {
        it('resets turn state when the ESP connection drops mid-turn', async () => {
            const h = await createHarness();
            startTurn(h);
            expect((h.device as any).isSteamingMic).toBe(true);

            // Simulate the ESP link dropping while the mic is open.
            h.esp.emit('Unhealthy');

            expect((h.device as any).isSteamingMic).toBe(false);
            // The device told itself/the tile the turn is over.
            expect((h.device as any).isPlaying).toBe(false);
        });

        it('resets turn state when the agent websocket closes mid-turn', async () => {
            const h = await createHarness();
            startTurn(h);
            expect((h.device as any).isSteamingMic).toBe(true);

            h.provider.emit('close');

            expect((h.device as any).isSteamingMic).toBe(false);
        });

        it('accepts a new wake after a mid-turn drop (no permanent wake-death)', async () => {
            const h = await createHarness();
            startTurn(h);
            const runStartsBefore = h.esp.countOf('run_start');

            h.esp.emit('Unhealthy');       // drop
            startTurn(h);                   // user says the wake word again

            // The second wake was NOT swallowed by the duplicate-wake guard.
            expect(h.esp.countOf('run_start')).toBe(runStartsBefore + 1);
            expect((h.device as any).isSteamingMic).toBe(true);
        });

        it('ignores a duplicate wake while already streaming (guard still works)', async () => {
            const h = await createHarness();
            startTurn(h);
            const runStarts = h.esp.countOf('run_start');
            startTurn(h); // duplicate while streaming
            expect(h.esp.countOf('run_start')).toBe(runStarts);
        });
    });

    describe('M3 — onSettings applies the NEW values', () => {
        it('recomputes audio-skip from newSettings, not the stale getSettings()', async () => {
            const h = await createHarness({ settings: { initial_audio_skip: 300 } });
            // Old value is in effect after init.
            expect((h.device as any).skipInitialBytes).toBe(300 * 16000 * 1 * 2 / 1000);

            // Simulate the SDK's onSettings: newSettings carries the change, but
            // getSettings() still returns the old value until this resolves.
            await (h.device as any).onSettings({
                oldSettings: { initial_audio_skip: 300 },
                newSettings: { initial_audio_skip: 500 },
                changedKeys: ['initial_audio_skip'],
            });

            expect((h.device as any).skipInitialBytes).toBe(500 * 16000 * 1 * 2 / 1000);
        });

        it('treats initial_audio_skip = 0 as a deliberate no-skip', async () => {
            const h = await createHarness({ settings: { initial_audio_skip: 300 } });
            await (h.device as any).onSettings({
                oldSettings: { initial_audio_skip: 300 },
                newSettings: { initial_audio_skip: 0 },
                changedKeys: ['initial_audio_skip'],
            });
            expect((h.device as any).skipInitialBytes).toBe(0);
        });
    });

    describe('H-l — announce segments play in order', () => {
        function chunk(marker: number): Buffer {
            // First byte is the marker the fake buildStream keys its delay/URL on.
            return Buffer.from([marker, 0, 0, 0]);
        }

        it('plays the first-emitted segment first even when its encode is slower', async () => {
            // Segment 1 takes 30 ms to "build", segment 2 is instant. Without
            // serialization, segment 2 would win the race and play first.
            const h = await createHarness({ buildStreamDelayByFirstByte: { 1: 30, 2: 0 } });
            const seg = (h.device as any).segmenter;

            seg.emit('chunk', chunk(1));
            seg.emit('chunk', chunk(2));

            await h.settle(80);

            const plays = h.esp.calls.filter(c => c.method === 'playAudioFromUrl');
            // First segment plays; second is queued behind it (announce queue).
            expect(plays).toHaveLength(1);
            expect(plays[0].args[0]).toBe('http://x/1');
            expect((h.device as any).announceUrls).toHaveLength(1);
        });

        it('plays the queued next segment on announce_finished, in order', async () => {
            const h = await createHarness({ buildStreamDelayByFirstByte: { 1: 30, 2: 0 } });
            const seg = (h.device as any).segmenter;

            seg.emit('chunk', chunk(1));
            seg.emit('chunk', chunk(2));
            await h.settle(80);

            // First segment finished playing on the device -> play the queued one.
            h.esp.emit('announce_finished');
            await h.settle(10);

            const plays = h.esp.calls.filter(c => c.method === 'playAudioFromUrl');
            expect(plays.map(p => p.args[0])).toEqual(['http://x/1', 'http://x/2']);
        });
    });

    describe('M4 — runtime voice_provider switch', () => {
        it('rebuilds the provider when voice_provider changes', async () => {
            const h = await createHarness();
            const first = h.provider;
            expect(createdProviders.length).toBe(1);

            // The settings pub/sub delivers a full snapshot; flip the provider.
            await (h.device as any).handleSettingsChange({
                openai_api_key: 'test-key',
                gemini_api_key: 'g-key',
                selected_voice: 'alloy',
                selected_language_code: 'en',
                selected_language_name: 'English',
                ai_instructions: '',
                voice_provider: 'gemini-realtime',
            });

            expect(createdProviders.length).toBe(2);
            const second = createdProviders[1];
            expect(second).not.toBe(first);
            expect(second.providerId).toBe('gemini-realtime');
            expect(second.started).toBe(true);     // new provider connected
            expect(first.destroyed).toBe(true);     // old provider torn down
            expect((h.device as any).currentProviderId).toBe('gemini-realtime');
        });

        it('does not rebuild when voice_provider is unchanged', async () => {
            const h = await createHarness();
            await (h.device as any).handleSettingsChange({
                openai_api_key: 'test-key',
                selected_voice: 'alloy',
                selected_language_code: 'en',
                selected_language_name: 'English',
                ai_instructions: '',
                voice_provider: 'openai-realtime',
            });
            expect(createdProviders.length).toBe(1);
        });
    });
});
