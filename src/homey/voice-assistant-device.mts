import Homey from 'homey';
import { WebServer } from '../helpers/webserver.mjs';
import { EspVoiceAssistantClient } from '../voice_assistant/esp-voice-assistant-client.mjs';
import { TimerManager, TimerSummary } from '../voice_assistant/timer-manager.mjs';
import { DeviceManager } from '../helpers/device-manager.mjs';
import { settingsManager } from '../settings/settings-manager.mjs';
import { IVoiceProvider, VoiceProviderOptions } from '../llm/voice-provider.mjs';
import { createVoiceProvider, DEFAULT_VOICE_PROVIDER } from '../llm/voice-provider-factory.mjs';
import { pcmToFlacBuffer } from '../helpers/audio-encoders.mjs';
import { AudioData, FileInfo } from '../helpers/interfaces.mjs';
import { ToolManager } from '../llm/tool-manager.mjs';
import { TurnStateMachine } from './turn-state-machine.mjs';
import { AudioOutputPipeline } from './audio-output-pipeline.mjs';
import { DeviceStore } from '../helpers/interfaces.mjs';
import { createLogger } from '../helpers/logger.mjs';
import { SOUND_URLS } from '../helpers/sound-urls.mjs';
import { scheduleAudioFileDeletion } from '../helpers/file-helper.mjs';
import { Pcm16kTo24k } from '../helpers/Pcm16kTo24k.mjs';
import { GeoHelper } from '../helpers/geo-helper.mjs';
import { WeatherHelper } from '../helpers/weather-helper.mjs';
import { getAppServices } from '../helpers/app-services.mjs';


export default abstract class VoiceAssistantDevice extends Homey.Device {
  private esp!: EspVoiceAssistantClient;
  private webServer!: WebServer;
  private deviceManager!: DeviceManager;
  private devicePromise!: Promise<void>;
  private geoHelper!: GeoHelper;
  private weatherHelper!: WeatherHelper;
  private toolManager!: ToolManager;
  private timerManager!: TimerManager;
  private provider!: IVoiceProvider;
  private reSampler?: Pcm16kTo24k;
  // All conversation-turn / PE-session state lives in the state machine; the
  // reply-audio output path (segmenter, encode/serve, announce queue, in-band
  // accumulation) lives in the pipeline (Org 1). The device only sequences the
  // ESP protocol around the decisions these two return.
  private turn = new TurnStateMachine();
  private audioOutput!: AudioOutputPipeline;
  // Which voice provider this.provider was built from (factory id). Compared in
  // handleSettingsChange so switching the 'voice_provider' setting rebuilds the
  // provider at runtime instead of silently keeping the old one until restart.
  private currentProviderId: string = DEFAULT_VOICE_PROVIDER;

  private settingsUnsubscribe?: () => void;
  private providerOptions!: VoiceProviderOptions;
  private currentZone: string = '';
  private macAddress: string = '';

  private isMutedValue: boolean = false;
  private logger = createLogger('Voice_Assistant_Device', true);
  // Concise per-turn conversation trace: wake -> VAD -> STT -> tools -> LLM reply ->
  // playback path -> continue/stop. Deliberately ALWAYS enabled (the detailed logger
  // above stays disabled) — keep it to one line per stage so a whole conversation
  // stays readable in the `homey app run` stream.
  private convo = createLogger('CONVO');
  // Wake-turn skip (bytes), from the `initial_audio_skip` device setting. Swallows the
  // wake-word "ding" the PE plays into the mic at the start of a wake/say turn.
  private skipInitialBytes: number | null = null;
  // Follow-up-turn skip (bytes), from the `followup_audio_skip` device setting (default
  // DEFAULT_FOLLOWUP_SKIP_MS). Used INSTEAD of skipInitialBytes on conversation-reopen
  // turns — those have no ding, only the short mic-open noise/echo burst to swallow.
  // The per-turn effective skip is picked in TurnStateMachine.startTurn().
  private followupSkipBytes: number | null = null;
  // Default follow-up skip when `followup_audio_skip` isn't set. Conversation-reopen turns
  // open the mic right after the PE's own speaker finished the reply, so a mic-open
  // noise/echo burst lands at t=0 and can trip OpenAI's server VAD (speech_started ->
  // speech_stopped) before the user answers — the dead window. This small skip swallows
  // just that burst (NOT a full ding-length cut, since a follow-up has no ding).
  private readonly DEFAULT_FOLLOWUP_SKIP_MS: number = 150;
  abstract readonly needDelayedPlayback: boolean;

  // Captures raw mic input and serves it back as a playback URL for debugging.
  // Emulator-only: the `input_buffer_debug` setting is honored solely when the
  // process carries the HE_EMULATOR marker, so on a real Homey the flag can
  // never expose recorded microphone audio on the unauthenticated LAN URL.
  private inputBufferDebug: boolean = false;
  private inputBuffer: Buffer[] = [];
  private inputPlaybackUrl?: FileInfo | null = null;

  private isAgentHealthy: boolean = false;
  private isEspClientHealthy: boolean = false;

