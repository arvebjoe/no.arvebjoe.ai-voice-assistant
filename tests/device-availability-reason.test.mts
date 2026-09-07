import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks (hoisted) must be registered before the harness imports the device. ---
vi.mock('homey', () => import('./mocks/mock-homey-sdk.mjs'));
vi.mock('../src/voice_assistant/esp-voice-assistant-client.mjs', () => import('./mocks/mock-esp-client.mjs'));
vi.mock('../src/llm/voice-provider-factory.mjs', () => import('./mocks/mock-voice-provider.mjs'));
vi.mock('../src/helpers/audio-encoders.mjs', () => ({
    pcmToFlacBuffer: async (b: any) => (Buffer.isBuffer(b) ? b : Buffer.from(b)),
    pcmToMp3Buffer: async (b: any) => (Buffer.isBuffer(b) ? b : Buffer.from(b)),
}));
vi.mock('../src/helpers/listening-chime.mjs', async (importOriginal) => ({
    ...(await importOriginal() as object),
    ensureListeningChime: async () => 'listening_chime.flac',
    ensureMicClosedChime: async () => 'mic_closed_chime.flac',
}));
vi.mock('../src/helpers/feedback-sounds.mjs', () => ({
    ensureFeedbackSoundMp3: async (key: string) => ({ filename: `feedback_${key}.mp3`, durationMs: 4000 }),
}));

import { createHarness, Harness } from './mocks/device-harness.mjs';
import { __resetProviderRegistry } from './mocks/mock-voice-provider.mjs';
import { seenDevices } from '../src/helpers/seen-devices.mjs';

/**
 * "Unavailable" covers TWO independent links — the satellite and the voice
 * engine — and saying only that is what sent a field reporter after his network
 * (SSH session, port check, a whole Home Assistant install) when a missing API
 * key was the likely cause. These cases pin that the tile names which side is
 * down, and that the Debug page carries the two links separately.
 */

/** Bring both links up, the way a healthy boot does. */
function bothUp(h: Harness) {
    h.esp.emit('Healthy');
    h.provider.emit('Healthy');
}

describe('unavailable reason names the failing side', () => {
    beforeEach(() => {
        __resetProviderRegistry();
    });

    it('is available, with no reason, when both links are up', async () => {
        const h = await createHarness();
        bothUp(h);

        expect(h.device.getAvailable()).toBe(true);
        expect((h.device as any).unavailableMessage).toBeNull();
    });

    it('blames the engine — by name — when only the satellite is up', async () => {
        const h = await createHarness();
        bothUp(h);
        h.provider.emit('Unhealthy');

        expect(h.device.getAvailable()).toBe(false);
        const msg = (h.device as any).unavailableMessage as string;
        expect(msg).toMatch(/OpenAI Realtime/);
        expect(msg).toMatch(/API key/i);
        // Must not send the user to the network — that is the whole point.
        expect(msg).not.toMatch(/same network/i);
    });

    it('names the selected engine, not a hardcoded one', async () => {
        const h = await createHarness({ globals: { voice_provider: 'gemini-realtime' } });
        bothUp(h);
        h.provider.emit('Unhealthy');

        expect((h.device as any).unavailableMessage).toMatch(/Google Gemini Live/);
    });

    it('blames the device, and points at the network, when only the engine is up', async () => {
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('Unhealthy');

        const msg = (h.device as any).unavailableMessage as string;
        expect(msg).toMatch(/No connection to the device/);
        expect(msg).toMatch(/same network/i);
        expect(msg).not.toMatch(/API key/i);
    });

    it('says so when both links are down', async () => {
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('Unhealthy');
        h.provider.emit('Unhealthy');

        const msg = (h.device as any).unavailableMessage as string;
        expect(msg).toMatch(/No connection to the device/);
        expect(msg).toMatch(/not connected either/);
    });

    // The old updateAvailable() only called setUnavailable() on a true -> false
    // edge, so a reason that changed while the device stayed unavailable never
    // reached the tile — it would still blame the satellite after the satellite
    // came back.
    it('updates the reason while the device stays unavailable', async () => {
        const h = await createHarness();
        bothUp(h);

        h.esp.emit('Unhealthy');
        h.provider.emit('Unhealthy');
        expect((h.device as any).unavailableMessage).toMatch(/not connected either/);

        // Satellite returns; the engine is still down. Never became available.
        h.esp.emit('Healthy');
        expect(h.device.getAvailable()).toBe(false);
        const msg = (h.device as any).unavailableMessage as string;
        expect(msg).toMatch(/The device is connected/);
        expect(msg).toMatch(/OpenAI Realtime/);
    });

    it('does not repeat an unchanged reason', async () => {
        const h = await createHarness();
        bothUp(h);
        h.provider.emit('Unhealthy');

        const before = (h.device as any).unavailableMessages.length;
        h.provider.emit('Unhealthy');   // same fault again
        expect((h.device as any).unavailableMessages.length).toBe(before);
    });

    it('clears the reason when both links recover', async () => {
        const h = await createHarness();
        bothUp(h);
        h.provider.emit('Unhealthy');
        expect(h.device.getAvailable()).toBe(false);

        h.provider.emit('Healthy');
        expect(h.device.getAvailable()).toBe(true);
        expect((h.device as any).unavailableMessage).toBeNull();
    });
});

