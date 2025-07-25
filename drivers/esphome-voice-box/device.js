'use strict';

const Homey = require('homey');
const { createLogger } = require('../../logger');
const { EspVoiceClient } = require('../../voice_assistant/esphome_home_assistant_pe');
//const { transcribe } = require('../../speech_to_text/wyoming-whipser');
const { transcribe } = require('../../speech_to_text/openai-stt');
const { chat } = require('../../llm/openai-chat.js');
const { synthesize } = require('../../text_to_speech/wyoming-piper'); // Not used in this file, but available for TTS


const log = createLogger('DEV.ESP');

module.exports = class MyDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');

    this.registerCapabilityListener('onoff', async (value) => {
      this.log('Capability onoff changed to:', value);
      // Here you would typically send the command to the device
      // await this.sendCommandToDevice(value);
    });

    this.registerCapabilityListener('volume_set', async (value) => {
      this.log('Capability volume_set changed to:', value);
      // Here you would typically send the command to the device
      // await this.setVolumeOnDevice(value);
    });
    
    this.registerCapabilityListener('volume_mute', async (value) => {
      this.log('Capability volume_mute changed to:', value);
      // Here you would typically send the command to the device
      // await this.muteVolumeOnDevice(value);
    }); 

    var store = this.getStore();
    log.info('Device store:', "INIT", store);

    // Initialize and start EspVoiceClient
    this.espVoiceClient = new EspVoiceClient({
      host: store.address,
      apiPort: store.port,
      webServer: this.homey.app.webServer
    });
    
    await this.espVoiceClient.start();
    log.info('ESP Voice Client initialized and connected');

    this.espVoiceClient.on('begin', () => {
      this.setCapabilityValue('onoff', true);
    });

    this.espVoiceClient.on('end', () => {
      this.setCapabilityValue('onoff', false);
    });

    // Bind the event handler to this class instance
    this.espVoiceClient.on('audio', this._onAudio.bind(this));

  }


  async _onAudio(pcmBuf) {

    const apiKey = this.homey.settings.get('openai_api_key');
    
    //const text = await transcribe('192.168.0.32', 10300, pcmBuf, { language: process.env.LANGUAGE || 'no' });
    const text = await transcribe( pcmBuf, apiKey, { language: process.env.LANGUAGE || 'no' });
    log.info(`Transcribed text: ${text}`, "APP");
    this.espVoiceClient.sttEnd(text);


    this.espVoiceClient.intentStart();
    var response = await chat(text, apiKey);
    log.info(`Chat response: ${response}`, "APP");  
    this.espVoiceClient.intentEnd(response);

    const pcmReply = await synthesize('192.168.0.32', 10200, response);

    log.info('Received audio buffer of size:', "APP", pcmReply.length);
    
    var url = this.homey.app.webServer.buildStream(pcmReply);
    log.info('Audio stream URL:', "APP", url);

    this.espVoiceClient.playAudioFromUrl(url);
    log.info('Playing audio from URL:', "APP", url);


  } 






  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
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
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('MyDevice settings where changed');



    //this.setCapabilityValue('onoff', true);
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('MyDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('MyDevice has been deleted');
  }

};
