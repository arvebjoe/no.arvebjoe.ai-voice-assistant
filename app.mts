import Homey from 'homey';
import { WebServer } from './src/helpers/webserver.mjs';
import { initAudioFolder } from './src/helpers/file-helper.mjs';
import { initLogDumpFolder } from './src/helpers/log-dump.mjs';
import { DeviceManager } from './src/helpers/device-manager.mjs';
import { ApiHelper } from './src/helpers/api-helper.mjs';
import { GeoHelper } from './src/helpers/geo-helper.mjs';
import { WeatherHelper } from './src/helpers/weather-helper.mjs';
import { AppServices } from './src/helpers/app-services.mjs';
import { settingsManager } from './src/settings/settings-manager.mjs';
import { createLogger, setVerboseLogging } from './src/helpers/logger.mjs';
import { configureRemoteLogFromSettings } from './src/helpers/remote-log.mjs';
import { recordingRegistry } from './src/helpers/recording-registry.mjs';
import { DiscoveryWatcher } from './src/helpers/discovery-watcher.mjs';
import { FlowAssistant } from './src/homey/flow-assistant.mjs';
import homeyLogPkg from 'homey-log'; // requires "esModuleInterop": true in tsconfig
const { Log } = homeyLogPkg;


export default class AiVoiceAssistantApp extends Homey.App implements AppServices {
  // Shared services devices consume via getAppServices() — the AppServices
  // contract keeps this producing side and the consuming side in sync at
  // compile time. Assigned in onInit (hence `!`); devices init after the app.
  public webServer!: WebServer;
  public deviceManager!: DeviceManager;
  public geoHelper!: GeoHelper;
  public weatherHelper!: WeatherHelper;

  private apiHelper: ApiHelper | undefined;
  // Always-on mDNS observer behind the Debug page's "last seen devices" list.
  private discoveryWatcher: DiscoveryWatcher | undefined;
  // Device-less Flow cards (speech URL / ask) — the app without a satellite.
  private flowAssistant: FlowAssistant | undefined;
  private logger = createLogger('APP');
  private homeyLog: any;
  // Teardown bookkeeping (code_review_2 L5): every listener registered on
  // process or a shared service is stored so onUninit can remove it again.
  private processListeners: Array<[event: string, handler: (...args: any[]) => void]> = [];
  private unsubscribeRemoteLog: (() => void) | null = null;


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

    // Remote syslog forwarding: every Logger (including the quieted subsystem
    // ones) mirrors into this transport when it's enabled in settings. The
    // subscription fires once immediately with the current snapshot, then on
    // every settings save.
    // Same subscription drives the verbose-logging switch: with it on, the
    // quieted subsystem loggers (device, ESP, agent) write to the app log, so a
    // user can produce a log that actually shows whether the satellite and the
    // AI engine connected. Off by default — it is noisy by design.
    this.unsubscribeRemoteLog = settingsManager.onGlobals((globals) => {
      configureRemoteLogFromSettings(globals);
      setVerboseLogging(globals.verbose_logging === true);
    });

    // Awaited: the cleanup inside deletes EVERY file in the audio folder, so it
    // must finish before devices come online and start writing reply audio — an
    // unawaited cleanup could delete a just-written file, leaving the satellite
    // a valid URL that 404s (code_review_2 M4).
    await initAudioFolder();
    // Log dumps (Settings → Debug → Dump log) are ephemeral too.
    await initLogDumpFolder();

    // Debug tools (settings page → Debug). Both are passive until used: the
    // recording registry only holds entries while `debug_audio_enabled` is on,
    // and the watcher just reads the discovery results Homey already collects.
    recordingRegistry.init(this.homey);
    this.discoveryWatcher = new DiscoveryWatcher(this.homey);
    this.discoveryWatcher.start();

    this.geoHelper = new GeoHelper(this.homey);
    await this.geoHelper.init();    

    // Initialize WeatherHelper with GeoHelper
    this.weatherHelper = new WeatherHelper(this.geoHelper);
    await this.weatherHelper.init();