describe('the Debug list carries the two links separately', () => {
    beforeEach(() => {
        __resetProviderRegistry();
    });

    it('reports device up / engine down as two distinct flags', async () => {
        const h = await createHarness();
        bothUp(h);
        h.provider.emit('Unhealthy');

        const entry = seenDevices.get(String(h.device.getData().id));
        expect(entry).toBeDefined();
        expect(entry!.available).toBe(false);
        expect(entry!.deviceConnected).toBe(true);
        expect(entry!.engineConnected).toBe(false);
        expect(entry!.engineName).toBe('OpenAI Realtime');
    });

    it('reports device down / engine up the other way round', async () => {
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('Unhealthy');

        const entry = seenDevices.get(String(h.device.getData().id));
        expect(entry!.deviceConnected).toBe(false);
        expect(entry!.engineConnected).toBe(true);
    });

    it('marks both connected when the device is available', async () => {
        const h = await createHarness();
        bothUp(h);

        const entry = seenDevices.get(String(h.device.getData().id));
        expect(entry!.available).toBe(true);
        expect(entry!.deviceConnected).toBe(true);
        expect(entry!.engineConnected).toBe(true);
    });
});

/**
 * The other way a device can be broken while looking fine: ESPHome hands its
 * voice assistant to ONE client, and the loser of that race gets a connection
 * that lists entities, answers pings and discards every voice message. Both
 * links are up, so "Unavailable" has nothing to say — hence a warning.
 */
