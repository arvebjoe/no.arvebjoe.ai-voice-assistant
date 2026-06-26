import Homey from 'homey';
import { WebServer } from '../helpers/webserver.mjs';
import { EspVoiceAssistantClient } from '../voice_assistant/esp-voice-assistant-client.mjs';
import { TimerManager, TimerSummary } from '../voice_assistant/timer-manager.mjs';
import { DeviceManager } from '../helpers/device-manager.mjs';
import { settingsManager } from '../settings/settings-manager.mjs';
import { IVoiceProvider, VoiceProviderOptions } from '../llm/voice-provider.mjs';
import { createVoiceProvider } from '../llm/voice-provider-factory.mjs';
import { pcmToFlacBuffer } from '../helpers/audio-encoders.mjs';
import { PcmSegmenter } from '../helpers/pcm-segmenter.mjs';
import { AudioData, FileInfo } from '../helpers/interfaces.mjs';
import { ToolManager } from '../llm/tool-manager.mjs';
import { DeviceStore } from '../helpers/interfaces.mjs';
import { createLogger } from '../helpers/logger.mjs';
import { SOUND_URLS } from '../helpers/sound-urls.mjs';
import { scheduleAudioFileDeletion } from '../helpers/file-helper.mjs';
import { Pcm16kTo24k } from '../helpers/Pcm16kTo24k.mjs';
import { GeoHelper } from '../helpers/geo-helper.mjs';
import { WeatherHelper } from '../helpers/weather-helper.mjs';


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
  private segmenter!: PcmSegmenter;
  private reSampler?: Pcm16kTo24k;

  private settingsUnsubscribe?: () => void;
  private providerOptions!: VoiceProviderOptions;
  private currentZone: string = '';
  private macAddress: string = '';

  private isMutedValue: boolean = false;
  private logger = createLogger('Voice_Assistant_Device', false);
  private skippedBytes: number = 0;
  private skipInitialBytes: number | null = null;
  // Effective initial-skip for the CURRENT turn (bytes). Derived per turn in 'starting'
  // from skipInitialBytes plus, on PE-auto-reopened conversation turns, a floor (see
  // CONVERSATION_REOPEN_SKIP_MS). The chunk handler uses this, not skipInitialBytes.
  private currentTurnSkipBytes: number = 0;
  // Floor initial-skip for turns inside a start_conversation session. Those turns open
  // the mic immediately after the PE's own speaker finished the reply, so the PE's
  // mic-open noise/echo burst lands at t=0 and trips OpenAI's server VAD (speech_started
  // -> speech_stopped ~silence_duration later) before the user can answer — the ~0.5s
  // dead window. Skipping this much swallows the burst so the mic stays open for the user.
  private readonly CONVERSATION_REOPEN_SKIP_MS: number = 500;
  abstract readonly needDelayedPlayback: boolean;

  private inputBufferDebug: boolean = false;
  private inputBuffer: Buffer[] = [];
  private inputPlaybackUrl?: FileInfo | null = null;

  private hasIntent: boolean = false;
  private announceUrls: FileInfo[] = [];
  private isSteamingMic: boolean = false;
  private isPlaying: boolean = false;

  private isAgentHealthy: boolean = false;
  private isEspClientHealthy: boolean = false;
  private continueConversation: boolean = false;
  private lastTurnEndedAt: number = 0;
  // True while the PE is in a start_conversation session: from when we send the one
  // continue-conversation reopen (send_voice_assistant_request, startConversation:true)
  // until the session ends (a silent turn the user doesn't answer, or >CONTEXT_TTL_MS
  // idle). While true, EVERY turn delivers its reply in-band on TTS_END, because the PE
  // drops standalone announces mid-conversation. The PE auto-reopens the mic after each
  // in-band reply (it is in start_conversation mode), so we send exactly ONE reopen
  // (turn 1 -> first follow-up) and let the PE drive the rest of the chain. Set only when
  // we actually send that reopen (not on every "?"), and cleared on session end and at
  // the start of any say — so it cannot leak across unrelated turns the way the old
  // conversationActive flag did.
  private peConversationActive: boolean = false;
  // True for the follow-up run only: route its reply via the TTS_END URL instead of
  // the announce queue (the PE drops standalone announces mid-conversation).
  // Accumulates the reply PCM to ship as one file.
  private replyViaTtsUrl: boolean = false;
  private replyPcm: Buffer[] = [];
  // Accumulates the assistant's streamed reply (audio transcript or text) for the
  // current turn so the full reply can be logged on response.done.
  private replyText: string = '';
  private readonly CONTEXT_TTL_MS: number = 10_000;

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

    // Subscribe to global settings changes to update agent on the fly
    this.settingsUnsubscribe = settingsManager.onGlobals((newSettings) => {
      this.handleSettingsChange(newSettings);
    });

    this.webServer = (this.homey as any).app.webServer as InstanceType<typeof WebServer>;
    this.deviceManager = (this.homey as any).app.deviceManager as InstanceType<typeof DeviceManager>;
    this.geoHelper = (this.homey as any).app.geoHelper as InstanceType<typeof GeoHelper>; 
    this.weatherHelper = (this.homey as any).app.weatherHelper as InstanceType<typeof WeatherHelper>; 



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
    this.provider = createVoiceProvider(this.homey, this.toolManager, this.providerOptions);

    // Match the mic resampler to the provider's expected input rate. The PE mic is
    // PCM16 mono 16 kHz; providers wanting 24 kHz (OpenAI) get an upsampler, while
    // providers wanting 16 kHz (Gemini) take the raw stream (passthrough).
    if (this.provider.inputSampleRate !== 16000) {
      this.reSampler = new Pcm16kTo24k({
        outRate: this.provider.inputSampleRate,
        frameDurationMs: 20,
        method: "cubic"
      });
    }

    // Initialize PCM segmenter for audio processing - This will split long audio streams into manageable chunks -> Makes response quicker
    this.segmenter = new PcmSegmenter();


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
      if (this.isSteamingMic) {
        this.logger.info('Ignoring duplicate wake — already streaming mic');
        return;
      }

      if (!this.provider.isConnected()) {
        // The agent doesn't have an active web socket. Either the API Key is missing or the internet connection failed.
        // Play a pre-recorded message to inform the user.
        const hasKey = this.provider.hasApiKey();
        const url = hasKey ? SOUND_URLS.agent_not_connected : SOUND_URLS.missing_api_key;
        this.esp.run_start();
        this.esp.pipeline_error('agent-not-connected', hasKey ? 'Voice agent is not connected.' : 'API key is missing.');
        this.esp.run_end();
        this.playUrl(url);
        return;
      }

      // If enough time has passed since the last turn ended, treat this as a
      // brand-new conversation and clear stale context. Quick follow-ups keep
      // their context: a continue-conversation reopen fires within ~1s, well
      // under the TTL, so "nei, jeg mente stua" still resolves against the
      // previous turn.
      const idleMs = Date.now() - this.lastTurnEndedAt;
      if (this.lastTurnEndedAt > 0 && idleMs > this.CONTEXT_TTL_MS) {
        this.logger.info(`Idle ${Math.round(idleMs / 1000)}s since last turn — starting fresh conversation`);
        this.provider.resetConversation();
        // Long gap => any prior start_conversation session is over; next reply goes
        // via the announce path, and the PE is no longer in conversation mode.
        this.peConversationActive = false;
      }

      // Initialize input buffer, only used for debugging.
      this.inputBuffer = [];

      // Reset skipped bytes counter for new session
      this.skippedBytes = 0;

      this.isSteamingMic = true;

      // While the PE is in a start_conversation session, every turn (the follow-up our
      // reopen opened AND every turn the PE auto-reopens after an in-band reply) must
      // deliver its reply in-band on TTS_END — a standalone announce gets dropped
      // mid-conversation. A plain say / wake / manual-on turn has peConversationActive
      // false, so it uses the announce path (which is what fires the first reopen).
      this.replyViaTtsUrl = this.peConversationActive;
      this.replyPcm = [];

      // Pick this turn's effective initial-skip. Conversation turns (peConversationActive)
      // always carry the PE's mic-open noise burst right after playback, so enforce a
      // floor that swallows it; honor a larger global initial_audio_skip if configured.
      // Plain wake/say turns keep just the global value so a fast first utterance isn't clipped.
      const floorSkipBytes = this.peConversationActive
        ? this.msToBytes(this.CONVERSATION_REOPEN_SKIP_MS, 16000, 1, 2)
        : 0;
      this.currentTurnSkipBytes = Math.max(this.skipInitialBytes ?? 0, floorSkipBytes);

      this.logger.info("Voice session started");
      // Let's start getting device state over the API, this might take a while, but should be done when we actually need it
      this.devicePromise = this.deviceManager.fetchData();

      this.setCapabilityValue('onoff', true);
      this.esp.run_start();
      this.esp.wake_word_end();
      this.esp.stt_start();
      this.esp.stt_vad_start();
      this.esp.begin_mic_capture();
    });

    this.esp.on('started', async () => {
    });

    // There is some audio data available from the microphone
    this.esp.on('chunk', (data: Buffer) => {

      // Skip initial bytes to eliminate microphone noise at the start - This is a problem on the PE.
      // Uses the per-turn effective skip (currentTurnSkipBytes), which is raised on
      // conversation reopens — see CONVERSATION_REOPEN_SKIP_MS.
      if (this.currentTurnSkipBytes && this.skippedBytes < this.currentTurnSkipBytes) {
        const remainingToSkip = this.currentTurnSkipBytes - this.skippedBytes;
        const bytesToSkip = Math.min(data.length, remainingToSkip);
        this.skippedBytes += bytesToSkip;

        // If we need to skip the entire chunk, return early
        if (bytesToSkip >= data.length) {
          return;
        }

        // If we only need to skip part of the chunk, slice it
        data = data.slice(bytesToSkip);
      }

      if (!this.isSteamingMic) {
        return;
      }


      // ESP client emits PCM16 mono 16 kHz. Resample to the provider's input rate
      // when it differs (e.g. OpenAI 24 kHz); otherwise pass the 16 kHz through.
      const frames: Buffer[] = this.reSampler ? (this.reSampler.push(data) as Buffer[]) : [data];
      for (const chunk of frames) {

        if (this.inputBufferDebug) {
          // Add chunk to input buffer, used for debugging.
          this.inputBuffer.push(chunk);
        }

        // Send audio chunk to provider
        this.provider.sendAudioChunk(chunk);
      }


    });


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



    // The agent has detected that the user has stopped speaking.
    this.provider.on('silence', async (source: string) => {
      this.logger.info(`Silence detected by agent (${source}), closing microphone.`);
      this.hasIntent = true;
      this.isSteamingMic = false;
      this.esp.closeMic();
      this.reSampler?.reset();
      this.esp.stt_vad_end(''); // TODO: Which we had some text to pass back here. Will look into this.                  
      // Save input buffer to file, used for debugging to hear what was captured
      if (this.inputBufferDebug) {
        await this.saveInputBuffer();
      }

    });

    // The agent is sending audio data back. We can't play each chunk individually, so we need to buffer them.
    this.provider.on('audio.delta', (audioBuffer: Buffer) => {
      this.segmenter.feed(audioBuffer);
    });

    this.provider.on('transcript.delta', (delta: string) => {
      this.replyText += delta ?? '';

      // Check if the delta contains a question, and if so, set continueConversation to true
      // Dirt simple, but works more reliably than having the AI call a tool.
      const text = (delta ?? '').trim();
      if (/[?？]\s*$/.test(text)) {
        this.continueConversation = true;
      }

      // Send INTENT_PROGRESS to the PE so it can start streaming TTS earlier
      if (text) {
        this.esp.intent_progress(text);
      }
    });

    this.provider.on('transcript.done', (transcript: any) => {
      this.logger.info('Final transcript: '+ transcript, "transcript");

      transcript = (transcript ?? '').trim();

      if (transcript == '' || transcript.toLowerCase() === "undertekster av ai-media") {
        // Yeah, this is a strange one. If the STT engine doesn't hear anything useful, it will return this text. I don't know why.
        // No answer => the user has left the conversation: end the PE's start_conversation
        // session so it stops auto-reopening and the next turn starts fresh on the
        // announce path. Clear replyViaTtsUrl too so a stray segmenter 'done' can't emit
        // a duplicate in-band tts_end/run_end on top of the run_end we send here.
        this.peConversationActive = false;
        this.replyViaTtsUrl = false;
        this.esp.stt_end('');
        this.esp.run_end();
        this.setCapabilityValue('onoff', false);
        this.lastTurnEndedAt = Date.now();
        return;
      }

      this.esp.stt_end(transcript);
      this.esp.intent_start();
    });

    // Text-mode replies stream as text deltas (e.g. the emulator's `ask`); accumulate
    // them too so response.done can log the full reply regardless of output mode.
    this.provider.on('text.delta', (delta: string) => {
      this.replyText += delta ?? '';
    });


    // The segmenter has detected a small silent gap in what the agent said and has produced a new chunk of audio data for us to play.
    this.segmenter.on('chunk', async (chunk: Buffer) => {
      this.logger.info(`New TX chunk: ${chunk.length} bytes`);

      // Continue run: the PE won't fetch a standalone announce mid-conversation,
      // so don't stream per-chunk announces. Accumulate the PCM and ship the whole
      // reply as one file on TTS_END (see the segmenter 'done' handler). Still emit
      // the intent_end -> tts_start transition so the PE shows the "replying" state.
      if (this.replyViaTtsUrl) {
        if (this.hasIntent) {
          this.esp.intent_end('');
          this.hasIntent = false;
          this.esp.tts_start();
        }
        this.replyPcm.push(chunk);
        return;
      }


      // If we have an input buffer to play, do that first, before playing the new chunk from the segmenter
      if (this.inputBufferDebug && this.inputPlaybackUrl) {
        this.playUrlByFileInfo(this.inputPlaybackUrl, false);
        this.inputPlaybackUrl = null;
      }

      const flac = await pcmToFlacBuffer(chunk, {
        sampleRate: 24_000,
        channels: 1,
        bitsPerSample: 16
      });

      const audioData: AudioData = {
        data: flac,
        extension: 'flac',
        prefix: 'tx'
      }

      if (this.hasIntent) {
        this.esp.intent_end('');
        this.hasIntent = false;
        this.esp.tts_start();
      }

      const fileInfo = await this.webServer.buildStream(audioData);

      if (this.isPlaying) {
        this.announceUrls.push(fileInfo);
        return;
      }

      this.isPlaying = true;
      this.logger.info(`Playing FIRST announcement from URL: ${fileInfo.url}`);
      this.playUrlByFileInfo(fileInfo, false);

    });


    this.esp.on('announce_finished', () => {
      // This handler only drives the multi-segment announce QUEUE (say/wake replies).
      // The reopen and continue-reply announces also ack with AnnounceFinished, often
      // late (during a later turn). Those arrive with isPlaying=false; ignore them so
      // they can't spuriously end a run or trigger a second reopen.
      if (!this.isPlaying) {
        this.logger.info('Ignoring stray announce_finished (no announce queue active)');
        return;
      }

      this.logger.info('Announcement finished');

      if (this.announceUrls.length === 0) {
        this.isPlaying = false;
        this.esp.tts_end()
        this.esp.run_end();
        this.setCapabilityValue('onoff', false);
        this.logger.info(`Done playing announcements`);
        this.lastTurnEndedAt = Date.now();

        if (this.continueConversation) {
          this.continueConversation = false;
          // The reply ended in a question: open the conversation. Reopen the mic once
          // ourselves (startConversation:true puts the PE into conversation mode) and
          // mark the session active so this turn AND every turn the PE auto-reopens
          // afterwards delivers its reply in-band on TTS_END. We send only THIS reopen;
          // the PE drives the rest of the chain.
          this.peConversationActive = true;

          this.homey.setTimeout(() => {
            this.esp.send_voice_assistant_request();
          }, 1);

        }
        return;
      }

      const fileInfo = this.announceUrls.shift()!;
      this.logger.info(`Playing NEXT announcement from URL: ${fileInfo.url}`);

      if (this.needDelayedPlayback) {
        this.homey.setTimeout(() => {
          this.esp.tts_start();
          this.playUrlByFileInfo(fileInfo, false);
        }, 500);

      } else {
        this.playUrlByFileInfo(fileInfo, false);

      }



    });


    // The agent want's to use a tool. We need to make sure we have all the data from the API now.    
    this.provider.on('tool.called', async (d: { callId: string; name: string; args: any }) => {
      this.logger.info(`${d.name}`, 'TOOL_CALLED', d.args);
      await this.devicePromise;
    });

    // The agent has finished processing the response. Tell the segmenter there is no more data coming.
    this.provider.on('response.done', () => {
      const reply = this.replyText.trim();
      if (reply) {
        this.logger.info(`LLM reply: ${reply}`, "LLM");
      }
      this.replyText = '';

      this.logger.info("Conversation completed");
      this.segmenter.flush(); // If there is anything left in the segmenter, flush it. This will force it to play on the speaker.

    });

    // The segmenter has emitted all its chunks, so tell the esp to stop and clean all resources.
    this.segmenter.on('done', async () => {
      this.esp.closeMic();

      // In-band reply for a turn inside the PE's start_conversation session: deliver on
      // TTS_END carrying the FLAC URL — the only mechanism the PE reliably plays
      // mid-conversation (standalone announces, even with startConversation:true, get
      // dropped). After this the PE auto-reopens the mic for the next turn, so chained
      // questions keep flowing in-band; the session ends when the user answers with
      // silence (see transcript.done) or after CONTEXT_TTL_MS idle.
      if (this.replyViaTtsUrl) {
        this.replyViaTtsUrl = false;
        const pcm = this.replyPcm;
        this.replyPcm = [];

        let fileUrl: string | null = null;
        if (pcm.length > 0) {
          const flac = await pcmToFlacBuffer(Buffer.concat(pcm), {
            sampleRate: 24_000,
            channels: 1,
            bitsPerSample: 16,
          });
          const fileInfo = await this.webServer.buildStream({ data: flac, extension: 'flac', prefix: 'tx' });
          fileUrl = fileInfo.url;
        }

        if (fileUrl) {
          this.logger.info(`Continue reply via TTS_END URL: ${fileUrl}`);
          this.esp.tts_end(fileUrl);
        } else {
          this.esp.tts_end();
        }
        this.esp.run_end();
        this.continueConversation = false;
        this.setCapabilityValue('onoff', false);
        this.lastTurnEndedAt = Date.now();
      }
    });


    this.provider.on('error', (error: Error) => {
      this.logger.error("Realtime agent error:", error);
      if (this.isSteamingMic || this.isPlaying) {
        this.esp.pipeline_error('agent-error', error.message || 'An error occurred in the voice agent.');
        this.esp.run_end();
        this.isSteamingMic = false;
        this.isPlaying = false;
        this.setCapabilityValue('onoff', false);
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
      //this.logger.error('Mute test2', 'Jælle balle2');
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
      this.updateAvailable();
    });

    this.esp.on('Healthy', async () => {
      this.logger.info('ESP Voice Client healthy');
      this.isEspClientHealthy = true;
      this.updateAvailable();
    });

    this.esp.on('Unhealthy', () => {
      this.logger.info('ESP Voice Client unhealthy');
      this.isEspClientHealthy = false;
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
   * Handle settings changes and update agent accordingly
   */
  private async handleSettingsChange(newSettings: any): Promise<void> {
    this.logger.info('Settings changed, updating agent...', undefined, newSettings);

    if (this.providerOptions == null) {
      return;
    }

    try {
      let needRestart: boolean = false;

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
    scheduleAudioFileDeletion(this.homey, fileInfo);
  }


  async speakText(text: string): Promise<void> {
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
    this.logger.info(`Asking agent to output to speaker: ${question}`);

    // A say always starts a fresh turn on the announce path: clear any stale session
    // state so the reply isn't mis-routed in-band, and so turn 1 of a multi-question
    // quiz goes out as an announce (which is what fires the first reopen).
    this.peConversationActive = false;
    this.replyViaTtsUrl = false;
    this.replyPcm = [];

    if (this.provider && this.provider.sendTextForAudioResponse) {
      await this.deviceManager.fetchData();
      this.provider.sendTextForAudioResponse(question);
    } else {
      this.logger.error('Agent not initialized or sendTextForAudioResponse method not available');
    }

  }


  async askAgentOutputToText(question: string): Promise<string> {
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

    // Yeah, i'm a bit lazy
    const settings = this.getSettings();
    if (settings.initial_audio_skip) {
      this.skipInitialBytes = this.msToBytes(settings.initial_audio_skip, 16000, 1, 2);
    }

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
    this.segmenter = null!;
    this.toolManager = null!;
    this.timerManager = null!;
  }

}