  // 1 Hz interval that pushes the active countdown onto the tile capabilities;
  // only runs while a timer is counting down (cleared on finish/cancel).
  private timerTickInterval: NodeJS.Timeout | null = null;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit(): Promise<void> {
    this.logger.info('Initializing');

    this.setUnavailable();
    this.setCapabilityValue('onoff', false);
    this.RegisterCapabilities();
    await this.ensureTimerCapabilities();
    const store = this.getStore() as DeviceStore;
    const settings = this.getSettings();
    this.macAddress = store.mac;

    this.inputBufferDebug = process.env.HE_EMULATOR === '1'
      && settingsManager.getGlobal('input_buffer_debug') === true;

    // Subscribe to global settings changes to update agent on the fly
    this.settingsUnsubscribe = settingsManager.onGlobals((newSettings) => {
      this.handleSettingsChange(newSettings);
    });

    const services = getAppServices(this.homey);
    this.webServer = services.webServer;
    this.deviceManager = services.deviceManager;
    this.geoHelper = services.geoHelper;
    this.weatherHelper = services.weatherHelper;



    this.currentZone = this.deviceManager.registerDevice(this.macAddress, (changed) => {
      this.logger.info(`Device ${changed.device.name} changed zone from ${changed.oldZone} to ${changed.newZone}`);
      if (this.provider) {
        this.provider.updateZone(changed.newZone);
        this.provider.restart();
      }
    });

    if (settings.initial_audio_skip) {
      this.skipInitialBytes = this.msToBytes(settings.initial_audio_skip, 16000, 1, 2);
    }

    // Follow-up burst-skip: use the setting if present, else the small default. Unlike the
    // wake skip this defaults to a non-zero value so the mic-open burst is always swallowed.
    const followupSkipMs = (settings.followup_audio_skip ?? this.DEFAULT_FOLLOWUP_SKIP_MS) as number;
    this.followupSkipBytes = this.msToBytes(followupSkipMs, 16000, 1, 2);


    this.providerOptions = {
      apiKey: settingsManager.getGlobal('openai_api_key'),
      voice: settingsManager.getGlobal('selected_voice') || 'alloy',
      languageCode: settingsManager.getGlobal('selected_language_code') || 'en',
      languageName: settingsManager.getGlobal('selected_language_name') || 'English',
      additionalInstructions: settingsManager.getGlobal('ai_instructions') || '',
      deviceZone: this.currentZone,
      // Start false; flipped on once the ESP handshake reports the TIMERS flag
      // (see the 'capabilities' handler below), which rebuilds the instructions.
      supportsTimers: false
    };

    // Initialize ESP voice client - Uses stored address and port.
    // Created before the tool manager because the timer tools drive it.
    this.esp = new EspVoiceAssistantClient(this.homey, {
      host: store.address,
      apiPort: store.port
    });

    // Owns the authoritative countdown for set_timer/cancel_timer; sends timer
    // events to the device (LED ring + finish chime).
    this.timerManager = new TimerManager(this.homey, this.esp);

    // Surface timer lifecycle to Homey Flow as device triggers. State carries
    // the device so the driver's run-listener can match the selected device.
    this.timerManager.on('started', (t) => this.fireTimerTrigger('timer-started', t));
    this.timerManager.on('finished', (t) => this.fireTimerTrigger('timer-finished', t));
    this.timerManager.on('cancelled', (t) => this.fireTimerTrigger('timer-cancelled', t));

    // Mirror the same lifecycle onto the device tile (timer_active/remaining/name).
    // started → push state + start the 1 Hz tick; finished/cancelled → stop the
    // tick and push the cleared/idle state.
    this.timerManager.on('started', () => { this.syncTimerCapabilities(); this.startTimerCapabilityTick(); });
    this.timerManager.on('finished', () => { this.stopTimerCapabilityTick(); this.syncTimerCapabilities(); });
    this.timerManager.on('cancelled', () => { this.stopTimerCapabilityTick(); this.syncTimerCapabilities(); });

    // Initialize tool manager - This will define all the function the agent can call.
    this.toolManager = new ToolManager(this.homey, this.currentZone, this.deviceManager, this.geoHelper, this.weatherHelper, this.timerManager);

    // Initialize the voice/LLM provider (via the factory, selected by the
    // 'voice_provider' setting) - it uses the tool manager for function calls.
    // Remember which id it was built from so handleSettingsChange can detect a
    // runtime provider switch and rebuild (see rebuildProvider).
    this.currentProviderId = settingsManager.getGlobal('voice_provider', DEFAULT_VOICE_PROVIDER);
    this.provider = createVoiceProvider(this.homey, this.toolManager, this.providerOptions, this.currentProviderId);
    this.configureResampler();

    // The reply-audio output path: segmenter -> FLAC -> LAN URL -> play/queue,
    // plus the in-band accumulation path. Emits 'segment' / 'reply-done'; the
    // handlers below do the ESP protocol sequencing around them.
    this.audioOutput = new AudioOutputPipeline(this.homey, this.webServer, this.logger);

    // Attach all provider event handlers. Kept in its own method so a runtime
    // provider switch can re-wire the replacement instance.
    this.wireProviderEvents();


    //
    //
    // Handlers between agent, esp and segmenter
    //
    //

    // The esp voice client has woken (by wake word or user action)
    this.esp.on('starting', async () => {

      // Drop a duplicate wake while we're already streaming the mic. After an
      // in-band reply the PE sometimes auto-reopens the mic itself AND our
      // post-playback reopen fires — without this guard the second 'starting'
      // would start a second run that clobbers the first (empty transcript).
      if (!this.turn.canStartTurn()) {
        this.logger.info('Ignoring duplicate wake — already streaming mic');
        return;
      }

      if (!this.provider.isConnected()) {
        // The agent doesn't have an active web socket. Either the API Key is missing or the internet connection failed.
        // Play a pre-recorded message to inform the user.
        const hasKey = this.provider.hasApiKey();
        this.convo.warn(hasKey
          ? 'Wake ignored — agent not connected, playing error sound'
          : 'Wake ignored — API key missing, playing error sound');
        const url = hasKey ? SOUND_URLS.agent_not_connected : SOUND_URLS.missing_api_key;
        this.esp.run_start();
        this.esp.pipeline_error('agent-not-connected', hasKey ? 'Voice agent is not connected.' : 'API key is missing.');
        this.esp.run_end();
        this.playUrl(url);
        return;
      }

      // The machine decides: fresh conversation (context TTL expired), follow-up
      // vs plain wake (reply route + which mic-skip applies), retry budget.
      const started = this.turn.startTurn({
        wakeSkipBytes: this.skipInitialBytes ?? 0,
        followupSkipBytes: this.followupSkipBytes ?? 0,
      });

      // Quick follow-ups keep their context: a continue-conversation reopen fires
      // within ~1s, well under the TTL, so "nei, jeg mente stua" still resolves
      // against the previous turn.
      if (started.freshConversation) {
        this.logger.info(`Idle ${Math.round(started.idleMs / 1000)}s since last turn — starting fresh conversation`);
        this.convo.info(`Idle ${Math.round(started.idleMs / 1000)}s — context cleared, starting fresh conversation`, 'MIC');
        this.provider.resetConversation();
      }

      // Initialize input buffer, only used for debugging.
      this.inputBuffer = [];

      // Inside the PE's start_conversation session every reply goes in-band on
      // TTS_END (standalone announces get dropped mid-conversation); a plain
      // say/wake turn uses the announce path (which fires the first reopen).
      this.audioOutput.beginTurn(started.followUp ? 'inband' : 'announce');

      this.convo.info(started.followUp
        ? 'Turn started (follow-up — conversation open), listening…'
        : 'Turn started (wake word / button / flow), listening…', 'MIC');

      this.logger.info("Voice session started");
      // Let's start getting device state over the API, this might take a while, but should be done when we actually need it
      this.devicePromise = this.deviceManager.fetchData();

      this.setCapabilityValue('onoff', true);
      this.esp.run_start();
      this.esp.wake_word_end();
      this.esp.stt_start();
      // NOTE: no stt_vad_start here — it is sent when server VAD actually hears
      // speech (see the provider 'speech' handler), so the PE's waiting phase
      // (mic open, nothing heard yet) stays distinct from its listening phase.
      this.esp.begin_mic_capture();
    });

    // There is some audio data available from the microphone
    this.esp.on('chunk', (data: Buffer) => {

      // Trim against this turn's skip budget (wake-word ding on wake/say turns,
      // the smaller mic-open burst on conversation reopens) and the listening
      // gate — both live in the state machine.
      const trimmed = this.turn.consumeMicChunk(data);
      if (trimmed === null) {
        return;
      }

      // ESP client emits PCM16 mono 16 kHz. Resample to the provider's input rate
      // when it differs (e.g. OpenAI 24 kHz); otherwise pass the 16 kHz through.
      const frames: Buffer[] = this.reSampler ? (this.reSampler.push(trimmed) as Buffer[]) : [trimmed];
      for (const chunk of frames) {

        if (this.inputBufferDebug) {
          // Add chunk to input buffer, used for debugging.
          this.inputBuffer.push(chunk);
        }

        // Send audio chunk to provider
        this.provider.sendAudioChunk(chunk);
      }


    });


    // Provider event handlers live in wireProviderEvents() (called above) so a
    // runtime provider switch can re-attach them to the replacement instance.


    // The pipeline finished an announce segment (encoded + served, strict FIFO —
    // H-l/M9 live inside the pipeline). The device owes the PE the intent_end ->
    // tts_start transition before the FIRST audible reply of the turn, then either
    // plays the segment or leaves it queued for announce_finished to dequeue.
    this.audioOutput.on('segment', ({ fileInfo, action }) => {
      // If we have an input buffer to play, do that first (debugging only).
      if (this.inputBufferDebug && this.inputPlaybackUrl) {
        this.playUrlByFileInfo(this.inputPlaybackUrl, false);
        this.inputPlaybackUrl = null;
      }

      if (this.turn.takeIntent()) {
        this.esp.intent_end('');
        // Deliberately NO text here: on the announce path the firmware's own
        // announcement handler fires tts_start_trigger_ (replying phase, stop-word
        // script) at playback start. Sending a text-carrying TTS_START as well made
        // those fire a second time ~1s early, and is the prime suspect for the PE
        // getting stuck "running" after a turn (wake word then silently hits the
        // voice_assistant.stop branch instead of starting a run). A text-less
        // TTS_START is discarded by the firmware — kept for protocol shape only.
        this.esp.tts_start();
      }

      if (action === 'play') {
        this.turn.speakingStarted();
        this.convo.info('Speaking reply (announce)', 'TTS');
        this.logger.info(`Playing FIRST announcement from URL: ${fileInfo.url}`);
        this.playUrlByFileInfo(fileInfo, false);
      }
      // 'queued' segments play when announce_finished dequeues them.
    });


    this.esp.on('announce_finished', () => {
      // This handler only drives the multi-segment announce QUEUE (say/wake replies).
      // The reopen and continue-reply announces also ack with AnnounceFinished, often
      // late (during a later turn). Those arrive with no announce queue active; the
      // pipeline reports them as 'ignore' so they can't spuriously end a run or
      // trigger a second reopen.
      const next = this.audioOutput.announceFinished();
      if (next.kind === 'ignore') {
        this.logger.info('Ignoring stray announce_finished (no announce queue active)');
        return;
      }

      this.logger.info('Announcement finished');

      if (next.kind === 'play') {
        this.logger.info(`Playing NEXT announcement from URL: ${next.fileInfo.url}`);
        if (this.needDelayedPlayback) {
          this.homey.setTimeout(() => {
            this.esp.tts_start();
            this.playUrlByFileInfo(next.fileInfo, false);
          }, 500);
        } else {
          this.playUrlByFileInfo(next.fileInfo, false);
        }
        return;
      }

      // Queue drained — the announce turn's playback is over.
      this.esp.tts_end()
      this.esp.run_end();
      this.setCapabilityValue('onoff', false);
      this.logger.info(`Done playing announcements`);

      const { reopenMic } = this.turn.finishAnnouncePlayback();
      if (reopenMic) {
        this.convo.info('Reply ended with a question — reopening mic for a follow-up', 'END');
        // The reply ended in a question: open the conversation. Reopen the mic once
        // ourselves (startConversation:true puts the PE into conversation mode); the
        // machine marked the session active so this turn AND every turn the PE
        // auto-reopens afterwards delivers its reply in-band on TTS_END. We send
        // only THIS reopen; the PE drives the rest of the chain.
        this.homey.setTimeout(() => {
          this.esp.send_voice_assistant_request();
        }, 1);
      } else {
        this.convo.info('Turn complete — conversation closed', 'END');
      }
    });


    // The reply stream ended (segmenter flushed). In-band turns deliver here on
    // TTS_END carrying the FLAC URL — the only mechanism the PE reliably plays
    // mid-conversation (standalone announces, even with startConversation:true, get
    // dropped). After this the PE auto-reopens the mic for the next turn, so chained
    // questions keep flowing in-band; the session ends when the user answers with
    // silence (see transcript.done) or after the context TTL idles out.
    this.audioOutput.on('reply-done', async (d) => {
      try {
        this.esp.closeMic();

        if (d.mode !== 'inband') {
          return;
        }

        // The "?" heuristic is final here (response.done ran before the flush that
        // fired this event). Tell the PE explicitly whether to reopen the mic after
        // playing this reply: INTENT_END continue_conversation '1' -> START_MICROPHONE,
        // '0' -> IDLE. The firmware's flag is sticky, so without this it stays true
        // from the original startConversation announce and the PE reopens after every
        // reply — a goodbye ("...bare si fra.") would keep the conversation open forever.
        const { keepOpen, replyText } = this.turn.beginInbandDelivery();
        this.esp.intent_end('', keepOpen);
        // Must carry the reply text: the firmware discards a text-less TTS_START,
        // and in-band replies have no announcement to fire tts_start_trigger_ for
        // us — without this the PE never shows its "replying" phase.
        this.esp.tts_start(replyText);

        // Encode + serve + schedule deletion (TTL extended by playback length) —
        // the pipeline owns the file mechanics.
        const file = d.pcm.length > 0 ? await this.audioOutput.buildReplyFile(d.pcm) : null;

        if (file) {
          this.convo.info(keepOpen
            ? 'Speaking reply (in-band) — reply is a question, PE reopens the mic after playback'
            : 'Speaking reply (in-band) — final reply, conversation closes after playback', 'TTS');
          this.logger.info(`Continue reply via TTS_END URL: ${file.url}`);
          this.esp.tts_end(file.url);
        } else {
          this.convo.info('Turn ended with no reply audio', 'END');
          this.esp.tts_end();
        }
        this.esp.run_end();
        // Session tracking must mirror what we just told the PE (keepOpen), and the
        // turn ends at END OF PLAYBACK, not send time — the PE only reopens/goes
        // idle after playing the reply, and stamping at send time made a long reply
        // eat the whole context TTL (context wiped mid-conversation).
        this.turn.finishInbandDelivery(keepOpen, file?.playbackMs ?? 0);
        this.setCapabilityValue('onoff', false);
      } catch (err) {
        this.logger.error('In-band reply delivery failed', err);
      }
    });


    // Listen for volume changes from the device
    this.esp.on('volume', (level: number) => {
      this.logger.info(`Received volume update: ${Math.round(level * 100)}%`);
      this.setCapabilityValue('volume_set', level).catch(err => {
        this.logger.error('Failed to update volume_set capability', err);
      });
    });

    // Listen for mute state changes from the device
    this.esp.on('mute', (isMuted: boolean) => {
      this.logger.info(`Received mute state update: ${isMuted ? 'muted' : 'unmuted'}`);
      this.isMutedValue = isMuted;
      this.setCapabilityValue('volume_mute', isMuted).catch(err => {
        this.logger.error('Failed to update volume_mute capability', err);
      });
    });

    this.esp.on('Healthy', async () => {
      this.logger.info('ESP Voice Client healthy');
      this.isEspClientHealthy = true;
      this.updateAvailable();
    });

    this.esp.on('Unhealthy', () => {
      this.logger.info('ESP Voice Client unhealthy');
      this.isEspClientHealthy = false;
      this.abortCurrentTurn('device connection lost');
      this.updateAvailable();
    });

    // Once the ESP handshake completes we know the device's feature flags
    // (parsed from DeviceInfoResponse). Tell the agent whether this device
    // supports timers so the timer/alarm section is only added to the prompt
    // for capable devices. Fires again on reconnect — updateTimerSupport is a
    // no-op when the value is unchanged.
    this.esp.on('capabilities', () => {
      this.providerOptions.supportsTimers = this.esp.supportsTimers;
      this.provider.updateTimerSupport(this.esp.supportsTimers);
      // Re-arm the LED ring for any timer still counting down on our side. This
      // must happen here, not on 'Healthy': 'Healthy' fires right after TCP
      // connect, before the device has subscribed to the voice assistant, so a
      // timer event sent then is dropped (the ring never shows). By 'capabilities'
      // the handshake is complete and the device renders the ring. No-op on the
      // initial connect (no timer running yet).
      this.timerManager?.reissue();
    });


    // Actually start the ESP and agent.
    await this.esp.start();
    await this.provider.start();

    this.logger.info('Initialized');
  }


