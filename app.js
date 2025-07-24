'use strict';

const Homey = require('homey');
const { createLogger } = require('./logger');
const { WebServer } = require('./webserver');
const { EspVoiceClient } = require('./voice_assistant/esphome_home_assistant_pe');
const { transcribe } = require('./speech_to_text/wyoming-whipser');
const log = createLogger('APP');

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    log.info('App initialized successfully');
          
    // Initialize and start WebServer
    this.webServer = new WebServer(7709);
    await this.webServer.start();
    
    // Initialize and start EspVoiceClient
    this.espVoiceClient = new EspVoiceClient({
      host: '192.168.0.50',
      apiPort: 6053,
      webServer: this.webServer
    });
    
    await this.espVoiceClient.start();
    log.info('ESP Voice Client initialized and connected');

    // Bind the event handler to this class instance
    this.espVoiceClient.on('audio', this._onAudio.bind(this));
  }

  // Use an underscore prefix for the handler method (common convention)
  async _onAudio(pcmBuf) {

    const text = await transcribe('192.168.0.32', 10300, pcmBuf, { language: process.env.LANGUAGE || 'no' });
    log.info(`Transcribed text: ${text}`, "APP");
    this.espVoiceClient.sttEnd(text);

    this.espVoiceClient.intentStart();
    // GPT Goes here
    this.espVoiceClient.intentEnd("rosin rosin");

    

    log.info('Received audio buffer of size:', "APP", pcmBuf.length);
    
    var url = this.webServer.buildStream({
      data: pcmBuf,
      rate: 16000  // Assuming 16kHz sample rate
    });
    log.info('Audio stream URL:', "APP", url);

    this.espVoiceClient.playAudioFromUrl(url);
    log.info('Playing audio from URL:', "APP", url);
    //this.espVoiceClient.endRun();

  } 

  async onUninit() {
    log.info('App is being uninitialized');
    
    // Clean up ESP Voice Client
    if (this.espVoiceClient) {
      this.espVoiceClient.stop();
      this.espVoiceClient = null;
      log.info('ESP Voice Client stopped');
    }
    
    // Clean up WebServer
    if (this.webServer) {
      await this.webServer.stop();
      this.webServer = null;
      log.info('WebServer stopped');
    }
  }


};
