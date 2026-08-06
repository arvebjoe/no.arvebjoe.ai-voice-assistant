// The virtual satellite stands in for real firmware, so the behaviours the
// device code depends on have to hold exactly — a mismatch here shows up as a
// turn that hangs or a conversation that never closes, which is precisely the
// class of bug the emulator exists to catch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalAudioEspClient, ToPage } from '../emulator/runtime/virtual-satellite/local-audio-esp-client.mjs';

function makeClient() {
  const client = new LocalAudioEspClient({ id: 'AA:BB:CC:00:00:01', name: 'Desk', zone: 'Living Room' });
  const sent: ToPage[] = [];
  const page = (msg: ToPage) => { sent.push(msg); };
  return { client, sent, page };
}

/** Play the URL the client just asked for, as the browser page would. */
function ackPlayback(client: LocalAudioEspClient, sent: ToPage[]) {
  const play = [...sent].reverse().find((m) => m.t === 'play') as Extract<ToPage, { t: 'play' }> | undefined;
  expect(play, 'expected a play message').toBeDefined();
  client.handlePageMessage({ t: 'played', id: play!.id });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('LocalAudioEspClient — connection', () => {
  it('comes up healthy at once and reports its capabilities like a completed handshake', async () => {
    const { client } = makeClient();
    const healthy = vi.fn();
    const caps = vi.fn();
    client.on('Healthy', healthy);
    client.on('capabilities', caps);

    await client.start();
    expect(healthy).toHaveBeenCalled();
    // Deferred: the device's capabilities handler talks to the provider, which
    // onInit only starts after esp.start() resolves.
    expect(caps).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(caps).toHaveBeenCalled();
    expect(client.isConnected).toBe(true);
    expect(client.supportsTimers).toBe(true);
  });
});

describe('LocalAudioEspClient — announce path', () => {
  it('reports announce_finished when the page finishes playing', () => {
    const { client, sent, page } = makeClient();
    client.attachPage(page);
    const finished = vi.fn();
    client.on('announce_finished', finished);

    client.playAudioFromUrl('http://host/userdata/audio/reply.flac', false);
    expect(finished).not.toHaveBeenCalled();

    ackPlayback(client, sent);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it('opens the mic after a start-conversation announce', () => {
    const { client, sent, page } = makeClient();
    client.attachPage(page);
    const starting = vi.fn();
    client.on('starting', starting);

    client.playAudioFromUrl('http://host/userdata/audio/reply.flac', true);
    ackPlayback(client, sent);
    expect(starting).toHaveBeenCalledTimes(1);
  });

  it('swallows announce_finished for the mic-reopen announce, but still opens the mic', () => {
    // The real client does this with shouldAnnounceFinished; without it the
    // reopen would dequeue an unrelated announce queue and end the run early.
    const { client, sent, page } = makeClient();
    client.attachPage(page);
    const finished = vi.fn();
    const starting = vi.fn();
    client.on('announce_finished', finished);
    client.on('starting', starting);

    client.send_voice_assistant_request('http://host/userdata/audio/chime.flac');
    ackPlayback(client, sent);

    expect(finished).not.toHaveBeenCalled();
    expect(starting).toHaveBeenCalledTimes(1);
  });

  it('plays announces one at a time, in order', () => {
    const { client, sent, page } = makeClient();
    client.attachPage(page);

    client.playAudioFromUrl('http://host/userdata/audio/one.flac', false);
    client.playAudioFromUrl('http://host/userdata/audio/two.flac', false);

    const plays = () => sent.filter((m) => m.t === 'play') as Extract<ToPage, { t: 'play' }>[];
    expect(plays()).toHaveLength(1);
    expect(plays()[0].url).toContain('one.flac');

    ackPlayback(client, sent);
    expect(plays()).toHaveLength(2);
    expect(plays()[1].url).toContain('two.flac');
  });

  it('completes playback on its own when no page is attached, so a turn cannot hang', () => {
    const { client } = makeClient();
    const finished = vi.fn();
    client.on('announce_finished', finished);

    client.playAudioFromUrl('http://host/userdata/audio/reply.flac', false);
    expect(finished).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it('completes playback when the page never acks', () => {
    const { client, page } = makeClient();
    client.attachPage(page);
    const finished = vi.fn();
    client.on('announce_finished', finished);

    client.playAudioFromUrl('http://host/userdata/audio/reply.flac', false);
    vi.advanceTimersByTime(61_000);
    expect(finished).toHaveBeenCalledTimes(1);
  });
});

describe('LocalAudioEspClient — in-band reply path', () => {
  it('reopens the mic after the reply when the pipeline kept the conversation open', () => {
    const { client, sent, page } = makeClient();
    client.attachPage(page);
    const starting = vi.fn();
    client.on('starting', starting);

    client.intent_end('', true);
    client.tts_end('http://host/userdata/audio/reply.flac');
    expect(starting).not.toHaveBeenCalled();

    ackPlayback(client, sent);
    expect(starting).toHaveBeenCalledTimes(1);
  });

  it('closes the conversation when the pipeline said not to continue', () => {
    const { client, sent, page } = makeClient();
    client.attachPage(page);
    const starting = vi.fn();
    client.on('starting', starting);

    client.intent_end('', false);
    client.tts_end('http://host/userdata/audio/reply.flac');
    ackPlayback(client, sent);

    expect(starting).not.toHaveBeenCalled();
  });

  it('keeps the continue_conversation flag sticky when the event omits it', () => {
    const { client, sent, page } = makeClient();
    client.attachPage(page);
    const starting = vi.fn();
    client.on('starting', starting);

    client.intent_end('', true);
    client.intent_end(''); // no explicit value — the firmware keeps the old one
    client.tts_end('http://host/userdata/audio/reply.flac');
    ackPlayback(client, sent);

    expect(starting).toHaveBeenCalledTimes(1);
  });

  it('never reports announce_finished for an in-band reply', () => {
    const { client, sent, page } = makeClient();
    client.attachPage(page);
    const finished = vi.fn();
    client.on('announce_finished', finished);

    client.tts_end('http://host/userdata/audio/reply.flac');
    ackPlayback(client, sent);
    expect(finished).not.toHaveBeenCalled();
  });
});

describe('LocalAudioEspClient — reply text', () => {
  const replies = (sent: ToPage[]) => sent.filter((m) => m.t === 'reply') as Extract<ToPage, { t: 'reply' }>[];

  it('accumulates streamed deltas into one growing line per turn', () => {
    // INTENT_PROGRESS carries a chat_log_delta, so the page must be able to
    // rewrite one line rather than log a line per delta.
    const { client, sent, page } = makeClient();
    client.attachPage(page);

    client.run_start();
    // Verbatim, including the lone space the model emits between words — a
    // dropped or trimmed delta glues the reply together ("Klokka er19:03.").
    const deltas = ['Kl', 'okka', ' er', ' ', '19', ':', '03', '.'];
    for (const d of deltas) client.intent_progress(d);

    const out = replies(sent);
    expect(out.map((m) => m.id)).toEqual(new Array(deltas.length).fill(out[0].id));
    expect(out[out.length - 1].text).toBe('Klokka er 19:03.');
  });

  it('starts a new line for the next turn', () => {
    const { client, sent, page } = makeClient();
    client.attachPage(page);

    client.run_start();
    client.intent_progress('First');
    client.run_end();
    client.run_start();
    client.intent_progress('Second');

    const out = replies(sent);
    expect(out[0].text).toBe('First');
    expect(out[1].text).toBe('Second');
    expect(out[1].id).not.toBe(out[0].id);
  });

  it('lets the complete in-band reply text replace what the deltas built', () => {
    const { client, sent, page } = makeClient();
    client.attachPage(page);

    client.run_start();
    client.intent_progress('Turning');
    client.tts_start('Turning on the kitchen light.');

    const out = replies(sent);
    expect(out[out.length - 1].text).toBe('Turning on the kitchen light.');
    expect(out[out.length - 1].id).toBe(out[0].id);
  });
});

describe('LocalAudioEspClient — microphone', () => {
  it('forwards page audio as chunk events', () => {
    const { client } = makeClient();
    const chunks: Buffer[] = [];
    client.on('chunk', (c: Buffer) => chunks.push(c));

    client.pushMicAudio(Buffer.alloc(1024));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1024);
  });

  it('drops audio while muted, and reports the mute to the app', () => {
    const { client } = makeClient();
    const chunks: Buffer[] = [];
    const muted = vi.fn();
    client.on('chunk', (c: Buffer) => chunks.push(c));
    client.on('mute', muted);

    client.setMute(true);
    client.pushMicAudio(Buffer.alloc(1024));

    expect(chunks).toHaveLength(0);
    expect(muted).toHaveBeenCalledWith(true);
  });

  it('tells the page when to capture and when to stop', () => {
    const { client, sent, page } = makeClient();
    client.attachPage(page);

    client.begin_mic_capture();
    client.closeMic();

    const mic = sent.filter((m) => m.t === 'mic') as Extract<ToPage, { t: 'mic' }>[];
    expect(mic.map((m) => m.on)).toEqual([true, false]);
  });
});

describe('LocalAudioEspClient — page state', () => {
  it('walks the phases of a turn', () => {
    const { client, sent, page } = makeClient();
    client.attachPage(page);
    const phases = () => (sent.filter((m) => m.t === 'phase') as Extract<ToPage, { t: 'phase' }>[])
      .map((m) => m.phase);

    client.run_start();
    client.begin_mic_capture();
    client.stt_vad_start();
    client.intent_start();
    client.tts_start('Turning on the light');
    client.run_end();

    expect(phases()).toEqual(['idle', 'listening', 'hearing', 'thinking', 'replying', 'idle']);
  });

  it('stays in replying until queued audio has actually played', () => {
    // The device ends the run right after handing over the in-band URL, so the
    // queue — not run_end — decides when the satellite is idle again.
    const { client, sent, page } = makeClient();
    client.attachPage(page);

    client.tts_start('Here you go');
    client.tts_end('http://host/userdata/audio/reply.flac');
    client.run_end();

    const last = (sent.filter((m) => m.t === 'phase') as Extract<ToPage, { t: 'phase' }>[]).pop();
    expect(last!.phase).toBe('replying');

    ackPlayback(client, sent);
    const after = (sent.filter((m) => m.t === 'phase') as Extract<ToPage, { t: 'phase' }>[]).pop();
    expect(after!.phase).toBe('idle');
  });
});
