// ESPHome tracks exactly ONE voice-assistant client. The second subscriber is
// rejected with nothing but a device-side ESP_LOGE, so from here the connection
// looks perfect while every voice message is discarded — GitHub issue #54: an
// hour of logs, a healthy satellite, a connected engine, and not one voice
// request, because Home Assistant still held the slot.
//
// These tests pin the two signals that make that state visible. Both are read
// off the REAL client through real protobuf frames, because both depend on
// ESPHome's exact wire behaviour rather than on anything we control:
//   #1 an EMPTY VoiceAssistantConfigurationResponse — what
//      send_voice_assistant_get_configuration_response_() returns to a
//      non-owner (suspicion: a satellite with no on-board wake words looks the
//      same, and must NOT be reported as broken)
//   #2 a mic-open that is never answered (proof)
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EspVoiceAssistantClient, VaOwnerState } from '../src/voice_assistant/esp-voice-assistant-client.mjs';
import { encodeFrame } from '../src/voice_assistant/esp-messages.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

/** VOICE_ASSISTANT | API_AUDIO | ... — what a real PE advertises (issue #54's log). */
const PE_FEATURE_FLAGS = 125;

function makeClient() {
    const client = new EspVoiceAssistantClient(new MockHomey(), {
        host: '127.0.0.1',
        logLevel: 0,
    });
    const states: VaOwnerState[] = [];
    client.on('voice_assistant_owner', (s) => states.push(s));
    // Swallow the outgoing announce: there is no socket, and what we assert on
    // is the silence that follows it. Reconnects are somebody else's test
    // (reconnect-policy.test.mts) and would only dial 127.0.0.1:6053 here.
    (client as any).send = () => { };
    (client as any).scheduleReconnect = () => { };
    return { client, states };
}

/** Bring a client up to "connected, entities listed, device info known". */
async function connect(client: EspVoiceAssistantClient, featureFlags = PE_FEATURE_FLAGS) {
    await (client as any).onTcpData(encodeFrame('HelloResponse', { apiVersionMajor: 1, apiVersionMinor: 14 }));
    await (client as any).onTcpData(encodeFrame('DeviceInfoResponse', {
        name: 'home-assistant-voice-0a6667',
        manufacturer: 'Nabu Casa',
        model: 'Home Assistant Voice PE',
        voiceAssistantFeatureFlags: featureFlags,
    }));
}

async function sendConfig(client: EspVoiceAssistantClient, wakeWords: string[]) {
    await (client as any).onTcpData(encodeFrame('VoiceAssistantConfigurationResponse', {
        availableWakeWords: wakeWords.map((id) => ({ id, wakeWord: id, trainedLanguages: ['en'] })),
        activeWakeWords: wakeWords.slice(0, 1),
        maxActiveWakeWords: 1,
    }));
}

afterEach(() => {
    vi.useRealTimers();
});

describe('signal #1: the wake-word list ESPHome sends a non-owner', () => {
    it('reports a stolen subscription when the list comes back empty', async () => {
        const { client, states } = makeClient();
        await connect(client);
        await sendConfig(client, []);

        expect(states).toEqual(['suspected']);
        expect(client.voiceAssistantOwner).toBe('suspected');
    });

    it('reports ownership when the satellite lists its wake words', async () => {
        // A non-owner never gets here: the unsubscribed branch returns before it
        // copies a single wake word, so a populated list is proof of ownership.
        const { client, states } = makeClient();
        await connect(client);
        await sendConfig(client, ['okay_nabu', 'hey_jarvis']);

        expect(states).toEqual(['ok']);
    });

    it('says nothing about a device that has no voice assistant at all', async () => {
        // Zero feature flags = the voice_assistant component is not compiled in.
        // There is no subscription to lose, so an empty list means nothing.
        const { client, states } = makeClient();
        await connect(client, 0);
        await sendConfig(client, []);

        expect(states).toEqual([]);
        expect(client.voiceAssistantOwner).toBeNull();
    });
});

describe('signal #2: a mic-open the satellite never answers', () => {
    it('is proof the subscription is held elsewhere', async () => {
        vi.useFakeTimers();
        const { client, states } = makeClient();
        await connect(client);
        await sendConfig(client, []);

        client.send_voice_assistant_request('http://homey/chime.flac');
        vi.advanceTimersByTime(10_000);

        expect(states).toEqual(['suspected', 'taken']);
    });

    it('stays quiet when the announce is acknowledged', async () => {
        vi.useFakeTimers();
        const { client, states } = makeClient();
        await connect(client);
        await sendConfig(client, []);

        client.send_voice_assistant_request('http://homey/chime.flac');
        await (client as any).onTcpData(encodeFrame('VoiceAssistantAnnounceFinished', { success: true }));
        vi.advanceTimersByTime(10_000);

        // on_voice_assistant_announce_request() is owner-gated, so an announce
        // that finishes clears the empty-wake-word-list suspicion outright —
        // this is the satellite that simply has no wake words on board.
        expect(states).toEqual(['suspected', 'ok']);
    });

    it('is cleared by the device opening a conversation on its own', async () => {
        vi.useFakeTimers();
        const { client, states } = makeClient();
        await connect(client);
        await sendConfig(client, []);

        client.send_voice_assistant_request('');
        await (client as any).onTcpData(encodeFrame('VoiceAssistantRequest', { start: true }));
        vi.advanceTimersByTime(10_000);

        expect(states).toEqual(['suspected', 'ok']);
    });

    it('does not fire for a mic-open that outlives its connection', async () => {
        vi.useFakeTimers();
        const { client, states } = makeClient();
        await connect(client);
        await sendConfig(client, ['okay_nabu']);

        client.send_voice_assistant_request('');
        client.handleDisconnect();
        vi.advanceTimersByTime(10_000);

        // A satellite that went away answers nothing; that says nothing about
        // who owns its voice assistant.
        expect(states).toEqual(['ok']);
    });
});

describe('the verdict belongs to one connection', () => {
    it('is re-derived after a reconnect instead of carried over', async () => {
        const { client, states } = makeClient();
        await connect(client);
        await sendConfig(client, []);
        expect(states).toEqual(['suspected']);

        // Reconnect: HA has let go, and this time we win the slot.
        client.handleDisconnect();
        await connect(client);
        await sendConfig(client, ['okay_nabu']);

        expect(states).toEqual(['suspected', 'ok']);
        expect(client.voiceAssistantOwner).toBe('ok');
    });

    it('does not re-emit an unchanged verdict on every config response', async () => {
        // setActiveWakeWords() re-requests the configuration, and reconnects
        // re-run the whole handshake; neither is news.
        const { client, states } = makeClient();
        await connect(client);
        await sendConfig(client, []);
        await sendConfig(client, []);
        await sendConfig(client, []);

        expect(states).toEqual(['suspected']);
    });
});
