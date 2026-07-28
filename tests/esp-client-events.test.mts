// Event-entity handling and device-type sniffing in the REAL EspVoiceAssistantClient.
// No TCP: identity frames are encoded with the real protobuf layer and fed through
// onTcpData (where the sniff lives); entity/state messages go straight to dispatch.
import { describe, it, expect } from 'vitest';
import { EspVoiceAssistantClient } from '../src/voice_assistant/esp-voice-assistant-client.mjs';
import { encodeFrame } from '../src/voice_assistant/esp-messages.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

function makeClient(discoveryMode = false): EspVoiceAssistantClient {
    return new EspVoiceAssistantClient(new MockHomey(), {
        host: '127.0.0.1',
        discoveryMode,
        logLevel: 0,
    });
}

describe('identity sniff (discovery probe)', () => {
    async function sniff(deviceInfo: Record<string, any>): Promise<string | null> {
        const client = makeClient(true);
        // HelloResponse establishes the connection (no ConnectResponse gating),
        // DeviceInfoResponse carries the identity fields the sniff matches on.
        await (client as any).onTcpData(encodeFrame('HelloResponse', { apiVersionMajor: 1, apiVersionMinor: 10 }));
        await (client as any).onTcpData(encodeFrame('DeviceInfoResponse', deviceInfo));
        return (client as any).deviceType;
    }

    it('classifies the ThirdReality Voice & Music Assistant as its own "tr" type', async () => {
        expect(await sniff({
            name: '3rspk-a1b2c3',
            manufacturer: 'ThirdReality',
            model: 'Linux Voice Assistant',
            projectName: 'ThirdReality.Linux Voice Assistant (C++)',
        })).toBe('tr');
    });

    it('matches the 3RSPK device name alone (HelloResponse-style identity)', async () => {
        const client = makeClient(true);
        await (client as any).onTcpData(encodeFrame('HelloResponse', { name: '3RSPK-A1B2C3' }));
        expect((client as any).deviceType).toBe('tr');
    });

    it('still classifies the Voice PE as "pe"', async () => {
        expect(await sniff({
            name: 'home-assistant-voice-09xyz',
            manufacturer: 'Nabu Casa',
            model: 'Home Assistant Voice PE',
        })).toBe('pe');
    });

    it('still classifies XiaoZhi as "xiaozhi"', async () => {
        expect(await sniff({ name: 'xiaozhi-ai-thing' })).toBe('xiaozhi');
    });

    it('classifies the ReSpeaker XVF3800 as "respeaker" (stock example config identity)', async () => {
        expect(await sniff({
            name: 'respeaker-xvf3800-assistant',
            friendlyName: 'reSpeaker XVF3800 Assistant',
            projectName: 'formatbce.Respeaker XVF3800 Satellite',
            projectVersion: '2026.6.0',
            manufacturer: 'Espressif',
            model: 'esp32-s3-devkitc-1',
        })).toBe('respeaker');
    });

    it('matches a renamed ReSpeaker as long as a product token survives', async () => {
        // The firmware is user-compiled, so only the product tokens are stable.
        expect(await sniff({ name: 'kitchen-respeaker' })).toBe('respeaker');
        expect(await sniff({ name: 'xvf3800-hallway' })).toBe('respeaker');
    });
});

describe('mute switch discovery (ListEntitiesSwitchResponse)', () => {
    async function registerSwitches(objectIds: string[]): Promise<number | undefined> {
        const client = makeClient();
        let key = 1;
        for (const objectId of objectIds) {
            await (client as any).dispatch({
                name: 'ListEntitiesSwitchResponse',
                message: { objectId, key: key++ },
            });
        }
        return (client as any).entityKeys['mute'];
    }

    it('uses a switch named exactly "mute" (PE / ThirdReality)', async () => {
        expect(await registerSwitches(['mute'])).toBe(1);
    });

    it('finds the ReSpeaker\'s "microphone_mute" switch', async () => {
        expect(await registerSwitches(['microphone_mute'])).toBe(1);
    });

    it('ignores "mute_sound", which only toggles the mute chime', async () => {
        // The ReSpeaker config lists mute_sound BEFORE the mic mute, so a naive
        // first-match-wins substring test would pick the wrong switch here.
        expect(await registerSwitches(['mute_sound', 'wake_sound', 'microphone_mute'])).toBe(3);
    });

    it('leaves mute unset when no switch looks like a mic mute', async () => {
        expect(await registerSwitches(['mute_sound', 'beam_lock', 'alarm_on'])).toBeUndefined();
    });

    it('prefers an exact "mute" over a mic-mute variant regardless of order', async () => {
        expect(await registerSwitches(['microphone_mute', 'mute'])).toBe(2);
        expect(await registerSwitches(['mute', 'microphone_mute'])).toBe(1);
    });
});

describe('Event entities (EventResponse)', () => {
    it('emits entity_event with the object_id and event type of a registered Event entity', async () => {
        const client = makeClient();
        const events: Array<[string, string]> = [];
        client.on('entity_event', (objectId, eventType) => events.push([objectId, eventType]));

        await (client as any).dispatch({
            name: 'ListEntitiesEventResponse',
            message: { objectId: 'button_press', key: 42, eventTypes: ['single_press'] },
        });
        await (client as any).dispatch({
            name: 'EventResponse',
            message: { key: 42, eventType: 'single_press' },
        });

        expect(events).toEqual([['button_press', 'single_press']]);
    });

    it('still emits (with an empty object_id) for an unregistered key', async () => {
        const client = makeClient();
        const events: Array<[string, string]> = [];
        client.on('entity_event', (objectId, eventType) => events.push([objectId, eventType]));

        await (client as any).dispatch({
            name: 'EventResponse',
            message: { key: 7, eventType: 'press' },
        });

        expect(events).toEqual([['', 'press']]);
    });
});
