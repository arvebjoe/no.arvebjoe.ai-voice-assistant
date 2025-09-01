import Homey from 'homey';
import { WebServer } from '../helpers/webserver.mjs';
import { EspVoiceAssistantClient } from '../voice_assistant/esp-voice-assistant-client.mjs';
import { DeviceManager } from '../helpers/device-manager.mjs';
import { settingsManager } from '../settings/settings-manager.mjs';
import { OpenAIRealtimeAgent, RealtimeOptions } from '../llm/openai-realtime-agent.mjs';
import { pcmToFlacBuffer } from '../helpers/audio-encoders.mjs';
import { PcmSegmenter } from '../helpers/pcm-segmenter.mjs';
import { AudioData, FileInfo } from '../helpers/interfaces.mjs';
import { ToolManager } from '../llm/tool-manager.mjs';
import { DeviceStore } from '../helpers/interfaces.mjs';
import { createLogger } from '../helpers/logger.mjs';
import { SOUND_URLS } from '../helpers/sound-urls.mjs';
import { scheduleAudioFileDeletion } from '../helpers/file-helper.mjs';


export default abstract class VoiceAssistantDevice extends Homey.Device {
  private esp!: EspVoiceAssistantClient;
  private webServer!: WebServer;
  private deviceManager!: DeviceManager;
  private devicePromise!: Promise<void>;
  private toolManager!: ToolManager;
  private agent!: OpenAIRealtimeAgent;
  private segmenter!: PcmSegmenter;
  private settingsUnsubscribe?: () => void;
  private agentOptions!: RealtimeOptions;
  private isMutedValue: boolean = false;
  private logger = createLogger('Voice_Assistant_Device', false);
  private skippedBytes: number = 0;
  private skipInitialBytes: number | null = null;
  abstract readonly needDelayedPlayback: boolean;

  private inputBufferDebug: boolean = false;
  private inputBuffer: Buffer[] = [];
  private inputPlaybackUrl?: FileInfo | null = null;

  private hasIntent: boolean = false;
  private announceUrls: FileInfo[] = [];
  private isPlaying: boolean = false;

