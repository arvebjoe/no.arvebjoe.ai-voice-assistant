// A stand-in for EspVoiceAssistantClient whose "hardware" is the mic and
// speaker of the machine running the emulator, reached through a browser page
// (see hub.mts + satellite.html). No device on the LAN, no ESPHome protocol.
//
// It implements the same surface VoiceAssistantDevice consumes, so the device,
// provider, tool and reply paths all run completely unchanged:
//
//   upward   'Healthy'/'Unhealthy', 'capabilities', 'wake_words', 'starting',
//            'chunk' (16 kHz s16le mic audio), 'announce_finished',
//            'volume', 'mute'
//   downward the run/stt/intent/tts pipeline events (rendered as UI state),
//            playAudioFromUrl / send_voice_assistant_request / tts_end(url)
//            (played in the browser), setVolume/setMute, timer events
//
// Firmware behaviours that the device code depends on and that are therefore
// reproduced here, not faked away:
//   - an announce ends with AnnounceFinished -> 'announce_finished', EXCEPT the
//     mic-reopen announce (send_voice_assistant_request), which the real client
//     swallows via shouldAnnounceFinished;
//   - an announce with startConversation:true opens the mic when playback ends,
//     i.e. the device sends a new wake ('starting') by itself;
//   - after an in-band reply (tts_end with a URL) the PE reopens the mic itself
//     when the pipeline asked to continue the conversation (INTENT_END
//     continue_conversation '1'), so the follow-up chain keeps flowing.
import EventEmitter from 'node:events';
import { createLogger } from '../../../src/helpers/logger.mjs';

/** Mirrors EspWakeWord from the real client. */
export interface FakeWakeWord {
  id: string;
  wakeWord: string;
  trainedLanguages: string[];
}

/** UI phase shown on the satellite page; derived from the pipeline events. */
export type SatellitePhase = 'idle' | 'listening' | 'hearing' | 'thinking' | 'replying';

/** Everything the client pushes to the browser page. */
export type ToPage =
  | { t: 'hello'; name: string; zone: string; id: string; volume: number; muted: boolean }
  | { t: 'phase'; phase: SatellitePhase }
  | { t: 'mic'; on: boolean }
  | { t: 'play'; id: number; url: string; kind: 'announce' | 'inband' | 'chime' }
  | { t: 'said'; text: string }
  // One reply per `id` (a turn): the text is the whole reply so far, so the page
  // updates a single line instead of appending one per streamed delta.
  | { t: 'reply'; id: number; text: string }
  | { t: 'error'; code: string; message: string }
  | { t: 'volume'; value: number }
  | { t: 'muted'; value: boolean }
  | { t: 'timer'; name: string; secondsLeft: number; totalSeconds: number; isActive: boolean };

/** Everything the browser page sends back. */
export type FromPage =
  | { t: 'wake' }
  | { t: 'played'; id: number; error?: string }
  | { t: 'volume'; value: number }
  | { t: 'muted'; value: boolean };

export interface LocalAudioEspClientOptions {
  /** Stable id (the satellite's MAC) — also the page's ?sat= key. */
  id: string;
  name: string;
  zone: string;
}

/** A play request waiting for the page (or the headless timer) to finish it. */
interface PendingPlay {
  id: number;
  url: string;
  kind: 'announce' | 'inband' | 'chime';
  done: () => void;
}

// How long a play is assumed to take when no browser is attached. Without this
// the announce queue would never drain and the turn would hang forever.
const HEADLESS_PLAYBACK_MS = 400;
// Hard ceiling on waiting for the page's 'played' ack (a closed tab, a failed
// fetch we never heard about). Long enough for any real reply.
const PLAYBACK_WATCHDOG_MS = 60_000;

export class LocalAudioEspClient extends EventEmitter {
  readonly id: string;
  readonly name: string;
  readonly zone: string;

  private logger = createLogger('VSAT', false);
  private connected = false;
  private page: ((msg: ToPage) => void) | null = null;

