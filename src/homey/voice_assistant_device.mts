import Homey from 'homey';
import { createLogger } from '../helpers/logger.mjs';
import { WebServer } from '../helpers/webserver.mjs';
import { EspVoiceClient } from '../voice_assistant/esphome_home_assistant_pe.mjs';
import { DeviceManager } from '../helpers/device-manager.mjs';
//import { transcribe } from '../../src/speech_to_text/openai_stt.mjs';
//import { synthesize } from '../../src/text_to_speech/openai-tts.mjs';
//import { ToolMaker } from '../../src/llm/toolMaker.mjs';
import { settingsManager } from '../settings/settings-manager.mjs';
import { OpenAIRealtimeWS, RealtimeOptions } from '../llm/OpenAIRealtimeWS.mjs';
import { pcmToWavBuffer, pcmToFlacBuffer } from '../helpers/audio-encoders.mjs';
//import { AudioData } from '../../src/helpers/interfaces.mjs';
import { PcmSegmenter } from '../helpers/pcm-segmenter.mjs';
import { AudioData } from '../helpers/interfaces.mjs';
import { ToolManager } from '../llm/ToolManager.mjs';
import { DeviceStore }  from '../../src/helpers/interfaces.mjs';

const log = createLogger('VA_DEVICE', false);

export default abstract class VoiceAssistantDevice extends Homey.Device {
  private esp!: EspVoiceClient;
  private webServer!: WebServer;
  private deviceManager!: DeviceManager;
  private devicePromise!: Promise<void>;
  private toolManager!: ToolManager;
  private agent!: OpenAIRealtimeWS;
  private segmenter!: PcmSegmenter;
  private settingsUnsubscribe?: () => void; // To clean up the subscription
  private currentSettings: any = {}; // Store current settings to detect changes

  /**
   * onInit is called when the device is initialized.
   */
  async onInit(): Promise<void> {
    log.info('EspVoiceDevice is initializing...');
    // TODO:
    this.setUnavailable();

    this.RegisterCapabilities();


    this.webServer = (this.homey as any).app.webServer as InstanceType<typeof WebServer>;
    this.deviceManager = (this.homey as any).app.deviceManager as InstanceType<typeof DeviceManager>;



    // Register device-specific settings snapshot so utilities without this.homey can reference it
    try {
      const deviceId = (this.getData() as any)?.id || (this as any).id || this.getName();
      const store = this.getStore() as DeviceStore;
      settingsManager.registerDevice(deviceId, store);
    } catch (e) {
      log.warn('Failed to register device settings');
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
    this.agent = new OpenAIRealtimeWS(this.toolManager, agentOptions);
    log.info('Agent initialized with tools');

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
    // Initialize and start EspVoiceClient

    this.esp = new EspVoiceClient({
      host: store.address,
      apiPort: store.port
    });

    log.info('ESP Voice Client initialized');


    this.segmenter = new PcmSegmenter();
    log.info('PCM Segmenter initialized');


    this.esp.on('start', async () => {
      log.info("Voice session started");
      this.devicePromise = this.deviceManager.fetchData();
      this.setCapabilityValue('onoff', true);
      this.esp.run_start();
      this.esp.stt_vad_start();
      this.esp.begin_mic_capture();
    });

    // Bind the event handler to this class instance
    this.esp.on('chunk', (data: Buffer) => {
      log.info(`New RX chunk: ${data.length} bytes`);
      // TODO: Move upsample16kTo24k to wav-helper.js
      const pcm24 = this.agent.upsample16kTo24k(data);
      // TODO: Have a test buffer 
      //audioBuffer.push(pcm24);
      this.agent.sendAudioChunk(pcm24);
    });

    this.agent.on("open", () => {
      log.info('Agent connection opened');
    });

    this.esp.on('connected', async () => {
      log.info('ESP Voice Client connected');
      this.setAvailable();
    });

    this.agent.on('silence', (source: string) => {
      log.info(`Silence detected by agent (${source}), closing microphone.`);

      this.esp.closeMic();

      // Save collected audio buffer to WAV file
      //save_mic_buffer(audioBuffer);
      // Reset the buffer for next recording
      //audioBuffer = [];

      this.esp.stt_vad_end('');
      this.esp.tts_start();
    });

    this.agent.on('audio.delta', (audioBuffer: Buffer) => {
      this.segmenter.feed(audioBuffer);
    });

    this.segmenter.on('chunk', async (chunk: Buffer) => {
      log.info(`New TX chunk: ${chunk.length} bytes`);

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
      log.info(`${d.name}`, 'Tool calling', d.args);
      await this.devicePromise;

    });

    this.agent.on('response.done', () => {
      log.info("Conversation completed");
      this.segmenter.flush();
      this.esp.tts_end();
      this.esp.closeMic();
      this.esp.run_end();
      this.setCapabilityValue('onoff', false);
    });

    this.agent.on('error', (error: Error) => {
      log.error("Realtime agent error:", error);
    });

    this.esp.on('disconnected', () => {
      log.info('ESP Voice Client disconnected');
      this.setUnavailable('Disconnected from ESP Voice Client');
    });

    this.agent.on('open', () => {
      log.info("Realtime agent connection opened");
    });
    
    // Listen for volume changes from the device
    this.esp.on('volume', (level: number) => {
      log.info(`Received volume update: ${Math.round(level * 100)}%`);
      this.setCapabilityValue('volume_set', level).catch(err => {
        log.warn('Failed to update volume_set capability', err);
      });
    });
    
    // Listen for mute state changes from the device
    this.esp.on('mute', (isMuted: boolean) => {
      log.info(`Received mute state update: ${isMuted ? 'muted' : 'unmuted'}`);
      this.setCapabilityValue('volume_mute', isMuted).catch(err => {
        log.warn('Failed to update volume_mute capability', err);
      });
    });


    await this.esp.start();
    await this.agent.start();

    log.info('EspVoiceDevice has initialized');
  }

  /**
   * Handle settings changes and update agent accordingly
   */
  private async handleSettingsChange(newSettings: any): Promise<void> {
    log.info('Settings changed, updating agent...', undefined, newSettings);

    try {
      // Check if voice changed
      const newVoice = newSettings.selected_voice;
      if (newVoice && newVoice !== this.currentSettings.voice) {
        log.info(`Voice changed from ${this.currentSettings.voice} to ${newVoice}`);
        this.currentSettings.voice = newVoice;
        this.agent.updateVoiceWithReconnect(this.currentSettings.voice);
      }

      // Check if language changed
      const newLanguageCode = newSettings.selected_language_code;
      const newLanguageName = newSettings.selected_language_name;
      if (newLanguageCode && newLanguageCode !== this.currentSettings.languageCode) {
        log.info(`Language code changed from ${this.currentSettings.languageCode} to ${newLanguageCode}`);
        log.info(`Language name changed from ${this.currentSettings.languageName} to ${newLanguageName}`);
        // TODO: Add updateLanguage method to OpenAIRealtimeWS or restart connection
        this.currentSettings.languageCode = newLanguageCode;
        this.currentSettings.languageName = newLanguageName || 'English';
        this.agent.updateLanguage(this.currentSettings.languageCode, this.currentSettings.languageName);
      }

      // Check if AI instructions changed
      const newInstructions = newSettings.ai_instructions;
      if (newInstructions !== this.currentSettings.additionalInstructions) {
        log.info('AI instructions changed, updating...');
        this.currentSettings.additionalInstructions = newInstructions || '';
        this.agent.updateAdditionalInstructions(this.currentSettings.additionalInstructions);
      }

    } catch (error) {
      log.error('Failed to update agent settings:', error);
    }
  }





  private RegisterCapabilities() {

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      log.info(`Capability onoff changed to: ${value}`);
    
        
        // Start listening when turned on
        if (this.esp && typeof this.esp.startListening === 'function') {
          log.info('Triggering voice assistant to start listening');
          this.esp.startListening();
        } else {
          log.warn('ESP client not initialized or startListening method not available');
        }

    });

