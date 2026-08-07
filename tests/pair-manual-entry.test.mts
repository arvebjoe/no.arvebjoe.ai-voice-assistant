// Manual IP entry pairing: which devices the probe accepts.
//
// The rule under test is deliberately laxer than discovery's. Typing an IP is
// the user asserting the model, and DIY ESPHome firmware (M5Stack, ReSpeaker)
// identifies itself ONLY through the user-editable name/friendly_name — so a
// renamed device carries no product token and cannot be identified at all.
// Rejecting those left users with an error they had no way to act on.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { instances } = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock('homey', () => import('./mocks/mock-homey-sdk.mjs'));
vi.mock('../src/voice_assistant/esp-voice-assistant-client.mjs', async () => {
    const mod = await import('./mocks/mock-esp-client.mjs');
    // Track every client the driver constructs so the test can drive its events.
    class TrackedEspClient extends mod.EspVoiceAssistantClient {
        constructor(homey: any, opts: any) {
            super(homey, opts);
            instances.push(this);
        }
    }
    return { EspVoiceAssistantClient: TrackedEspClient };
});

import VoiceAssistantDriver from '../src/homey/voice-assistant-driver.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

class M5StackTestDriver extends VoiceAssistantDriver {
    readonly thisAssistantType = 'm5stack';
}

/** Full voice-assistant handshake counts (media player + VA subscribe + VA config). */
const CAPABLE = [1, 1, 1] as const;

/**
 * Run a manual probe and answer it with one `capabilities` event, as the ESP
 * client would after a successful (optionally encrypted) handshake.
 */
async function probeAnsweringWith(
    deviceType: string | null,
    counts: readonly [number, number, number] = CAPABLE,
): Promise<{ device: any; reason: string }> {
    const homey: any = new MockHomey();
    const driver = new (M5StackTestDriver as any)({ homey });

    const pending = (driver as any).probeManualEntry('192.168.1.50', 6053);

    // The client is constructed synchronously inside the probe.
    const client = instances.at(-1);
    expect(client, 'probe should have constructed an ESP client').toBeTruthy();
    client.macAddress = 'acbc32890ea9';
    client.friendlyName = 'Mikro EG';
    client.emit('capabilities', counts[0], counts[1], counts[2], deviceType);

    return pending;
}

describe('manual IP entry — device acceptance', () => {
    beforeEach(() => {
        instances.length = 0;
    });

    it('accepts a voice-capable device the sniff could not identify (renamed DIY firmware)', async () => {
        const { device, reason } = await probeAnsweringWith(null);

        expect(reason).toBe('ok');
        expect(device).toBeTruthy();
        expect(device.name).toBe('Mikro EG');
        // Paired AS the driver the user chose, rather than left null.
        expect(device.store.deviceType).toBe('m5stack');
        expect(device.data.id).toBe('acbc32890ea9');
    });

    it('accepts a device that identified as this driver\'s own model', async () => {
        const { device, reason } = await probeAnsweringWith('m5stack');

        expect(reason).toBe('ok');
        expect(device.store.deviceType).toBe('m5stack');
    });

    it('rejects a device that identified as a different model (wrong driver)', async () => {
        const { device, reason } = await probeAnsweringWith('pe');

        expect(reason).toBe('not_a_match');
        expect(device).toBeNull();
    });

    it('rejects an unidentified device that is not voice-capable', async () => {
        // No media player entity — a plain ESPHome node, not a voice satellite.
        const { device, reason } = await probeAnsweringWith(null, [0, 1, 1]);

        expect(reason).toBe('not_a_match');
        expect(device).toBeNull();
    });

    it('rejects an unidentified device with no voice-assistant configuration', async () => {
        const { device, reason } = await probeAnsweringWith(null, [1, 1, 0]);

        expect(reason).toBe('not_a_match');
        expect(device).toBeNull();
    });
});
