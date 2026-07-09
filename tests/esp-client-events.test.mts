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
