'use strict';

const Homey = require('homey');
const { createLogger } = require('./logger');
const { WebServer } = require('./webserver');

const log = createLogger('APP');

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    log.info('App initialized successfully');
          
    this.webServer = new WebServer(7709);
    await this.webServer.start();
  }

  async onUninit() {
    log.info('App is being uninitialized');
    
    if (this.webServer) {
      await this.webServer.stop();
      this.webServer = null;
    }
  }


};
