import Homey from 'homey';
import { WebServer } from '../helpers/webserver.mjs';
import { EspVoiceAssistantClient } from '../voice_assistant/esp-voice-assistant-client.mjs';
import { DeviceManager } from '../helpers/device-manager.mjs';
import { settingsManager } from '../settings/settings-manager.mjs';
import { OpenAIRealtimeAgent, RealtimeOptions } from '../llm/openai-realtime-agent.mjs';
import { pcmToFlacBuffer } from '../helpers/audio-encoders.mjs';
import { PcmSegmenter } from '../helpers/pcm-segmenter.mjs';
import { AudioData } from '../helpers/interfaces.mjs';
import { ToolManager } from '../llm/tool-manager.mjs';
import { DeviceStore } from '../helpers/interfaces.mjs';
import { createLogger } from '../helpers/logger.mjs';


export default abstract class VoiceAssistantDevice extends Homey.Device {
  private esp!: EspVoiceAssistantClient;
  private webServer!: WebServer;
  private deviceManager!: DeviceManager;
  private devicePromise!: Promise<void>;
  private toolManager!: ToolManager;
  private agent!: OpenAIRealtimeAgent;
  private segmenter!: PcmSegmenter;
  private settingsUnsubscribe?: () => void; // To clean up the subscription
  private currentSettings: any = {}; // Store current settings to detect changes
  private isMutedValue: boolean = false;
  private logger = createLogger('Voice_Assistant_Device');