  /**
   * Match the mic resampler to the provider's expected input rate. The PE mic is
   * PCM16 mono 16 kHz; providers wanting 24 kHz (OpenAI) get an upsampler, while
   * providers wanting 16 kHz (Gemini) take the raw stream (passthrough). Called on
   * init and again after a runtime provider switch (rates can differ).
   */
  private configureResampler(): void {
    if (this.provider.inputSampleRate !== 16000) {
      this.reSampler = new Pcm16kTo24k({
        outRate: this.provider.inputSampleRate,
        frameDurationMs: 20,
        method: "cubic"
      });
    } else {
      // Passthrough provider (e.g. Gemini at 16 kHz): no resampling. Clear any
      // resampler left over from a previous provider so we don't upsample twice.
      this.reSampler = undefined;
    }
  }

  /**
   * Attach all provider event handlers to this.provider. Kept separate from onInit
   * so a runtime provider switch (rebuildProvider) can re-wire the replacement
   * instance. The esp/segmenter handlers stay inline in onInit — those emitters are
   * created once and never rebuilt.
   */
  private wireProviderEvents(): void {

    // Handle missing API key
    this.provider.on("missing_api_key", async () => {

      await this.homey.notifications.createNotification({
        excerpt: 'AI Assistant: Please set **api key** in app settings.'
      });

    });


    this.provider.on("open", () => {
      this.logger.info('Agent connection opened');
      this.isAgentHealthy = true;
      this.updateAvailable();
    });



    // Server VAD heard the user START speaking. Forward it to the PE so the LED
    // ring flips waiting->listening. This is also a diagnostic marker: a 'speech'
    // right after a follow-up mic-open, before the user talks, is the TTS echo
    // tripping server VAD (the spurious-turn case). Best-effort — not every
    // provider emits it (see VoiceProviderEvents).
    this.provider.on('speech', (source: string) => {
      if (!this.turn.isListening) return;
      this.convo.info(`User started speaking (${source} VAD)`, 'MIC');
      this.esp.stt_vad_start();
    });

    // The agent has detected that the user has stopped speaking.
    this.provider.on('silence', async (source: string) => {
      this.convo.info(`User stopped speaking (${source} VAD) — mic closed`, 'MIC');
      this.logger.info(`Silence detected by agent (${source}), closing microphone.`);
      this.turn.micClosed();
      this.esp.closeMic();
      this.reSampler?.reset();
      this.esp.stt_vad_end('');
      // Save input buffer to file, used for debugging to hear what was captured
      if (this.inputBufferDebug) {
        await this.saveInputBuffer();
      }

    });

    // The agent is sending audio data back. We can't play each chunk individually, so we need to buffer them.
    this.provider.on('audio.delta', (audioBuffer: Buffer) => {
      this.audioOutput.feed(audioBuffer);
    });

    this.provider.on('transcript.delta', (delta: string) => {
      this.turn.addReplyDelta(delta);

      // NOTE: the is-this-a-question decision (continueConversation) is made on the
      // COMPLETE reply in response.done, not per-delta. A per-delta check latched on
      // any mid-reply "?" — a joke's setup line ("Hvorfor kan ikke sykler stå
      // oppreist?") opened a follow-up even though the reply ended in a punchline.

      const text = (delta ?? '').trim();
      // Send INTENT_PROGRESS to the PE so it can start streaming TTS earlier
      if (text) {
        this.esp.intent_progress(text);
      }
    });

    this.provider.on('transcript.done', (transcript: any) => {
      this.logger.info('Final transcript: '+ transcript, "transcript");

      transcript = (transcript ?? '').trim();
      const decision = this.turn.transcriptDone(transcript);

      // Spurious follow-up turn: the PE reopens its mic at the very end of its own
      // TTS playback, so the reply's tail/echo can trip server VAD before the user
      // has spoken — the turn comes back empty within a second or two, and ending
      // the session here would steal the user's answer window. Close this run and
      // reopen the mic so the user actually gets to answer (retry budget bounded
      // by the machine; a genuine no-answer still ends the session below).
      if (decision.kind === 'spurious_retry') {
        this.convo.info(`Heard nothing only ${(decision.turnMs / 1000).toFixed(1)}s after mic open — spurious VAD trip (TTS echo), reopening mic (retry ${decision.retry}/${decision.maxRetries})`, 'STT');
        this.audioOutput.cancelInband();
        this.esp.stt_end('');
        this.esp.run_end();
        this.setCapabilityValue('onoff', false);
        this.homey.setTimeout(() => {
          this.esp.send_voice_assistant_request();
        }, 1);
        return;
      }

      if (decision.kind === 'end_session') {
        this.convo.info('Heard nothing — ending conversation', 'STT');
        // The machine ended the PE's start_conversation session (next turn starts
        // fresh on the announce path). Cancel the in-band route too so a stray
        // segmenter 'done' can't emit a duplicate in-band tts_end/run_end on top
        // of the run_end we send here.
        this.audioOutput.cancelInband();
        this.esp.stt_end('');
        this.esp.run_end();
        this.setCapabilityValue('onoff', false);
        return;
      }

      this.convo.info(`Heard: "${transcript}"`, 'STT');
      this.esp.stt_end(transcript);
      this.esp.intent_start();
    });

    // Text-mode replies stream as text deltas (e.g. the emulator's `ask`); accumulate
    // them too so response.done can log the full reply regardless of output mode.
    this.provider.on('text.delta', (delta: string) => {
      this.turn.addReplyDelta(delta);
    });

    // The agent want's to use a tool. We need to make sure we have all the data from the API now.
    this.provider.on('tool.called', async (d: { callId: string; name: string; args: any }) => {
      this.convo.info(`${d.name} ${this.compact(d.args)}`, 'TOOL');
      this.logger.info(`${d.name}`, 'TOOL_CALLED', d.args);
      await this.devicePromise;
    });

    // What the tool handler actually returned (fed back to the model).
    this.provider.on('tool.completed', (d: { callId: string; name: string; result: any }) => {
      this.convo.info(`${d.name} → ${this.compact(d.result)}`, 'TOOL');
    });

    // The agent has finished processing the response. The machine captures the
    // full reply and makes the is-this-a-question decision (on the COMPLETE
    // reply, never per-delta); flushing forces the segmenter's tail out.
    this.provider.on('response.done', () => {
      const { reply } = this.turn.responseDone();
      if (reply) {
        this.convo.info(`Reply: "${reply}"`, 'LLM');
        this.logger.info(`LLM reply: ${reply}`, "LLM");
      }

      this.logger.info("Conversation completed");
      this.audioOutput.flush();
    });

    this.provider.on('error', (error: Error) => {
      this.logger.error("Realtime agent error:", error);
      this.abortCurrentTurn(`agent error: ${error.message || 'unknown error'}`);
    });

    // The agent websocket closed (idle timeout, network drop, or restart). This
    // is the primary wake-death trigger: without aborting here, the turn stays
    // in 'listening' and every later wake is dropped as a "duplicate". The
    // provider auto-reconnects; the in-flight turn cannot survive it, so end it
    // cleanly.
    this.provider.on('close', () => {
      this.abortCurrentTurn('agent connection closed');
    });

    // This will toggle the device in homey available or not
    this.provider.on('Healthy', () => {
      this.logger.info('Agent connection healthy');
      this.isAgentHealthy = true;
      this.updateAvailable();
    });

    this.provider.on('Unhealthy', () => {
      this.logger.info('Agent connection unhealthy');
      this.isAgentHealthy = false;
      this.abortCurrentTurn('agent connection lost');
      this.updateAvailable();
    });
  }

