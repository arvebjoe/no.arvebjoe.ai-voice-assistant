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
            expect((h.device as any).turn.isListening).toBe(true);

            // Simulate the ESP link dropping while the mic is open.
            h.esp.emit('Unhealthy');

            expect((h.device as any).turn.isListening).toBe(false);
            // The device told itself/the tile the turn is over.
            expect((h.device as any).audioOutput.isPlaying).toBe(false);
        });

        it('resets turn state when the agent websocket closes mid-turn', async () => {
            const h = await createHarness();
            startTurn(h);
            expect((h.device as any).turn.isListening).toBe(true);

            h.provider.emit('close');

            expect((h.device as any).turn.isListening).toBe(false);
        });

        it('accepts a new wake after a mid-turn drop (no permanent wake-death)', async () => {
            const h = await createHarness();
            startTurn(h);
            const runStartsBefore = h.esp.countOf('run_start');

            h.esp.emit('Unhealthy');       // drop
            startTurn(h);                   // user says the wake word again

            // The second wake was NOT swallowed by the duplicate-wake guard.
            expect(h.esp.countOf('run_start')).toBe(runStartsBefore + 1);
            expect((h.device as any).turn.isListening).toBe(true);
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

    describe('wake-word selection', () => {
        const nabu = { id: 'okay_nabu', wakeWord: 'Okay Nabu', trainedLanguages: ['en'] };
        const homey = { id: 'hey_homey', wakeWord: 'Hey Homey', trainedLanguages: ['en'] };

        it('activates a wake word by name (case/space-insensitive) via onSettings', async () => {
            const h = await createHarness();
            h.esp.availableWakeWords = [nabu, homey];

            const msg = await (h.device as any).onSettings({
                oldSettings: { wake_word: '' },
                newSettings: { wake_word: 'hey homey' },
                changedKeys: ['wake_word'],
            });

            expect(msg).toContain('Hey Homey');
            const set = h.esp.calls.find(c => c.method === 'setActiveWakeWords');
            expect(set?.args[0]).toEqual(['hey_homey']);
        });

        it('rejects an unknown wake word with the available list in the error', async () => {
            const h = await createHarness();
            h.esp.availableWakeWords = [nabu];

            await expect((h.device as any).onSettings({
                oldSettings: { wake_word: '' },
                newSettings: { wake_word: 'alexa' },
                changedKeys: ['wake_word'],
            })).rejects.toThrow(/Okay Nabu/);
            expect(h.esp.countOf('setActiveWakeWords')).toBe(0);
        });

        it('updates the available_wake_words label when the device reports its config', async () => {
            const h = await createHarness();
            h.esp.emit('wake_words', [nabu, homey], ['okay_nabu'], 1);
            await h.settle(0);
            const settings = (h.device as any).getSettings();
            expect(settings.available_wake_words).toContain('Okay Nabu (okay_nabu) — active');
            expect(settings.available_wake_words).toContain('Hey Homey (hey_homey)');
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
            const seg = (h.device as any).audioOutput.segmenter;

            seg.emit('chunk', chunk(1));
            seg.emit('chunk', chunk(2));

            await h.settle(80);

            const plays = h.esp.calls.filter(c => c.method === 'playAudioFromUrl');
            // First segment plays; second is queued behind it (announce queue).
            expect(plays).toHaveLength(1);
            expect(plays[0].args[0]).toBe('http://x/1');
            expect((h.device as any).audioOutput.queue).toHaveLength(1);
        });

        it('plays the queued next segment on announce_finished, in order', async () => {
            const h = await createHarness({ buildStreamDelayByFirstByte: { 1: 30, 2: 0 } });
            const seg = (h.device as any).audioOutput.segmenter;

            seg.emit('chunk', chunk(1));
            seg.emit('chunk', chunk(2));
            await h.settle(80);

            // First segment finished playing on the device -> play the queued one.
            h.esp.emit('announce_finished');
            await h.settle(10);

            const plays = h.esp.calls.filter(c => c.method === 'playAudioFromUrl');
            expect(plays.map(p => p.args[0])).toEqual(['http://x/1', 'http://x/2']);
        });

        it('M9 — extends the announce file TTL by the segment playback length', async () => {
            const h = await createHarness();
            const timeoutSpy = vi.spyOn(h.homey, 'setTimeout');
            const seg = (h.device as any).audioOutput.segmenter;

            // 4800 bytes of PCM16 mono 24 kHz = 100 ms of audio. The deletion
            // timer must be base TTL (30 000 ms) + 100 ms, not the bare TTL.
            seg.emit('chunk', Buffer.alloc(4800));
            await h.settle(10);

            const ttlCalls = timeoutSpy.mock.calls.filter(c => (c[1] as number) >= 30_000);
            expect(ttlCalls).toHaveLength(1);
            expect(ttlCalls[0][1]).toBe(30_100);
            timeoutSpy.mockRestore();
        });
    });

    describe('conversation flow — announce reopen and in-band reply', () => {
        /**
         * Drive one full announce-path turn whose reply ends in a question:
         * wake -> silence -> user transcript -> reply audio segment -> response.done
         * -> announce_finished. Leaves the device in a PE start_conversation session
         * (mic reopened, next turn replies in-band).
         */
        async function runAnnounceTurnEndingInQuestion(h: Harness) {
            h.esp.emit('starting');
            h.provider.emit('silence', 'server');
            h.provider.emit('transcript.done', 'hvordan er været?');
            h.provider.emit('transcript.delta', 'Det er fint. Vil du høre mer?');
            const seg = (h.device as any).audioOutput.segmenter;
            seg.emit('chunk', Buffer.from([3, 0, 0, 0]));
            await h.settle(10);
            h.provider.emit('response.done'); // "?" -> continue the conversation
            await h.settle(10);
            h.esp.emit('announce_finished');  // queue empty -> end of playback
            await h.settle(10);               // reopen fires on a 1 ms timeout
        }

        it('a reply ending in "?" ends the announce turn and reopens the mic', async () => {
            const h = await createHarness();
            await runAnnounceTurnEndingInQuestion(h);

            // The reply segment played on the announce path (intent_end -> tts_start -> play).
            expect(h.esp.countOf('playAudioFromUrl')).toBe(1);
            expect(h.esp.countOf('tts_end')).toBe(1);
            expect(h.esp.countOf('run_end')).toBe(1);
            // The question reopened the mic (start_conversation session begins).
            expect(h.esp.countOf('send_voice_assistant_request')).toBe(1);
            expect((h.device as any).turn.peConversationActive).toBe(true);
        });

        it('a follow-up turn delivers its reply in-band on TTS_END and closes the session', async () => {
            const h = await createHarness();
            await runAnnounceTurnEndingInQuestion(h);
            const playsBefore = h.esp.countOf('playAudioFromUrl');

            // Follow-up turn (the reopen the PE answered with a new 'starting').
            h.esp.emit('starting');
            h.provider.emit('silence', 'server');
            h.provider.emit('transcript.done', 'ja takk');
            h.provider.emit('transcript.delta', 'Her er mer info.'); // no "?" -> close
            const seg = (h.device as any).audioOutput.segmenter;
            seg.emit('chunk', Buffer.alloc(4800, 7));
            await h.settle(5);
            // In-band: the segment is accumulated, NOT played as an announce.
            expect(h.esp.countOf('playAudioFromUrl')).toBe(playsBefore);

            h.provider.emit('response.done'); // flush -> segmenter 'done' -> in-band delivery
            await h.settle(20);

            // INTENT_END tells the PE not to reopen (reply is not a question).
            const intentEnds = h.esp.calls.filter(c => c.method === 'intent_end');
            expect(intentEnds[intentEnds.length - 1].args[1]).toBe(false);
            // TTS_START carries the reply text (firmware discards a text-less one).
            const ttsStarts = h.esp.calls.filter(c => c.method === 'tts_start');
            expect(ttsStarts[ttsStarts.length - 1].args[0]).toBe('Her er mer info.');
            // TTS_END carries the reply file URL (the in-band delivery mechanism).
            const ttsEnds = h.esp.calls.filter(c => c.method === 'tts_end');
            expect(ttsEnds[ttsEnds.length - 1].args[0]).toMatch(/^http:\/\/x\//);
            expect(h.esp.countOf('run_end')).toBe(2);
            // Final reply -> the PE goes idle after playback; session over.
            expect((h.device as any).turn.peConversationActive).toBe(false);
        });

        it('a follow-up reply ending in "?" keeps the session open', async () => {
            const h = await createHarness();
            await runAnnounceTurnEndingInQuestion(h);

            h.esp.emit('starting');
            h.provider.emit('silence', 'server');
            h.provider.emit('transcript.done', 'ja');
            h.provider.emit('transcript.delta', 'Neste spørsmål: hva er 2+2?');
            const seg = (h.device as any).audioOutput.segmenter;
            seg.emit('chunk', Buffer.alloc(4800, 9));
            await h.settle(5);
            h.provider.emit('response.done');
            await h.settle(20);

            const intentEnds = h.esp.calls.filter(c => c.method === 'intent_end');
            expect(intentEnds[intentEnds.length - 1].args[1]).toBe(true); // keep open
            expect((h.device as any).turn.peConversationActive).toBe(true);
        });

        it('an empty transcript right after a follow-up mic-open retries the mic (spurious VAD trip)', async () => {
            const h = await createHarness();
            await runAnnounceTurnEndingInQuestion(h);
            const reopensBefore = h.esp.countOf('send_voice_assistant_request');

            // Follow-up turn hears "nothing" almost immediately (TTS echo tripped VAD).
            h.esp.emit('starting');
            h.provider.emit('silence', 'server');
            h.provider.emit('transcript.done', '');
            await h.settle(10);

            // The turn was retried (mic reopened), not treated as the user leaving.
            expect(h.esp.countOf('send_voice_assistant_request')).toBe(reopensBefore + 1);
            expect((h.device as any).turn.peConversationActive).toBe(true);
            expect((h.device as any).turn.emptyTurnRetries).toBe(1);
        });

        it('an empty transcript on a plain wake turn ends the run without a retry', async () => {
            const h = await createHarness();
            h.esp.emit('starting');
            h.provider.emit('silence', 'server');
            h.provider.emit('transcript.done', '');
            await h.settle(10);

            expect(h.esp.countOf('send_voice_assistant_request')).toBe(0);
            expect(h.esp.countOf('run_end')).toBe(1);
            expect((h.device as any).turn.peConversationActive).toBe(false);
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
