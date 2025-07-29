'use strict';

const Homey = require('homey');
const { createLogger } = require('./src/helpers/logger');
const { WebServer } = require('./src/helpers/webserver');
const { DeviceManager } = require('./src/helpers/device-manager');

const log = createLogger('APP');

module.exports = class AiVoiceAssistantApp extends Homey.App {


  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    log.info('AI voice assistant initialized successfully');

    // Initialize and start WebServer
    this.webServer = new WebServer(7709);
    await this.webServer.start();

    // Initialize DeviceManager
    this.deviceManager = new DeviceManager(this.homey);
    await this.deviceManager.init();

    //const temp = await this.deviceManager.FetchAllDevices();
    //log.info('Fetched devices:', JSON.stringify(temp, null, 2));
    
  }

  


  async onUninit() {
    log.info('AI voice assistant is being uninitialized');
    
    // Clean up WebServer
    if (this.webServer) {
      await this.webServer.stop();
      this.webServer = null;
      log.info('WebServer stopped');
    }
  }


};