  /**
   * Rebuild the voice provider after the 'voice_provider' setting changes at
   * runtime. Tears down the old instance, constructs the newly-selected one with
   * the current options, re-matches the resampler to its input rate, re-wires the
   * handlers, and connects. Without this a provider switch was silently ignored
   * until the app restarted.
   */
  private async rebuildProvider(newProviderId: string): Promise<void> {
    this.logger.info(`Voice provider changed to '${newProviderId}', rebuilding...`);

    // Tear down the old provider so its socket / timers / listeners don't linger.
    try {
      (this.provider as any).removeAllListeners?.();
      if (typeof (this.provider as any).destroy === 'function') {
        (this.provider as any).destroy();
      } else {
        this.provider.close();
      }
    } catch (e) {
      this.logger.error('Error tearing down old provider', e);
    }

    // Any turn in flight belongs to the old provider — end it cleanly.
    this.abortCurrentTurn('voice provider changed');

    this.currentProviderId = newProviderId;
    // createVoiceProvider resolves options.apiKey from the setting that belongs to
    // the chosen provider, so switching also picks up that provider's own key.
    this.provider = createVoiceProvider(this.homey, this.toolManager, this.providerOptions, newProviderId);
    this.configureResampler();
    this.wireProviderEvents();
    await this.provider.start();
  }


