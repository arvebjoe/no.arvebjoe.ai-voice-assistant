import Homey from 'homey';
import { createLogger } from './src/helpers/logger.mjs';
import { WebServer } from './src/helpers/webserver.mjs';
import { DeviceManager } from './src/helpers/device-manager.mjs';

const log = createLogger('APP');

export default class AiVoiceAssistantApp extends Homey.App {
  // Define class properties
  private webServer: WebServer | undefined;
  private deviceManager: DeviceManager | undefined;

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    log.info('AI voice assistant initializing...');

    process.env.OPENAI_API_KEY = this.homey.settings.get('openai_api_key');

    this.webServer = new WebServer(this.homey);
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