  /**
   * onInit is called when the device is initialized.
   */
  async onInit(): Promise<void> {
    this.logger.info('Initializing');

    this.setUnavailable();
    this.setCapabilityValue('onoff', false);


    this.RegisterCapabilities();


    this.webServer = (this.homey as any).app.webServer as InstanceType<typeof WebServer>;
    this.deviceManager = (this.homey as any).app.deviceManager as InstanceType<typeof DeviceManager>;



    // Register device-specific settings snapshot so utilities without this.homey can reference it
    try {
      const deviceId = (this.getData() as any)?.id || (this as any).id || this.getName();
      const store = this.getStore() as DeviceStore;
      settingsManager.registerDevice(deviceId, store);
    } catch (e) {
      this.logger.error('Failed to register device settings', e);
    }



    const agentOptions: RealtimeOptions = {
      apiKey: settingsManager.getGlobal('openai_api_key'),
      model: "gpt-4o-realtime-preview", //"gpt-4o-realtime-preview-2025-06-03"
      voice: settingsManager.getGlobal('selected_voice') || 'alloy',
      languageCode: settingsManager.getGlobal('selected_language_code') || 'en',
      languageName: settingsManager.getGlobal('selected_language_name') || 'English',
      additionalInstructions: settingsManager.getGlobal('ai_instructions') || '',
      outputAudioFormat: "pcm16",
      turnDetection: { type: "server_vad" }, // server VAD on
      enableLocalVAD: false,                  // local VAD also on
      //localVADSilenceThreshold: 0.5,
      //localVADSilenceMs: 2000,
      verbose: true,
    };

    this.toolManager = new ToolManager(this.deviceManager);

    // TODO: Pass this.homey and this.toolMaker to the agent
    this.agent = new OpenAIRealtimeAgent(this.toolManager, agentOptions);

    // Store initial settings
    this.currentSettings = {
      voice: agentOptions.voice,
      languageCode: agentOptions.languageCode,
      languageName: agentOptions.languageName,
      additionalInstructions: agentOptions.additionalInstructions
    };

    // Subscribe to settings changes to update agent on the fly
    this.settingsUnsubscribe = settingsManager.onGlobals((newSettings) => {
      this.handleSettingsChange(newSettings);
    });


    const store = this.getStore() as DeviceStore;
    // Initialize and start EspVoiceAssistantClient

    this.esp = new EspVoiceAssistantClient({
      host: store.address,
      apiPort: store.port
    });

    
    this.segmenter = new PcmSegmenter();

    this.esp.on('start', async () => {
      this.logger.info("Voice session started");
      this.devicePromise = this.deviceManager.fetchData();
      this.setCapabilityValue('onoff', true);
      this.esp.run_start();
      this.esp.stt_vad_start();
      this.esp.begin_mic_capture();
    });

    // Bind the event handler to this class instance
    this.esp.on('chunk', (data: Buffer) => {
      const pcm24 = this.agent.upsample16kTo24k(data);
      this.agent.sendAudioChunk(pcm24);
    });

    this.agent.on("open", () => {
      this.logger.info('Agent connection opened');
    });

    this.esp.on('connected', async () => {
      this.logger.info('ESP Voice Client connected');
      this.setAvailable();
    });

    this.agent.on('silence', (source: string) => {
      this.logger.info(`Silence detected by agent (${source}), closing microphone.`);
      this.esp.closeMic();
      this.esp.stt_vad_end('');
      this.esp.tts_start();
    });

    this.agent.on('audio.delta', (audioBuffer: Buffer) => {
      this.segmenter.feed(audioBuffer);
    });

    this.agent.on('text.done', (msg: any) => {
      this.logger.info('Text processing done:', undefined, msg);
    });

    this.segmenter.on('chunk', async (chunk: Buffer) => {
      this.logger.info(`New TX chunk: ${chunk.length} bytes`);

      // TODO: Do not store sample rate, channels, and bits per sample here!
      const flac = await pcmToFlacBuffer(chunk, {
        sampleRate: 24_000,
        channels: 1,
        bitsPerSample: 16
      });

      const audioData: AudioData = {
        data: flac,
        extension: 'flac'
      }

      const url = await this.webServer.buildStream(audioData);

      this.esp.playAudioFromUrl(url, false);
    });


    this.agent.on('tool.called', async (d: { callId: string; name: string; args: any }) => {
      this.logger.info(`${d.name}`, 'TOOL_CALLED', d.args);
      await this.devicePromise;

    });

    this.agent.on('response.done', () => {
      this.logger.info("Conversation completed");
      this.segmenter.flush();
      this.esp.tts_end();
      this.esp.closeMic();
      this.esp.run_end();
      this.setCapabilityValue('onoff', false);
    });

    this.agent.on('error', (error: Error) => {
      this.logger.error("Realtime agent error:", error);
    });

    this.esp.on('disconnected', () => {
      this.logger.info('ESP Voice Client disconnected');
      this.setUnavailable('Disconnected from ESP Voice Client');
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

    this.agent.on('connectionHealthy', () => {
      this.setAvailable();
    });

    this.agent.on('connectionUnhealthy', () => {
      this.setUnavailable();
    });

    await this.esp.start();
    await this.agent.start();

    this.logger.info('Initialized');
  }

  /**
   * Handle settings changes and update agent accordingly
   */
  private async handleSettingsChange(newSettings: any): Promise<void> {
    this.logger.info('Settings changed, updating agent...', undefined, newSettings);

    try {
      // Check if voice changed
      const newVoice = newSettings.selected_voice;
      if (newVoice && newVoice !== this.currentSettings.voice) {
        this.logger.info(`Voice changed from ${this.currentSettings.voice} to ${newVoice}`);
        this.currentSettings.voice = newVoice;
        this.agent.updateVoiceWithReconnect(this.currentSettings.voice);
      }

      // Check if language changed
      const newLanguageCode = newSettings.selected_language_code;
      const newLanguageName = newSettings.selected_language_name;
      if (newLanguageCode && newLanguageCode !== this.currentSettings.languageCode) {
        this.logger.info(`Language code changed from ${this.currentSettings.languageCode} to ${newLanguageCode}`);
        // TODO: Add updateLanguage method to OpenAIRealtimeWS or restart connection
        this.currentSettings.languageCode = newLanguageCode;
        this.currentSettings.languageName = newLanguageName || 'English';
        this.agent.updateLanguage(this.currentSettings.languageCode, this.currentSettings.languageName);
      }

      // Check if AI instructions changed
      const newInstructions = newSettings.ai_instructions;
      if (newInstructions !== this.currentSettings.additionalInstructions) {
        this.logger.info('AI instructions changed, updating...');
        this.currentSettings.additionalInstructions = newInstructions || '';
        this.agent.updateAdditionalInstructions(this.currentSettings.additionalInstructions);
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
        this.esp.playAudioFromUrl('https://github.com/esphome/home-assistant-voice-pe/raw/dev/sounds/wake_word_triggered.flac', true);
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
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.logger.info("Settings where changed");
    try {
      const deviceId = (this.getData() as any)?.id || (this as any).id || this.getName();
      const store = this.getStore() as DeviceStore;
      settingsManager.registerDevice(deviceId, store);
    } catch (e) {
      this.logger.error('Failed to update device settings in manager', e);
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