  /**
   * Reset all conversation-turn state after a mid-turn failure or a transport
   * drop (ESP link or agent websocket). Without this, a disconnect leaves the
   * turn stuck in 'listening', so every subsequent wake is swallowed by the
   * duplicate-wake guard — the "wake-death" that previously required a PE
   * power-cycle to recover. Idempotent and safe to call when idle.
   */
  private abortCurrentTurn(reason: string): void {
    // ONE reset each: the machine clears every turn/session flag, the pipeline
    // invalidates queued and in-flight segment work (generation bump) and drops
    // its buffers. Both report whether anything was actually in flight.
    const turnAbort = this.turn.abort();
    const outputAbort = this.audioOutput.abort();

    if (turnAbort.wasActive || outputAbort.wasActive) {
      this.convo.warn(`Turn aborted — ${reason}`, 'END');
      // Best-effort: tell the device to leave its listening/playing state. These
      // are no-ops if the ESP link is already down (writes are dropped when
      // disconnected), so it's safe to attempt on any abort path.
      try {
        this.esp.pipeline_error('turn-aborted', reason);
        this.esp.run_end();
      } catch (e) {
        this.logger.error('Failed to notify device of turn abort', e);
      }
    }

    this.reSampler?.reset();

    this.setCapabilityValue('onoff', false).catch(err => {
      this.logger.error('Failed to reset onoff capability on turn abort', err);
    });
  }