  private isAgentHealthy: boolean = false;
  private isEspClientHealthy: boolean = false;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit(): Promise<void> {
    this.logger.info('Initializing');

    this.setUnavailable();
    this.setCapabilityValue('onoff', false);
    this.RegisterCapabilities();

    const store = this.getStore() as DeviceStore;
    const settings = this.getSettings();

    // Subscribe to global settings changes to update agent on the fly
    this.settingsUnsubscribe = settingsManager.onGlobals((newSettings) => {
      this.handleSettingsChange(newSettings);
    });

    this.webServer = (this.homey as any).app.webServer as InstanceType<typeof WebServer>;
    this.deviceManager = (this.homey as any).app.deviceManager as InstanceType<typeof DeviceManager>;


    if (settings.initial_audio_skip) {
      this.skipInitialBytes = this.msToBytes(settings.initial_audio_skip, 16000, 1, 2);
    }


    this.agentOptions = {
      apiKey: settingsManager.getGlobal('openai_api_key'),
      voice: settingsManager.getGlobal('selected_voice') || 'alloy',
      languageCode: settingsManager.getGlobal('selected_language_code') || 'en',
      languageName: settingsManager.getGlobal('selected_language_name') || 'English',
      additionalInstructions: settingsManager.getGlobal('ai_instructions') || ''
    };

    // Initialize tool manager - This will define all the function the agent can call.
    this.toolManager = new ToolManager(this.homey, this.deviceManager);

    // Initialize open ai agent - Will use the tool manager for function calls
    this.agent = new OpenAIRealtimeAgent(this.homey, this.toolManager, this.agentOptions);

    // Initialize ESP voice client - Uses stored address and port
    this.esp = new EspVoiceAssistantClient({
      host: store.address,
      apiPort: store.port
    });

    // Initialize PCM segmenter for audio processing - This will split long audio streams into manageable chunks -> Makes response quicker
    this.segmenter = new PcmSegmenter();


    //
    //
    // Handlers between agent, esp and segmenter
    //
    //

    // The esp voice client has woken (by wake word or user action)
    this.esp.on('start', async () => {

      if (!this.agent.isConnected()) {
        // The agent doesn't have an active web socket. Either the API Key is missing or the internet connection failed.
        // Play a pre-recorded message to inform the user.
        const hasKey = this.agent.hasApiKey();
        const url = hasKey ? SOUND_URLS.agent_not_connected : SOUND_URLS.missing_api_key;
        this.playUrl(url);
        return;
      }

      // Initialize input buffer, only used for debugging.
      this.inputBuffer = [];

      // Reset skipped bytes counter for new session
      this.skippedBytes = 0;

      this.logger.info("Voice session started");
      // Let's start getting device state over the API, this might take a while, but should be done when we actually need it
      this.devicePromise = this.deviceManager.fetchData();


      this.setCapabilityValue('onoff', true);
      this.esp.run_start();
      this.esp.stt_vad_start();
      this.esp.begin_mic_capture();
    });


    // There is some audio data available from the microphone
    this.esp.on('chunk', (data: Buffer) => {

      // Skip initial bytes to eliminate microphone noise at the start - This is a problem on the PE.
      if (this.skipInitialBytes && this.skippedBytes < this.skipInitialBytes) {
        const remainingToSkip = this.skipInitialBytes - this.skippedBytes;
        const bytesToSkip = Math.min(data.length, remainingToSkip);
        this.skippedBytes += bytesToSkip;

        // If we need to skip the entire chunk, return early
        if (bytesToSkip >= data.length) {
          return;
        }

        // If we only need to skip part of the chunk, slice it
        data = data.slice(bytesToSkip);
      }

      // ESP voice client return a PCM 16bit mono audio stream at 16khz, but OpenAI expects 24khz
      const pcm24 = this.agent.upsample16kTo24k(data);

      // Add pcm24 to input buffer, used for debugging.
      if (this.inputBufferDebug) {
        this.inputBuffer.push(pcm24);
      }

      // Send audio chunk to agent
      this.agent.sendAudioChunk(pcm24);
    });


    // Handle missing API key
    this.agent.on("missing_api_key", async () => {

      await this.homey.notifications.createNotification({
        excerpt: 'AI Assistant: Please set **api key** in app settings.'
      });

    });


    this.agent.on("open", () => {
      this.logger.info('Agent connection opened');
      this.isAgentHealthy = true;
      this.updateAvailable();
    });



    // The agent has detected that the user has stopped speaking.
    this.agent.on('silence', async (source: string) => {
      this.logger.info(`Silence detected by agent (${source}), closing microphone.`);
      this.esp.closeMic();
      this.esp.stt_vad_end(''); // TODO: Which we had some text to pass back here. Will look into this.      
      this.esp.intent_start();
      this.hasIntent = true;

      // Save input buffer to file, used for debugging to hear what was captured
      if (this.inputBufferDebug) {
        await this.saveInputBuffer();
      }

    });

    // The agent is sending audio data back. We can't play each chunk individually, so we need to buffer them.
    this.agent.on('audio.delta', (audioBuffer: Buffer) => {
      this.segmenter.feed(audioBuffer);
    });

    this.agent.on('text.done', (msg: any) => {
      this.logger.info('Text processing done:', undefined, msg);
    });

    // The segmenter has detected a small silent gap in what the agent said and has produced a new chunk of audio data for us to play.
    this.segmenter.on('chunk', async (chunk: Buffer) => {
      this.logger.info(`New TX chunk: ${chunk.length} bytes`);


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
      this.logger.info('Announcement finished');

      if (this.announceUrls.length === 0) {
        this.isPlaying = false;
        this.esp.tts_end()
        this.esp.run_end();
        this.agent.resetUpsampler();
        this.setCapabilityValue('onoff', false);
        this.logger.info(`Done playing announcements`);
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
    this.agent.on('tool.called', async (d: { callId: string; name: string; args: any }) => {
      this.logger.info(`${d.name}`, 'TOOL_CALLED', d.args);
      await this.devicePromise;
    });

    // The agent has finished processing the response. Tell the segmenter there is no more data coming.
    this.agent.on('response.done', () => {
      this.logger.info("Conversation completed");
      this.segmenter.flush(); // If there is anything left in the segmenter, flush it. This will force it to play on the speaker.

    });

    // The segmenter has emitted all its chunks, so tell the esp to stop and clean all resources.
    this.segmenter.on('done', async () => {
      this.esp.closeMic();
    });


    this.agent.on('error', (error: Error) => {
      this.logger.error("Realtime agent error:", error);
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
    this.agent.on('Healthy', () => {
      this.logger.info('Agent connection healthy');
      this.isAgentHealthy = true;
      this.updateAvailable();
    });

    this.agent.on('Unhealthy', () => {
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


    // Actually start the ESP and agent.
    await this.esp.start();
    await this.agent.start();

    this.logger.info('Initialized');
  }





  /**
   * Handle settings changes and update agent accordingly
   */
  private async handleSettingsChange(newSettings: any): Promise<void> {
    this.logger.info('Settings changed, updating agent...', undefined, newSettings);

    if (this.agentOptions == null) {
      return;
    }

    try {
      // Check if API key changed
      const newApiKey = newSettings.openai_api_key;

      this.logger.info(`New API key: ${newApiKey}`);
      this.logger.info(`Current API key: ${this.agentOptions.apiKey ?? 'NULL'}`);

      if (newApiKey && newApiKey !== this.agentOptions.apiKey) {
        this.logger.info(`API key changed, updating agent and restarting.`);
        this.agentOptions.apiKey = newApiKey;
        await this.agent.updateApiKeyWithRestart(newApiKey);
      }

      // Check if voice changed
      const newVoice = newSettings.selected_voice;
      if (newVoice && newVoice !== this.agentOptions.voice) {
        this.logger.info(`Voice changed from ${this.agentOptions.voice} to ${newVoice}`);
        this.agentOptions.voice = newVoice;
        this.agent.updateVoiceWithReconnect(this.agentOptions.voice);
      }

      // Check if language changed
      const newLanguageCode = newSettings.selected_language_code;
      const newLanguageName = newSettings.selected_language_name;
      if (newLanguageCode && newLanguageCode !== this.agentOptions.languageCode) {
        this.logger.info(`Language code changed from ${this.agentOptions.languageCode} to ${newLanguageCode}`);
        // TODO: Add updateLanguage method to OpenAIRealtimeWS or restart connection
        this.agentOptions.languageCode = newLanguageCode;
        this.agentOptions.languageName = newLanguageName || 'English';
        this.agent.updateLanguage(this.agentOptions.languageCode, this.agentOptions.languageName);
      }

      // Check if AI instructions changed
      const newInstructions = newSettings.ai_instructions;
      if (newInstructions !== this.agentOptions.additionalInstructions) {
        this.logger.info('AI instructions changed, updating...');
        this.agentOptions.additionalInstructions = newInstructions || '';
        this.agent.updateAdditionalInstructions(this.agentOptions.additionalInstructions);
      }

    } catch (error) {
      this.logger.error('Failed to update agent settings:', error);
    }
  }



  private RegisterCapabilities() {


    this.registerCapabilityListener('onoff', async (value: boolean) => {
      this.logger.info(`Capability onoff changed to: ${value}`);

      if (this.esp && value) {
        this.esp.run_start();
        this.esp.playAudioFromUrl(SOUND_URLS.wake_word_triggered, true);
      }

    });

    this.registerCapabilityListener('volume_set', async (value: number) => {
      this.logger.info(`Capability volume_set changed to: ${value}`);
      // Send the volume command to the ESPHome device
      if (this.esp && this.esp.setVolume) {
        this.esp.setVolume(value);
      } else {
        this.logger.error('ESP client not initialized or setVolume method not available');
      }
    });

    this.registerCapabilityListener('volume_mute', async (value: boolean) => {
      this.logger.info(`Capability volume_mute changed to: ${value}`);
      // Send the mute command to the ESPHome device
      if (this.esp && this.esp.setMute) {
        this.isMutedValue = value;
        this.esp.setMute(value);
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


  speakText(text: string): void {
    this.logger.info(`Speaking text: ${text}`);
    if (this.agent && this.agent.textToSpeech) {
      this.agent.textToSpeech(text);
    } else {
      this.logger.error('Agent not initialized or textToSpeech method not available');
    }
  }

  async askAgentOutputToSpeaker(question: string): Promise<void> {
    this.logger.info(`Asking agent to output to speaker: ${question}`);

    if (this.agent && this.agent.sendTextForAudioResponse) {
      await this.deviceManager.fetchData();
      this.agent.sendTextForAudioResponse(question);
    } else {
      this.logger.error('Agent not initialized or sendTextForAudioResponse method not available');
    }

  }


  async askAgentOutputToText(question: string): Promise<string> {
    this.logger.info(`Asking agent to output as text: ${question}`);

    if (this.agent && this.agent.sendTextForTextResponse) {
      await this.deviceManager.fetchData();

      return new Promise<string>((resolve, reject) => {
        // Set up a one-time event listener for text.done
        const textDoneHandler = (msg: any) => {
          this.logger.info('Text response received:', undefined, msg.text);
          resolve(msg.text);
        };

        // Add the event listener for this specific request
        this.agent.once('text.done', textDoneHandler);

        // Set a timeout in case the response never comes
        const timeoutId = setTimeout(() => {
          this.agent.off('text.done', textDoneHandler);
          reject(new Error('Timeout waiting for text response'));
        }, 30000); // 30 seconds timeout

        try {
          // Send the request
          this.agent.sendTextForTextResponse(question);
        } catch (error) {
          // Clear the timeout and remove the listener if sending fails
          clearTimeout(timeoutId);
          this.agent.off('text.done', textDoneHandler);
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
    this.esp.stop();
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
      if (this.agent) {
        this.agent.close();
      }
    } catch (err) {
      this.error('Failed to close agent:', err);
    } finally {
      this.agent = null!;
    }

    // Cleanup other resources
    this.segmenter = null!;
    this.toolManager = null!;
  }

}