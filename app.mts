import Homey from 'homey';

import { WebServer } from './src/helpers/webserver.mjs';
import { DeviceManager } from './src/helpers/device-manager.mjs';
import { settingsManager } from './src/settings/settings-manager.mjs';
import { createLogger } from './src/helpers/logger.mjs';


export default class AiVoiceAssistantApp extends Homey.App {
  // Define class properties
  private webServer: WebServer | undefined;
  private deviceManager: DeviceManager | undefined;
  private logger = createLogger('APP');

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.logger.setHomey(this.homey);

    this.logger.info('AI voice assistant initializing...');

    // Centralized settings manager (makes global settings accessible without this.homey)
    settingsManager.init(this.homey);

    this.webServer = new WebServer(this.homey);
    await this.webServer.start();

    // Initialize DeviceManager
    this.deviceManager = new DeviceManager(this.homey);
    await this.deviceManager.init();

    this.log('AI voice assistant initialized successfully');

  }

  async onUninit() {
    this.logger.info('AI voice assistant is being uninitialized');

    // Clean up WebServer
    if (this.webServer) {
      await this.webServer.stop();
    }
  }

}