  /**
   * Handle settings changes and update agent accordingly
   */
  private async handleSettingsChange(newSettings: any): Promise<void> {
    this.logger.info('Settings changed, updating agent...', undefined, newSettings);

    if (this.providerOptions == null) {
      return;
    }

    try {
      let needRestart: boolean = false;

      // Provider switched (OpenAI <-> Gemini): rebuild rather than silently keeping
      // the old one until an app restart. rebuildProvider re-resolves the API key,
      // resampler and handlers for the new provider, so the checks below then see a
      // consistent state (no redundant restart).
      const newProviderId = newSettings.voice_provider;
      if (newProviderId && newProviderId !== this.currentProviderId) {
        await this.rebuildProvider(newProviderId);
      }

      // Check if the active provider's API key changed
      const newApiKey = newSettings[this.provider.apiKeySettingKey];

      if (newApiKey !== this.providerOptions.apiKey) {
        this.logger.info(`API key changed, updating agent and restarting.`);
        this.providerOptions.apiKey = newApiKey;
        await this.provider.updateApiKey(newApiKey);
        needRestart = true;
      }

      const newVoice = newSettings.selected_voice;
      if (newVoice && newVoice !== this.providerOptions.voice) {
        this.logger.info(`Voice changed from ${this.providerOptions.voice} to ${newVoice}`);
        this.providerOptions.voice = newVoice;
        this.provider.updateVoice(this.providerOptions.voice);
        needRestart = true;
      }

      // Check if language changed
      const newLanguageCode = newSettings.selected_language_code;
      const newLanguageName = newSettings.selected_language_name;
      if (newLanguageCode && newLanguageCode !== this.providerOptions.languageCode) {
        this.logger.info(`Language code changed from ${this.providerOptions.languageCode} to ${newLanguageCode}`);
        this.providerOptions.languageCode = newLanguageCode;
        this.providerOptions.languageName = newLanguageName || 'English';
        this.provider.updateLanguage(this.providerOptions.languageCode, this.providerOptions.languageName);
        needRestart = true;
      }

      // Check if AI instructions changed
      const newInstructions = newSettings.ai_instructions;
      if (newInstructions !== this.providerOptions.additionalInstructions) {
        this.logger.info('AI instructions changed, updating...');
        this.providerOptions.additionalInstructions = newInstructions || '';
        this.provider.updateAdditionalInstructions(this.providerOptions.additionalInstructions);
        needRestart = true;
      }

      if (needRestart) {
        this.provider.restart();
      }


    } catch (error) {
      this.logger.error('Failed to update agent settings:', error);
    }
  }



  private RegisterCapabilities() {


    this.registerCapabilityListener('onoff', async (value: boolean) => {
      this.logger.info(`Capability onoff changed to: ${value}`);
      if (this.esp && value) {
        try {
          await this.esp.send_voice_assistant_request();
        } catch (error) {
          this.logger.error('Error sending voice assistant request:', error);
        }
      }
    });

    this.registerCapabilityListener('volume_set', async (value: number) => {
      this.logger.info(`Capability volume_set changed to: ${value}`);
      // Send the volume command to the ESPHome device
      if (this.esp && this.esp.setVolume) {
        try {
          await this.esp.setVolume(value);
        } catch (error) {
          this.logger.error('Error setting volume:', error);
        }
      } else {
        this.logger.error('ESP client not initialized or setVolume method not available');
      }
    });

    this.registerCapabilityListener('volume_mute', async (value: boolean) => {
      this.logger.info(`Capability volume_mute changed to: ${value}`);
      // Send the mute command to the ESPHome device
      if (this.esp && this.esp.setMute) {
        this.isMutedValue = value;
        try {
          await this.esp.setMute(value);
        } catch (error) {
          this.logger.error('Error setting mute:', error);
        }
      } else {
        this.logger.error('ESP client not initialized or setMute method not available');
      }
    });

  }


