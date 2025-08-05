'use strict';

import Homey from 'homey';
import { createLogger } from './src/helpers/logger';
import { WebServer, IWebServer } from './src/helpers/webserver';
import { DeviceManager, IDeviceManager } from './src/helpers/device-manager';

const log = createLogger('APP');

module.exports = class MyApp extends Homey.App {
  // Define class properties
  private webServer: IWebServer | undefined;
  private deviceManager: IDeviceManager | undefined;

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    log.info('AI voice assistant initializing...');

    this.webServer = new WebServer(7709, this.homey);
    await this.webServer.start();

    // Initialize DeviceManager
    this.deviceManager = new DeviceManager(this.homey);
    await this.deviceManager.init();
    log.info('AI voice assistant initialized successfully');

  }

  async onUninit() {
    log.info('AI voice assistant is being uninitialized');

    // Clean up WebServer
    if (this.webServer) {
      await this.webServer.stop();
    }
  }

}
