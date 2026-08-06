// VoiceAssistantEventResponse carries payload ONLY in its repeated `data`
// field. Anything set as a plain property (`{ text }`) is an unknown field that
// protobufjs drops on encode — silently, since proto3 has no strict mode to
// complain with. That is how the STT_END transcript and the ERROR code/message
// went missing for a long time while the code looked correct.
//
// So these tests deliberately assert on the ENCODED bytes, round-tripped back
// through the real api.proto: a payload-shape assertion against the object we
// hand to send() would have passed happily throughout the whole bug.
import { describe, it, expect, beforeEach } from 'vitest';
import { EspVoiceAssistantClient } from '../src/voice_assistant/esp-voice-assistant-client.mjs';
import { encodeBody, decodeBody, VA_EVENT } from '../src/voice_assistant/esp-messages.mjs';

/** The homey surface the client touches while sending. */
const fakeHomey = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (t: any) => clearTimeout(t),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (t: any) => clearInterval(t),
};

interface SentEvent {
  eventType: number;
  data: { name: string; value: string }[];
}

/**
 * A client whose outgoing events are run through the same protobuf encode the
 * socket would do, then decoded back — so the tests see what the device would
 * actually receive, not what we meant to send.
 */
function makeClient() {
  const sent: SentEvent[] = [];
  const client: any = new EspVoiceAssistantClient(fakeHomey as any, { host: '127.0.0.1' });

  client.send = (name: string, payload: any) => {
    expect(name).toBe('VoiceAssistantEventResponse');
    const { id, body } = encodeBody(name, payload);
    const decoded: any = decodeBody(id, body).message;
    sent.push({
      eventType: decoded.eventType,
      data: (decoded.data ?? []).map((d: any) => ({ name: d.name, value: d.value })),
    });
  };

  return { client, sent };
}

let client: any;
let sent: SentEvent[];

beforeEach(() => {
  ({ client, sent } = makeClient());
});

describe('VoiceAssistantEvent payloads survive protobuf encoding', () => {
  it('STT_END carries the transcript', () => {
    client.stt_end('Hvor mye er klokka?');

    expect(sent).toHaveLength(1);
    expect(sent[0].eventType).toBe(VA_EVENT.VOICE_ASSISTANT_STT_END);
    expect(sent[0].data).toEqual([{ name: 'text', value: 'Hvor mye er klokka?' }]);
  });

  it('STT_END with an empty transcript sends the bare event', () => {
    // The firmware discards a text-less STT_END; an empty turn has no text to
    // give it, and inventing one would fire on_stt_end with nothing in it.
    client.stt_end('');
    expect(sent[0].data).toEqual([]);
  });

  it('ERROR carries both the code and the message', () => {
    client.pipeline_error('agent-not-connected', 'Voice agent is not connected.');

    expect(sent[0].eventType).toBe(VA_EVENT.VOICE_ASSISTANT_ERROR);
    expect(sent[0].data).toEqual([
      { name: 'code', value: 'agent-not-connected' },
      { name: 'message', value: 'Voice agent is not connected.' },
    ]);
  });

  it('INTENT_PROGRESS carries the reply delta, spacing intact', () => {
    client.intent_progress(' er');
    expect(sent[0].data).toEqual([{ name: 'chat_log_delta', value: ' er' }]);
  });

  it('INTENT_PROGRESS keeps a whitespace-only delta', () => {
    // The model emits a lone " " between words; dropping it as "empty" is how
    // the reply ended up reading "Klokka er19:03.".
    client.intent_progress(' ');
    expect(sent[0].data).toEqual([{ name: 'chat_log_delta', value: ' ' }]);
  });

  it('INTENT_END carries the text and the continue_conversation flag', () => {
    client.intent_end('done', false);
    expect(sent[0].data).toEqual([
      { name: 'text', value: 'done' },
      { name: 'continue_conversation', value: '0' },
    ]);
  });

  it('INTENT_END leaves the flag untouched when it is not given', () => {
    // The firmware's flag is sticky — omitting the value must send nothing at
    // all rather than a default.
    client.intent_end('');
    expect(sent[0].data).toEqual([]);
  });

  it('TTS_START carries the reply text and TTS_END the audio URL', () => {
    client.tts_start('Klokka er 19:03.');
    client.tts_end('http://10.0.0.2/app/x/userdata/audio/reply.flac');

    expect(sent[0].data).toEqual([{ name: 'text', value: 'Klokka er 19:03.' }]);
    expect(sent[1].data).toEqual([
      { name: 'url', value: 'http://10.0.0.2/app/x/userdata/audio/reply.flac' },
    ]);
  });

  it('sends the payload-less events with no data at all', () => {
    client.run_start();
    client.wake_word_end();
    client.stt_start();
    client.stt_vad_start();
    client.stt_vad_end('');
    client.intent_start();
    client.tts_start();
    client.tts_end();
    client.run_end();

    expect(sent).toHaveLength(9);
    for (const e of sent) {
      expect(e.data).toEqual([]);
    }
  });
});