  playUrl(url: string): void {
    this.logger.info(`Playing audio from URL: ${url}`);
    if (this.esp && this.esp.playAudioFromUrl) {
      this.esp.run_start();
      this.esp.playAudioFromUrl(url, false);
      this.esp.run_end();
    } else {
      this.logger.error('ESP client not initialized or playAudioFromUrl method not available');
    }
  }

  private playUrlByFileInfo(fileInfo: FileInfo, startConversation: boolean) {
    this.esp.playAudioFromUrl(fileInfo.url, startConversation);
    // Extend the TTL by the clip's playback length (when known) so a segment
    // longer than the base TTL isn't deleted while the PE is still streaming it.
    scheduleAudioFileDeletion(this.homey, fileInfo, fileInfo.playbackMs ?? 0);
  }

  async speakText(text: string): Promise<void> {
    this.convo.info(`Flow speak-text: "${text}"`, 'TTS');
    this.logger.info(`Speaking text: ${text}`);
    if (this.provider && this.provider.textToSpeech) {

      const flacBuffer = await this.provider.textToSpeech(text);

      const audioData: AudioData = {
        data: flacBuffer,
        extension: 'flac',
        prefix: 'say'
      };

      const fileInfo = await this.webServer.buildStream(audioData);
      this.playUrlByFileInfo(fileInfo, false);

    } else {
      this.logger.error('Agent not initialized or textToSpeech method not available');
    }
  }

  async askAgentOutputToSpeaker(question: string): Promise<void> {
    this.convo.info(`Flow question (audio out): "${question}"`, 'ASK');
    this.logger.info(`Asking agent to output to speaker: ${question}`);

    // A say always starts a fresh turn on the announce path: clear any stale session
    // state so the reply isn't mis-routed in-band, and so turn 1 of a multi-question
    // quiz goes out as an announce (which is what fires the first reopen).
    this.turn.resetSession();
    this.audioOutput.cancelInband();

    if (this.provider && this.provider.sendTextForAudioResponse) {
      await this.deviceManager.fetchData();
      this.provider.sendTextForAudioResponse(question);
    } else {
      this.logger.error('Agent not initialized or sendTextForAudioResponse method not available');
    }

  }


  async askAgentOutputToText(question: string): Promise<string> {
    this.convo.info(`Flow question (text out): "${question}"`, 'ASK');
    this.logger.info(`Asking agent to output as text: ${question}`);

    if (this.provider && this.provider.sendTextForTextResponse) {
      await this.deviceManager.fetchData();

      return new Promise<string>((resolve, reject) => {
        // Set up a one-time event listener for text.done
        const textDoneHandler = (msg: any) => {
          // Clear the timeout on successful response
          if (timeoutId) {
            this.homey.clearTimeout(timeoutId);
            timeoutId = null;
          }
          this.logger.info('Text response received:', undefined, msg.text);
          resolve(msg.text);
        };

        // Add the event listener for this specific request
        this.provider.once('text.done', textDoneHandler);

        // Set a timeout in case the response never comes
        let timeoutId: any = this.homey.setTimeout(() => {
          this.provider.off('text.done', textDoneHandler);
          reject(new Error('Timeout waiting for text response'));
        }, 30000); // 30 seconds timeout

        try {
          // Send the request
          this.provider.sendTextForTextResponse(question);
        } catch (error) {
          // Clear the timeout and remove the listener if sending fails
          this.homey.clearTimeout(timeoutId);
          timeoutId = null;
          this.provider.off('text.done', textDoneHandler);
          reject(error);
        }
      });
    } else {
      this.logger.error('Agent not initialized or sendTextForTextResponse method not available');
      return "";
    }
  }

  isMuted(): boolean {
    return this.isMutedValue;
  }

  // --- Timer Flow-card surface -------------------------------------------------

  /**
   * Fire a timer device-trigger card. These cards carry a `device` argument, so
   * they are device-trigger cards and must be obtained via getDeviceTriggerCard()
   * (getTriggerCard() throws for them). Passing `this` as the first arg lets Homey
   * scope each flow to the device that fired it — no run-listener needed.
   */
  private fireTimerTrigger(cardId: string, t: TimerSummary): void {
    try {
      this.homey.flow.getDeviceTriggerCard(cardId)
        .trigger(this, { name: t.name || '', duration: t.total_seconds })
        .catch((err: any) => this.logger.error(`Error firing ${cardId} trigger:`, err));
    } catch (err) {
      this.logger.error(`Error firing ${cardId} trigger:`, err);
    }
  }

  /** Condition card: true while a countdown is active (a ringing timer is not "running"). */
  isTimerRunning(): boolean {
    const active = this.timerManager?.getActiveTimer();
    return !!active && !active.finished;
  }

  /** Action card: start a timer from a flow. Replaces any existing one (no user to ask). */
  startTimerFromFlow(durationSeconds: number, name: string): void {
    const result = this.timerManager.startTimer(durationSeconds, name || '', true);
    if (!result.ok) {
      throw new Error(result.message);
    }
  }

  /** Action card: cancel the running/ringing timer. No-op (silent) if none. */
  cancelTimerFromFlow(): void {
    this.timerManager?.cancelTimer();
  }

  // --- Timer tile capabilities -------------------------------------------------

