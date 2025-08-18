import Homey from 'homey';
import { createLogger } from '../../src/helpers/logger.mjs';
import { WebServer } from '../../src/helpers/webserver.mjs';
import { EspVoiceClient } from '../../src/voice_assistant/esphome_home_assistant_pe.mjs';
import { DeviceManager } from '../../src/helpers/device-manager.mjs';
//import { transcribe } from '../../src/speech_to_text/openai_stt.mjs';
//import { synthesize } from '../../src/text_to_speech/openai-tts.mjs';
import { ToolMaker } from '../../src/llm/toolMaker.mjs';
import { settingsManager } from '../../src/settings/settings-manager.mjs';
import { OpenAIRealtimeWS, RealtimeOptions } from '../../src/llm/OpenAIRealtimeWS.mjs';
import { pcmToWavBuffer } from '../../src/helpers/wav-util.mjs';
//import { AudioData } from '../../src/helpers/interfaces.mjs';
import { PcmSegmenter } from '../../src/helpers/pcm-segmenter.mjs';
import { AudioData } from '../../src/helpers/interfaces.mjs';

const log = createLogger('ESPHOME');

interface DeviceStore {
  address: string;
  port: number;
  [key: string]: any;
}

export default class EspVoiceDevice extends Homey.Device {
  private esp!: EspVoiceClient;
  private webServer!: WebServer;
  private deviceManager!: DeviceManager;
  private devicePromise!: Promise<void>;
  private toolMaker!: ToolMaker;
  private agent!: OpenAIRealtimeWS;
  private segmenter!: PcmSegmenter;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit(): Promise<void> {
    this.log('EspVoiceDevice is initializing...');
    // TODO:
    this.setUnavailable();

    this.RegisterCapabilities();


    this.webServer = (this.homey as any).app.webServer as InstanceType<typeof WebServer>;
    this.deviceManager = (this.homey as any).app.deviceManager as InstanceType<typeof DeviceManager>;


    // TODO: Combine ApiKey into settings manager!
    const apiKey = this.homey.settings.get('openai_api_key');
    // Register device-specific settings snapshot so utilities without this.homey can reference it
    try {
      const deviceId = (this.getData() as any)?.id || (this as any).id || this.getName();
      const store = this.getStore() as DeviceStore;
      settingsManager.registerDevice(deviceId, store);
    } catch (e) {
      log.warn('Failed to register device settings');
    }

    this.toolMaker = new ToolMaker(this.deviceManager);

    const agentOptions: RealtimeOptions = {
      apiKey: apiKey,
      model: "gpt-4o-realtime-preview", //"gpt-4o-realtime-preview-2025-06-03"
      voice: "alloy",
      sttLanguage: "no", // Hint STT: Norwegian
      outputAudioFormat: "pcm16",
      turnDetection: { type: "server_vad" }, // server VAD on
      enableLocalVAD: true,                  // local VAD also on
      localVADSilenceThreshold: 0.5,
      localVADSilenceMs: 2000,
      verbose: true,
    };

    // TODO: Pass this.homey and this.toolMaker to the agent
    this.agent = new OpenAIRealtimeWS(agentOptions);
    log.info('Agent initialized with tools');


    const store = this.getStore() as DeviceStore;
    // Initialize and start EspVoiceClient

    this.esp = new EspVoiceClient({
      host: store.address,
      apiPort: store.port
    });

    log.info('ESP Voice Client initialized');


    this.segmenter = new PcmSegmenter();
    log.info('PCM Segmenter initialized');

    // TODO: Need to implement emit 'end'
    this.esp.on('end', () => {
      this.setCapabilityValue('onoff', false);
    });

    this.esp.on('start', () => {
      log.info("Voice session started");
      this.setCapabilityValue('onoff', true);
      this.esp.run_start();
      this.esp.stt_vad_start();
      this.esp.begin_mic_capture();
    });

    // Bind the event handler to this class instance
    this.esp.on('chunk', (data: Buffer) => {
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

    this.agent.on('silence', () => {
      log.info("Silence detected by agent, closing microphone");

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
      const wav = pcmToWavBuffer(chunk, {
        sampleRate: 24_000,
        channels: 1,
        bitsPerSample: 16
      });

      const audioData: AudioData = {
        data: wav,
        extension: 'wav'
      }      

      const url = await this.webServer.buildStream(audioData);

      this.esp.playAudioFromUrl(url, false);
    });


    this.agent.on('response.done', () => {
      log.info("Conversation completed");
      this.segmenter.flush();
      this.esp.tts_end();
      this.esp.closeMic();
      this.esp.end_run();
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


    await this.esp.start();
    await this.agent.start();

    this.log('EspVoiceDevice has initialized');
  }





  private RegisterCapabilities() {

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      this.log('Capability onoff changed to:', value);
      // Here you would typically send the command to the device
      // await this.sendCommandToDevice(value);
    });

    this.registerCapabilityListener('volume_set', async (value: number) => {
      this.log('Capability volume_set changed to:', value);
      // Here you would typically send the command to the device
      // await this.setVolumeOnDevice(value);
    });

    this.registerCapabilityListener('volume_mute', async (value: boolean) => {
      this.log('Capability volume_mute changed to:', value);
    });
  }








  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded(): Promise<void> {
    this.log('EspVoiceDevice has been added');
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
    this.log("EspVoiceDevice settings where changed");
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
    this.log('EspVoiceDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted(): Promise<void> {
    this.log('EspVoiceDevice has been deleted');
  }
}
