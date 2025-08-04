'use strict';

import Homey from 'homey';
import { createLogger } from './src/helpers/logger';
const { WebServer } = require('./src/helpers/webserver');

const log = createLogger('APP');

module.exports = class MyApp extends Homey.App {
  // Define class properties
  private webServer: any; // Type as 'any' for compatibility

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    log.info('AI voice assistant initialized successfully');

    this.webServer = new WebServer(7709, this.homey);
    await this.webServer.start();
  }

  async onUninit() {
    log.info('AI voice assistant is being uninitialized');
    
    // Clean up WebServer
    if (this.webServer) {
      await this.webServer.stop();
      this.webServer = null;
    }
  }  

}
