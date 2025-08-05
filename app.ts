'use strict';

import Homey from 'homey';
import { createLogger } from './src/helpers/logger';
import { WebServer, IWebServer } from './src/helpers/webserver';
const { DeviceManager } = require('./src/helpers/device-manager');

const log = createLogger('APP');

module.exports = class MyApp extends Homey.App {
  // Define class properties
  private webServer: IWebServer | undefined; 
  private deviceManager: any; 

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    log.info('AI voice assistant initialized successfully');

    this.webServer = new WebServer(7709, this.homey);
    await this.webServer.start();

    // Initialize DeviceManager
    this.deviceManager = new DeviceManager(this.homey);
    await this.deviceManager.init();
  }

  async onUninit() {
    log.info('AI voice assistant is being uninitialized');
    
    // Clean up WebServer
    if (this.webServer) {
      await this.webServer.stop();      
    }
  }  

}