  private volume = 0.5;
  private muted = false;
  private phase: SatellitePhase = 'idle';

  // Playback is strictly serial, like a single media player.
  private playSeq = 0;
  private queue: PendingPlay[] = [];
  private active: PendingPlay | null = null;
  private watchdog: NodeJS.Timeout | null = null;

  // Mirrors the real client's shouldAnnounceFinished: the mic-reopen announce
  // must NOT surface an 'announce_finished' (it would dequeue someone else's
  // announce queue and end the run early).
  private suppressNextAnnounceFinished = false;
  // Last continue_conversation the pipeline asked for on INTENT_END. Decides
  // whether the PE reopens its mic after an in-band reply.
  private continueConversation = false;

  // The reply is streamed as chat_log_delta chunks (INTENT_PROGRESS); the page
  // shows one growing line per turn, so accumulate them here. run_start opens
  // the next turn's line.
  private replyId = 0;
  private replyText = '';

  private wakeWords: FakeWakeWord[] = [
    { id: 'okay_nabu', wakeWord: 'Okay Nabu', trainedLanguages: ['en'] },
    { id: 'hey_jarvis', wakeWord: 'Hey Jarvis', trainedLanguages: ['en'] },
  ];
  private activeWakeWords: string[] = ['okay_nabu'];

  constructor({ id, name, zone }: LocalAudioEspClientOptions) {
    super();
    this.id = id;
    this.name = name;
    this.zone = zone;
  }

  //
  // Lifecycle — the "hardware" is always there, so it comes up healthy at once
  // whether or not a browser page is open. That keeps `ask`/`say` usable
  // headless; only mic and speaker need the page.
  //

  async start(): Promise<void> {
    this.connected = true;
    this.emit('Healthy');
    // Deferred like the real handshake: the device's 'capabilities' handler
    // talks to the provider, which onInit() only starts after esp.start().
    setTimeout(() => {
      if (!this.connected) return;
      this.emit('wake_words', this.getAvailableWakeWords(), this.getActiveWakeWords(), 1);
      // mediaPlayers=1, subscribeVoiceAssistant=1, voiceAssistantConfiguration=1
      this.emit('capabilities', 1, 1, 1, 'pe');
    }, 50);
  }