describe('warning when another client owns the voice assistant', () => {
    beforeEach(() => {
        __resetProviderRegistry();
    });

    it('names Home Assistant and the fix once the mic-open goes unanswered', async () => {
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('voice_assistant_owner', 'taken');
        await h.settle();

        const warning = (h.device as any).warning as string;
        expect(warning).toMatch(/Home Assistant/);
        expect(warning).toMatch(/only have one/i);
        // The device is NOT unavailable: both links really are up, and saying
        // otherwise would send the user back to the network for the third time.
        expect(h.device.getAvailable()).toBe(true);
    });

    it('stays silent on suspicion alone', async () => {
        // An empty wake-word list is how ESPHome answers a non-owner, but also
        // how a satellite with no on-board wake words answers. Log it, do not
        // accuse a working device.
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('voice_assistant_owner', 'suspected');
        await h.settle();

        expect((h.device as any).warning).toBeNull();
    });

    it('also puts it on the Homey timeline, naming the device and the fix', async () => {
        // The banner is only seen by someone who opens the device, and the whole
        // failure mode is that nothing looks wrong — so nobody opens it.
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('voice_assistant_owner', 'taken');
        await h.settle();

        expect(h.homey.notificationsSent).toHaveLength(1);
        const excerpt = h.homey.notificationsSent[0].excerpt as string;
        expect(excerpt).toMatch(/Home Assistant/);
        expect(excerpt).toMatch(/Remove it from Home Assistant/);
        expect(excerpt).toContain(h.device.getName());
        // The timeline truncates; the full explanation lives on the device warning.
        expect(excerpt.length).toBeLessThan(200);
    });

    it('says it out loud on the device, over the media player', async () => {
        // The announce path is exactly what a satellite in this state discards,
        // so the clip has to ride the ungated media-player entity command.
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('voice_assistant_owner', 'taken');
        await h.settle();

        const played = h.esp.calls.filter((c: any) => c.method === 'playMediaUrl');
        expect(played).toHaveLength(1);
        expect(played[0].args[0]).toMatch(/voice_assistant_in_use\.flac$/);
        // Nothing on the announce path — neither the clip nor a run wrapper,
        // which is VoiceAssistantEventResponse and equally discarded.
        expect(h.esp.countOf('playAudioFromUrl')).toBe(0);
        expect(h.esp.countOf('run_start')).toBe(0);
    });

    it('does not repeat the spoken clip while the state persists', async () => {
        // Shares the notification's throttle: a reconnect loop must not make the
        // speaker nag.
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('voice_assistant_owner', 'taken');
        await h.settle();
        h.esp.emit('voice_assistant_owner', 'taken');
        await h.settle();

        expect(h.esp.countOf('playMediaUrl')).toBe(1);
    });

    it('stays silent on the speaker on suspicion alone', async () => {
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('voice_assistant_owner', 'suspected');
        await h.settle();

        expect(h.esp.countOf('playMediaUrl')).toBe(0);
    });

    it('does not repeat the timeline notification while the state persists', async () => {
        // Detection is per connection, so a satellite that reconnects all day
        // re-derives 'taken' all day. The timeline must not follow it.
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('voice_assistant_owner', 'taken');
        await h.settle();
        h.esp.emit('voice_assistant_owner', 'taken');
        await h.settle();

        expect(h.homey.notificationsSent).toHaveLength(1);
    });

    it('notifies again when it recurs after being fixed', async () => {
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('voice_assistant_owner', 'taken');
        await h.settle();

        // Removed from Home Assistant, satellite answers again...
        h.esp.emit('voice_assistant_owner', 'ok');
        await h.settle();
        // ...and then someone adds it back.
        h.esp.emit('voice_assistant_owner', 'taken');
        await h.settle();

        expect(h.homey.notificationsSent).toHaveLength(2);
    });

    it('stays off the timeline on suspicion alone', async () => {
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('voice_assistant_owner', 'suspected');
        await h.settle();

        expect(h.homey.notificationsSent).toHaveLength(0);
    });

    it('clears the warning when the satellite starts answering', async () => {
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('voice_assistant_owner', 'taken');
        await h.settle();
        expect((h.device as any).warning).not.toBeNull();

        h.esp.emit('voice_assistant_owner', 'ok');
        await h.settle();
        expect((h.device as any).warning).toBeNull();
    });

    it('spells it out in the log dump, where a bug report will carry it', async () => {
        // diagnosticSummary() is the Devices block of every log dump. Issue #54
        // arrived with one that said "satellite connected, engine connected" and
        // nothing else — which was true, and useless.
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('voice_assistant_owner', 'taken');
        await h.settle();

        expect((h.device as any).diagnosticSummary()).toMatch(/VOICE ASSISTANT OWNED BY ANOTHER CLIENT/);
    });

    it('mentions the suspicion in the log dump even though it does not warn', async () => {
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('voice_assistant_owner', 'suspected');
        await h.settle();

        expect((h.device as any).diagnosticSummary()).toMatch(/possibly owned by another client/);
    });
});