  /**
   * Add the timer capabilities to devices that were paired before they existed
   * (new pairings get them from the driver manifest) and set the idle defaults.
   */
  private async ensureTimerCapabilities(): Promise<void> {
    for (const cap of ['timer_active', 'timer_remaining', 'timer_name']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch((err: any) =>
          this.logger.error(`Failed to add capability ${cap}:`, err));
      }
    }
    this.syncTimerCapabilities();
  }

  /** Push the active timer's state onto the tile (idle/cleared when there is none). */
  private syncTimerCapabilities(): void {
    const t = this.timerManager?.getActiveTimer();
    // A ringing (finished) timer is not "running" — mirrors the timer-is-running condition.
    const running = !!t && !t.finished;
    this.setTimerCapability('timer_active', running);
    this.setTimerCapability('timer_remaining', running ? t!.seconds_left : 0);
    this.setTimerCapability('timer_name', t ? (t.name || '') : '');
  }

  private setTimerCapability(cap: string, value: boolean | number | string): void {
    if (!this.hasCapability(cap)) {
      return;
    }
    this.setCapabilityValue(cap, value).catch((err: any) =>
      this.logger.error(`Failed to set ${cap}:`, err));
  }

  private startTimerCapabilityTick(): void {
    this.stopTimerCapabilityTick();
    this.timerTickInterval = this.homey.setInterval(() => this.syncTimerCapabilities(), 1000);
  }

  private stopTimerCapabilityTick(): void {
    if (this.timerTickInterval) {
      this.homey.clearInterval(this.timerTickInterval);
      this.timerTickInterval = null;
    }
  }


  private async saveInputBuffer() {

    if (!this.inputBuffer || this.inputBuffer.length === 0) {
      this.logger.warn('No input buffer available to play');
      return;
    }

    const flac = await pcmToFlacBuffer(Buffer.concat(this.inputBuffer), {
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16
    });

    var inputData: AudioData = {
      data: flac,
      extension: 'flac',
      prefix: 'rx'
    };

    this.inputPlaybackUrl = await this.webServer.buildStream(inputData);
  }



  private updateAvailable() {
    var current = this.getAvailable();
    if (this.isAgentHealthy && this.isEspClientHealthy) {
      if (current === false) {
        this.setAvailable();
      }
    } else if (current === true) {
      this.setUnavailable();
    }
  }


  // Called for every discovery result; return truthy if it’s this device
  onDiscoveryResult(r: any) {
    return r.id === this.getData().id;
  }

  // First time we see the device (after onDiscoveryResult==true)
  async onDiscoveryAvailable(r: any) {
    await this.setStoreValue('address', r.address).catch(this.error);
    await this.setStoreValue('port', r.port ?? 6053).catch(this.error);
  }

  // IP changed (e.g., DHCP lease renewal)
  onDiscoveryAddressChanged(r: any) {
    this.logger.info('Device address changed, updating ESP client', undefined, r);
    this.setStoreValue('address', r.address).catch(this.error);
    this.esp.disconnect();
    this.esp.setHost(r.address);
    this.esp.start().catch(this.error);
  }

  // Seen again after being offline, try to reconnect
  onDiscoveryLastSeenChanged(_r: any) {
    // Not needed, will automatically reconnect
  }



  /**
   * Convert milliseconds to bytes for PCM audio
   * @param ms Milliseconds to convert
   * @param sampleRate Sample rate in Hz (default: 16000)
   * @param channels Number of channels (default: 1)
   * @param bytesPerSample Bytes per sample (default: 2)
   * @returns Number of bytes
   */
  private msToBytes(ms: number, sampleRate: number = 16000, channels: number = 1, bytesPerSample: number = 2): number {
    return Math.floor((ms / 1000) * sampleRate * channels * bytesPerSample);
  }

  /**
   * One-line JSON for the conversation trace. Long payloads (device lists, tool
   * results) are truncated so a single tool call can't flood the log.
   */
  private compact(value: any, max: number = 250): string {
    let s: string;
    try {
      s = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      s = String(value);
    }
    s = s ?? '';
    return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
  }




  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded(): Promise<void> {
    this.logger.info('Device has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys, }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.logger.info("Settings where changed");

    // Must read from newSettings: the SDK persists the new values only AFTER
    // onSettings resolves, so this.getSettings() still returns the OLD values
    // here — the previous code made every save apply the *previous* save's
    // numbers, which is maddening when tuning the skip values.
    const skipMs = newSettings.initial_audio_skip as number | undefined | null;
    // 0 is a valid, deliberate value (no wake-ding skip) — only null/undefined
    // means "not configured".
    this.skipInitialBytes = (skipMs ?? null) !== null
      ? this.msToBytes(skipMs as number, 16000, 1, 2)
      : null;

    const followupSkipMs = (newSettings.followup_audio_skip ?? this.DEFAULT_FOLLOWUP_SKIP_MS) as number;
    this.followupSkipBytes = this.msToBytes(followupSkipMs, 16000, 1, 2);

    this.logger.info(`Audio skip updated: initial=${skipMs ?? 'unset'}ms, followup=${followupSkipMs}ms`);
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string): Promise<void> {
    this.logger.info('Device was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted(): Promise<void> {
    this.logger.info('Device has been deleted');

    // Clean up settings subscription
    if (this.settingsUnsubscribe) {
      this.settingsUnsubscribe();
      this.settingsUnsubscribe = undefined;
    }

    // Safely disconnect ESP client
    try {
      if (this.esp) {
        // Remove event listeners before disconnecting to prevent any event-triggered actions
        this.esp.removeAllListeners();
        await this.esp.disconnect().catch(err => {
          this.logger.error('Error while disconnecting ESP client:', err);
        });
      }
    } catch (err) {
      this.logger.error('Failed to properly disconnect ESP client:', err);
    } finally {
      this.esp = null!;
    }

    // Safely close agent
    try {
      if (this.provider) {
        this.provider.close();
      }
    } catch (err) {
      this.error('Failed to close agent:', err);
    } finally {
      this.provider = null!;
    }

    //Unregister with device manager
    this.deviceManager.unRegisterDevice(this.macAddress);

    // Stop any running countdown so its setTimeout can't fire after teardown.
    try {
      this.stopTimerCapabilityTick();
      this.timerManager?.dispose();
    } catch (err) {
      this.logger.error('Failed to dispose timer manager:', err);
    }

    // Cleanup other resources
    this.audioOutput = null!;
    this.toolManager = null!;
    this.timerManager = null!;
  }

}