  async disconnect(): Promise<boolean> {
    this.connected = false;
    this.clearPlayback();
    this.emit('Unhealthy');
    return true;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** The virtual satellite always claims the TIMERS feature flag. */
  get supportsTimers(): boolean {
    return true;
  }

  getMacAddress(): string {
    return this.id;
  }

  getFriendlyName(): string {
    return this.name;
  }

  // No-ops: there is no host to point at and no encryption to negotiate.
  setHost(_address: string): void { /* virtual */ }
  setEncryptionKey(_key: string | undefined): void { /* virtual */ }
  scheduleReconnect(): void { /* virtual */ }
  subscribeToMediaPlayerState(): void { /* virtual */ }

  //
  // Pipeline events (device -> satellite). The firmware renders these on the
  // LED ring; we render them as the page's phase + transcript.
  //

  run_start(): void {
    // Phase follows begin_mic_capture / tts_start; a run only starts a new
    // reply line.
    this.replyId++;
    this.replyText = '';
  }

  run_end(): void {
    this.toPage({ t: 'mic', on: false });
    // In-band replies are still queued at run_end (the device sends the audio
    // URL on TTS_END and ends the run right away) — the queue decides when the
    // satellite is really idle again.
    if (!this.active && this.queue.length === 0) this.setPhase('idle');
  }

  pipeline_error(code: string, message: string): void {
    this.logger.warn(`pipeline error: ${code} — ${message}`);
    this.toPage({ t: 'error', code, message });
    this.setPhase('idle');
  }

  wake_word_end(): void { /* nothing to show */ }

  stt_start(): void { /* the mic opens on begin_mic_capture */ }

  stt_end(text: string): void {
    if (text) this.toPage({ t: 'said', text });
  }

  intent_start(): void {
    this.setPhase('thinking');
  }

  intent_progress(delta: string): void {
    if (!delta) return;
    this.replyText += delta;
    this.toPage({ t: 'reply', id: this.replyId, text: this.replyText });
  }

  intent_end(_text: string, continueConversation?: boolean): void {
    if (continueConversation !== undefined) {
      // Sticky on the real firmware too — only an explicit value changes it.
      this.continueConversation = continueConversation;
    }
  }

  tts_start(text?: string): void {
    this.setPhase('replying');
    // In-band replies carry the COMPLETE reply text here — authoritative, so it
    // replaces whatever the streamed deltas built up.
    if (text) {
      this.replyText = text;
      this.toPage({ t: 'reply', id: this.replyId, text });
    }
  }

  /**
   * End of the reply. With a URL this is the IN-BAND delivery path: the reply
   * audio rides on this event and the PE plays it itself, then reopens the mic
   * when the pipeline asked to continue the conversation.
   */
  tts_end(url?: string): void {
    if (!url) {
      this.setPhase('idle');
      return;
    }
    const keepOpen = this.continueConversation;
    this.enqueuePlay(url, 'inband', () => {
      if (keepOpen) {
        this.logger.info('Reply ended and the conversation is open — reopening the mic');
        this.wake();
      }
    });
  }

  stt_vad_start(): void {
    this.setPhase('hearing');
  }

  stt_vad_end(_text: string): void { /* phase moves on intent_start */ }

  begin_mic_capture(): void {
    this.setPhase('listening');
    this.toPage({ t: 'mic', on: true });
  }

  closeMic(): void {
    this.toPage({ t: 'mic', on: false });
  }

  //
  // Media
  //

  /**
   * The mic-reopen announce: plays the listening chime and opens the mic when
   * it finishes (startConversation:true), and — like the real client — does not
   * report an announce_finished for it.
   */
  send_voice_assistant_request(mediaUrl: string = ''): void {
    this.suppressNextAnnounceFinished = true;
    this.playAnnounce(mediaUrl, true, 'chime');
  }

  playAudioFromUrl(url: string, startConversation: boolean): void {
    this.playAnnounce(url, startConversation, 'announce');
  }

  private playAnnounce(url: string, startConversation: boolean, kind: 'announce' | 'chime'): void {
    const suppressed = this.suppressNextAnnounceFinished;
    this.suppressNextAnnounceFinished = false;

    this.enqueuePlay(url, kind, () => {
      if (!suppressed) {
        this.emit('announce_finished');
      }
      if (startConversation) {
        // The firmware opens the mic at the end of a start-conversation
        // announce, which reaches the app as a fresh VoiceAssistantRequest.
        this.wake();
      }
    });
  }

  //
  // Controls
  //

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.toPage({ t: 'volume', value: this.volume });
  }

  setMute(mute: boolean): void {
    this.muted = mute;
    this.toPage({ t: 'muted', value: this.muted });
    // The real device confirms with a state update; the app mirrors that into
    // the volume_mute capability.
    this.emit('mute', this.muted);
  }

  sendTimerEvent(
    _eventType: number,
    opts: { timerId: string; name?: string; totalSeconds: number; secondsLeft: number; isActive: boolean },
    _quiet: boolean = false,
  ): void {
    this.toPage({
      t: 'timer',
      name: opts.name ?? '',
      secondsLeft: opts.secondsLeft,
      totalSeconds: opts.totalSeconds,
      isActive: opts.isActive,
    });
  }

  getAvailableWakeWords(): FakeWakeWord[] {
    return this.wakeWords.map((w) => ({ ...w, trainedLanguages: [...w.trainedLanguages] }));
  }

  getActiveWakeWords(): string[] {
    return [...this.activeWakeWords];
  }

  setActiveWakeWords(ids: string[]): void {
    this.activeWakeWords = [...ids];
    this.emit('wake_words', this.getAvailableWakeWords(), this.getActiveWakeWords(), 1);
  }