    this.webServer = new WebServer(this.homey);
    await this.webServer.init();

    // Initialize ApiHelper first
    this.apiHelper = new ApiHelper(this.homey);
    await this.apiHelper.init();

    // Initialize DeviceManager with ApiHelper
    this.deviceManager = new DeviceManager(this.homey, this.apiHelper);
    await this.deviceManager.init();
    await this.deviceManager.fetchData();

    this.flowAssistant = new FlowAssistant(this.homey, this);
    this.flowAssistant.init();
    this.registerAppFlowCards(this.flowAssistant);

    this.logger.info('AI voice assistant initialized successfully');
  }

  async onUninit() {
    this.logger.info('AI voice assistant is being uninitialized');

    // Symmetric teardown of everything onInit registered (code_review_2 L5).
    for (const [event, handler] of this.processListeners) {
      process.removeListener(event as any, handler);
    }
    this.processListeners = [];

    if (this.unsubscribeRemoteLog) {
      this.unsubscribeRemoteLog();
      this.unsubscribeRemoteLog = null;
    }

    this.discoveryWatcher?.stop();
    this.discoveryWatcher = undefined;

    this.flowAssistant?.dispose();
    this.flowAssistant = undefined;

    this.geoHelper?.dispose();
    // DeviceManager before ApiHelper: its dispose() unregisters through
    // apiHelper.devices, which is gone once the API is destroyed.
    this.deviceManager?.dispose();
    this.apiHelper?.dispose();

    if (this.webServer) {
      await this.webServer.stop();
    }
  }


  /**
   * Set up global error handling that works even when Homey framework intercepts errors
   */
  /**
   * The app-level Flow cards: no device argument, so they work for users with
   * no satellite at all (e.g. AI announcements on a Sonos). Failures are thrown,
   * not swallowed, so the Flow shows the error instead of carrying on with an
   * empty URL.
   */
  private registerAppFlowCards(assistant: FlowAssistant) {
    const voiceAutocomplete = (query: string) => assistant.voiceOptions(query);
    // The optional autocomplete arg arrives as { name, id } or not at all.
    const voiceOf = (args: any): string | undefined => args.voice?.id || undefined;

    const speechCard = this.homey.flow.getActionCard('create-speech-url');
    speechCard.registerArgumentAutocompleteListener('voice', voiceAutocomplete);
    speechCard.registerRunListener(async (args: any) => {
      const { url, duration } = await assistant.speak(String(args.text ?? ''), voiceOf(args));
      return { url, duration };
    });

    this.homey.flow.getActionCard('ask-assistant').registerRunListener(async (args: any) => {
      return { answer: await assistant.ask(String(args.question ?? '')) };
    });

    const askSpeechCard = this.homey.flow.getActionCard('ask-assistant-speech-url');
    askSpeechCard.registerArgumentAutocompleteListener('voice', voiceAutocomplete);
    askSpeechCard.registerRunListener(async (args: any) => {
      const { url, answer, duration } = await assistant.askAndSpeak(String(args.question ?? ''), voiceOf(args));
      return { url, answer, duration };
    });
  }

  private setupGlobalErrorHandling() {

    // Handle uncaught exceptions that might escape Homey's error handling
    this.addProcessListener('uncaughtException', (error) => {
      this.logger.error('Uncaught Exception:', error);
    });

    // Handle unhandled promise rejections
    this.addProcessListener('unhandledRejection', (reason) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.logger.error(`Unhandled Rejection - reason: ${reason}`, error);
    });

    // Handle warnings (optional, for debugging)
    this.addProcessListener('warning', (warning) => {
      this.logger.warn('Process Warning:', warning);
      if (this.homeyLog) {
        this.homeyLog.captureMessage(`Process Warning: ${warning.message}`).catch(() => {
          // Ignore errors in error reporting
        });
      }
    });
  }

  private addProcessListener(event: string, handler: (...args: any[]) => void) {
    process.on(event as any, handler);
    this.processListeners.push([event, handler]);
  }

}
