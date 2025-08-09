import Homey from 'homey';
import { createLogger } from '../../src/helpers/logger.mjs';
import { WebServer } from '../../src/helpers/webserver.mjs';
import { EspVoiceClient } from '../../src/voice_assistant/esphome_home_assistant_pe.mjs';
import { DeviceManager } from '../../src/helpers/device-manager.mjs';
import { transcribe } from '../../src/speech_to_text/openai_stt.mjs';
import { synthesize } from '../../src/text_to_speech/openai-tts.mjs';
import { SmartAgent } from '../../src/llm/smartAgent.mjs';
import { ToolMaker } from '../../src/llm/toolMaker.mjs';

const log = createLogger('ESPHOME');

interface DeviceStore {
  address: string;
  port: number;
  [key: string]: any;
}

export default class MyDevice extends Homey.Device {
  private espVoiceClient!: EspVoiceClient;
  private webServer!: WebServer;
  private deviceManager!: DeviceManager;
  private devicePromise!: Promise<void>;
  private toolMaker!: ToolMaker;
  private smartAgent!: SmartAgent;  

  /**
   * onInit is called when the device is initialized.
   */
  async onInit(): Promise<void> {
    this.log('MyDevice is initializing...');
    // TODO:
    this.setUnavailable();

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
      // Here you would typically send the command to the device
      // await this.muteVolumeOnDevice(value);
    });


    this.webServer = (this.homey as any).app.webServer as InstanceType<typeof WebServer>;
    this.deviceManager = (this.homey as any).app.deviceManager as InstanceType<typeof DeviceManager>;

    const apiKey = this.homey.settings.get('openai_api_key');
    
    this.toolMaker = new ToolMaker(this.deviceManager);
    this.smartAgent = new SmartAgent(this.toolMaker, apiKey);
    log.info('Agent initialized with tools');        

    const store = this.getStore() as DeviceStore;
    log.info('Device store:', 'INIT', store);

    // Initialize and start EspVoiceClient
    this.espVoiceClient = new EspVoiceClient({
      host: store.address,
      apiPort: store.port,
      webServer: this.webServer
    });

    await this.espVoiceClient.start();
    log.info('ESP Voice Client initialized and connected');  
    
    
    this.espVoiceClient.on('begin', () => {
      this.devicePromise = this.deviceManager.fetchData();
      this.setCapabilityValue('onoff', true);
    });

    this.espVoiceClient.on('end', () => {
      this.setCapabilityValue('onoff', false);
    });

    // Bind the event handler to this class instance
    this.espVoiceClient.on('audio', this._onAudio.bind(this));    
    
    this.espVoiceClient.on('connected', async () => {
      log.info('ESP Voice Client connected')  ;     
      this.setAvailable();
    });

    this.espVoiceClient.on('disconnected', () => {
      log.info('ESP Voice Client disconnected');
      this.setUnavailable('Disconnected from ESP Voice Client');
    });

    this.log('MyDevice has initialized');
  }


  async _onAudio(pcmBuf: Buffer) {


    const apiKey = this.homey.settings.get('openai_api_key');

    //log.info('Received audio data', "OnAudio", { bytes: pcmBuf.length });
    //this.espVoiceClient.sttStart();
    //const text = await transcribe('192.168.0.32', 10300, pcmBuf, { language: 'no' });
    const text = await transcribe( pcmBuf, apiKey, { language: 'no', verbose: false }, this.homey);
    log.info(`USER: ${text}`);
    this.espVoiceClient.sttEnd(text);


    this.espVoiceClient.intentStart();

    await this.devicePromise;
    const speech = await this.smartAgent.run(text);
    log.info(`AGENT: ${speech}`);

    this.espVoiceClient.intentEnd(speech);

    const flacBuffer = await synthesize( speech, apiKey, {  });
    //const pcmReply = await synthesize('192.168.0.32', 10200, speech);
    //log.info('Received audio', "OnAudio", pcmReply );
    /*
        if( audioData.extension === 'audio/pcm') {
              rate: 16_000,
            audioData.data = pcmToWav(audioData.data, audioData.rate);
        }
    */
    const audioData ={
      data: flacBuffer,
      rate: 16_000,
      extension: 'flac'
    };

    var url = await this.webServer.buildStream(audioData);
    //log.info('Audio stream URL:',"OnAudio", url);
    
    this.espVoiceClient.playAudioFromUrl(url);
    //log.info('Playing audio from URL', "OnAudio", url);

    this.espVoiceClient.endRun();
    log.info('----------------------');

  } 




  
  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded(): Promise<void> {
    this.log('MyDevice has been added');
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
    this.log("MyDevice settings where changed");
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string): Promise<void> {
    this.log('MyDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted(): Promise<void> {
    this.log('MyDevice has been deleted');
  }
}