  //
  // The browser side of the satellite
  //

  /** A page connected. Only one page drives a satellite; the newest wins. */
  attachPage(send: (msg: ToPage) => void): void {
    this.page = send;
    send({ t: 'hello', name: this.name, zone: this.zone, id: this.id, volume: this.volume, muted: this.muted });
    send({ t: 'phase', phase: this.phase });
    // A play that was waiting on the headless timer keeps its own schedule;
    // anything queued after this goes to the page.
    this.logger.info(`${this.name}: browser page attached`);
  }

  detachPage(send: (msg: ToPage) => void): void {
    if (this.page === send) {
      this.page = null;
      this.logger.info(`${this.name}: browser page detached`);
    }
  }

  get hasPage(): boolean {
    return this.page !== null;
  }

  /** Mic audio from the page: s16le mono 16 kHz, exactly what the PE sends. */
  pushMicAudio(pcm: Buffer): void {
    if (this.muted) return;
    this.emit('chunk', pcm);
  }

  /** A message from the page (wake button, playback ack, volume/mute). */
  handlePageMessage(msg: FromPage): void {
    switch (msg.t) {
      case 'wake':
        this.wake();
        break;
      case 'played':
        if (msg.error) this.logger.warn(`playback failed in the browser: ${msg.error}`);
        this.finishPlay(msg.id);
        break;
      case 'volume':
        this.volume = Math.max(0, Math.min(1, Number(msg.value) || 0));
        this.emit('volume', this.volume);
        break;
      case 'muted':
        this.muted = Boolean(msg.value);
        this.emit('mute', this.muted);
        break;
      default:
        this.logger.warn(`unknown page message: ${JSON.stringify(msg)}`);
    }
  }

  /**
   * Start a turn — the stand-in for the wake word. Driven by the page's WAKE
   * button, the console `wake` command, and the firmware behaviours above
   * (start-conversation announce, in-band reply with the conversation open).
   */
  wake(): void {
    this.emit('starting');
  }

  //
  // Playback queue
  //

  private enqueuePlay(url: string, kind: 'announce' | 'inband' | 'chime', done: () => void): void {
    this.queue.push({ id: ++this.playSeq, url, kind, done });
    this.pumpQueue();
  }

  private pumpQueue(): void {
    if (this.active || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.active = next;
    // The chime is the "speak now" cue of a mic reopen, not a reply.
    this.setPhase(next.kind === 'chime' ? 'listening' : 'replying');

    if (this.page && next.url) {
      this.toPage({ t: 'play', id: next.id, url: next.url, kind: next.kind });
      // The page always acks, but a closed tab or a stalled fetch must not
      // strand the turn.
      this.watchdog = setTimeout(() => this.finishPlay(next.id), PLAYBACK_WATCHDOG_MS);
      return;
    }

    // Headless (or an empty media id, which the firmware also just times out
    // on): pretend it played so the announce queue keeps draining.
    if (!next.url) {
      this.logger.info('play with no media — completing immediately');
    } else if (!this.page) {
      this.logger.info(`no browser attached — skipping playback of ${next.url}`);
    }
    this.watchdog = setTimeout(() => this.finishPlay(next.id), HEADLESS_PLAYBACK_MS);
  }

  private finishPlay(id: number): void {
    if (!this.active || this.active.id !== id) return;
    const finished = this.active;
    this.active = null;
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    // Idle unless something follows — done() may reopen the mic (listening) and
    // pumpQueue may start the next segment (replying), both of which win.
    if (this.queue.length === 0) this.setPhase('idle');
    try {
      finished.done();
    } catch (err) {
      this.logger.error('playback completion handler failed', err);
    }
    this.pumpQueue();
  }

  private clearPlayback(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    this.active = null;
    this.queue = [];
  }

  private setPhase(phase: SatellitePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.toPage({ t: 'phase', phase });
  }

  private toPage(msg: ToPage): void {
    this.page?.(msg);
  }
}
