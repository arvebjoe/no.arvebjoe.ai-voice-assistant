import Homey from 'homey';
import { WebServer } from './src/helpers/webserver.mjs';
import { initAudioFolder } from './src/helpers/file-helper.mjs';
import { DeviceManager } from './src/helpers/device-manager.mjs';
import { ApiHelper } from './src/helpers/api-helper.mjs';
import { GeoHelper } from './src/helpers/geo-helper.mjs';
import { WeatherHelper } from './src/helpers/weather-helper.mjs';
import { JobManager } from './src/helpers/job-manager.mjs';
import { settingsManager } from './src/settings/settings-manager.mjs';
import { createLogger } from './src/helpers/logger.mjs';
import homeyLogPkg from 'homey-log'; // requires "esModuleInterop": true in tsconfig
const { Log } = homeyLogPkg;


export default class AiVoiceAssistantApp extends Homey.App {
  // Define class properties
  private webServer: WebServer | undefined;
  private apiHelper: ApiHelper | undefined;
  private deviceManager: DeviceManager | undefined;
  private geoHelper: GeoHelper | undefined;
  private weatherHelper: WeatherHelper | undefined;
  private jobManager: JobManager | undefined;
  private logger = createLogger('APP');
  private homeyLog: any;


  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.homeyLog = new Log({ homey: this.homey });

    // Set up explicit global error handling that works even when Homey intercepts errors
    this.setupGlobalErrorHandling();

    this.logger.setHomey(this.homey, this.homeyLog);
    this.logger.info('AI voice assistant initializing');

    // Centralized settings manager (makes global settings accessible without this.homey)
    settingsManager.init(this.homey);

    initAudioFolder();

    this.geoHelper = new GeoHelper(this.homey);
    await this.geoHelper.init();    

    // Initialize WeatherHelper with GeoHelper
    this.weatherHelper = new WeatherHelper(this.geoHelper);
    await this.weatherHelper.init();

    // Initialize JobManager with GeoHelper
    this.jobManager = new JobManager(this.geoHelper);

    this.webServer = new WebServer(this.homey);
    await this.webServer.init();

    // Initialize ApiHelper first
    this.apiHelper = new ApiHelper(this.homey);
    await this.apiHelper.init();

    // Initialize DeviceManager with ApiHelper
    this.deviceManager = new DeviceManager(this.homey, this.apiHelper);
    await this.deviceManager.init();
    await this.deviceManager.fetchData();

    this.logger.info('AI voice assistant initialized successfully');
  }

  async onUninit() {
    this.logger.info('AI voice assistant is being uninitialized');

    // Clean up WebServer
    if (this.webServer) {
      await this.webServer.stop();
    }
  }


  /**
   * Set up global error handling that works even when Homey framework intercepts errors
   */
  private setupGlobalErrorHandling() {

    // Handle uncaught exceptions that might escape Homey's error handling
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught Exception:', error);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.logger.error(`Unhandled Rejection - reason: ${reason}`, error);
    });

    // Handle warnings (optional, for debugging)
    process.on('warning', (warning) => {
      this.logger.warn('Process Warning:', warning);
      if (this.homeyLog) {
        this.homeyLog.captureMessage(`Process Warning: ${warning.message}`).catch(() => {
          // Ignore errors in error reporting
        });
      }
    });
  }

}