    this.registerCapabilityListener('volume_set', async (value: number) => {
      log.info(`Capability volume_set changed to: ${value}`);
      // Send the volume command to the ESPHome device
      if (this.esp && this.esp.setVolume) {
        this.esp.setVolume(value);
      } else {
        log.warn('ESP client not initialized or setVolume method not available');
      }
    });

    this.registerCapabilityListener('volume_mute', async (value: boolean) => {
      log.info(`Capability volume_mute changed to: ${value}`);
      // Send the mute command to the ESPHome device
      if (this.esp && this.esp.setMute) {
        this.esp.setMute(value);
      } else {
        log.warn('ESP client not initialized or setMute method not available');
      }
    });
  }



  // Called for every discovery result; return truthy if it’s this device
  onDiscoveryResult(r: any) {
    return r.id === this.getData().id;
  }

  // First time we see the device (after onDiscoveryResult==true)
  async onDiscoveryAvailable(r: any) {
    await this.setStoreValue('address', r.address).catch(this.error);
    await this.setStoreValue('port', r.port ?? 6053).catch(this.error);

    // TODO: connect to your device here (native API, websocket, etc.)
    // e.g. this.api = new MyEspHomeClient({ host: r.address, port: r.port ?? 6053 });
    // await this.api.connect(); // throw to mark device unavailable
  }

  // IP changed (e.g., DHCP lease renewal)
  onDiscoveryAddressChanged(r: any) {
    this.setStoreValue('address', r.address).catch(this.error);
    // this.api?.reconnectTo(r.address);
  }

  // Seen again after being offline, try to reconnect
  onDiscoveryLastSeenChanged(_r: any) {
    // this.api?.reconnect().catch(this.error);
  }




  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded(): Promise<void> {
    log.info('EspVoiceDevice has been added');
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
    log.info("EspVoiceDevice settings where changed");
    try {
      const deviceId = (this.getData() as any)?.id || (this as any).id || this.getName();
      const store = this.getStore() as DeviceStore;
      settingsManager.registerDevice(deviceId, store);
    } catch (e) {
      log.warn('Failed to update device settings in manager');
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string): Promise<void> {
    log.info('EspVoiceDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted(): Promise<void> {
    log.info('EspVoiceDevice has been deleted');

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
          log.warn('Error while disconnecting ESP client:', err);
        });
      }
    } catch (err) {
      log.warn('Failed to properly disconnect ESP client:', err);
    } finally {
      this.esp = null!;
    }

    // Safely close agent
    try {
      if (this.agent) {
        this.agent.close();
      }
    } catch (err) {
      log.warn('Failed to close agent:', err);
    } finally {
      this.agent = null!;
    }

    // Cleanup other resources
    this.segmenter = null!;
    this.toolManager = null!;
  }

}