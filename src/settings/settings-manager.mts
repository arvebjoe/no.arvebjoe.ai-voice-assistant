import { createLogger } from '../helpers/logger.mjs';

export type GlobalSettings = Record<string, any>;
//export type DeviceSettings = Record<string, any>;

interface Subscriber<T> { (value: T): void; }

/**
 * SettingsManager provides:
 *  - Global app settings (shared across all devices)
 *  - Per-device settings (isolated by deviceId)
 *  - A lightweight pub/sub for changes
 *  - Convenience helpers to build a merged (read-only) context
 *
 *  Usage lifecycle:
 *    App.onInit -> SettingsManager.init(homey)
 *    Device.onInit -> SettingsManager.registerDevice(deviceId, device.getStore())
 *    Device.onSettings -> SettingsManager.registerDevice(deviceId, device.getStore())
 *    Anywhere (no this.homey) -> import { settingsManager } and call getGlobal / getDeviceContext
 */
export class SettingsManager {
  private static instance: SettingsManager | null = null;
  private homey: any | null = null;
  private globals: GlobalSettings = {};
  //private devices: Map<string, DeviceSettings> = new Map();
  private globalSubs: Set<Subscriber<GlobalSettings>> = new Set();
  //private deviceSubs: Map<string, Set<Subscriber<DeviceSettings>>> = new Map();
  private logger = createLogger('Settings_Manager');

  private constructor() {
  }

  static getInstance(): SettingsManager {

    if (!this.instance) this.instance = new SettingsManager();
    return this.instance;
  }

  /** Get available OpenAI realtime voices */
  static getAvailableVoices(): { value: string; name: string }[] {
    return [
      { value: 'alloy', name: 'Alloy' },
      { value: 'ash', name: 'Ash' },
      { value: 'ballad', name: 'Ballad' },
      { value: 'coral', name: 'Coral' },
      { value: 'echo', name: 'Echo' },
      { value: 'sage', name: 'Sage' },
      { value: 'shimmer', name: 'Shimmer' },
      { value: 'verse', name: 'Verse' },
      { value: 'cedar', name: 'Cedar' },
      { value: 'marin', name: 'Marin' }
    ];
  }

  /** Get BCP-47 locale from language code */
  static getLocaleFromLanguageCode(languageCode: string): string {
    const localeMap: Record<string, string> = {
      'en': 'en-US',
      'nl': 'nl-NL',
      'de': 'de-DE',
      'fr': 'fr-FR',
      'it': 'it-IT',
      'sv': 'sv-SE',
      'no': 'nb-NO',
      'es': 'es-ES',
      'da': 'da-DK',
      'ru': 'ru-RU',
      'pl': 'pl-PL',
      'ko': 'ko-KR'
    };
    
    return localeMap[languageCode] || 'en-US';
  }

  /** Get current locale based on selected language */
  getCurrentLocale(): string {
    const languageCode = this.getGlobal<string>('selected_language_code', 'en');
    return SettingsManager.getLocaleFromLanguageCode(languageCode);
  }

  /** Reset the settings manager (for testing) */
  reset(): void {
    this.homey = null;
    this.globals = {};
    this.globalSubs.clear();
  }

  /** Initialize with Homey reference once (idempotent). */
  init(homey: any) {

    if (this.homey) {
      return; // already initialized
    }

    this.logger.info('Initializing');

    this.homey = homey;


    // Prime global settings snapshot
    try {
      this.refreshGlobals();
    } catch (e) {
      this.logger.error('Failed to read initial global settings', e);      
    }

    // Listen for updates from the Homey settings store
    if (homey?.settings?.on) {
      homey.settings.on('set', (key: string) => {
        const value = homey.settings.get(key);
        this.globals[key] = value;
        this.emitGlobals();
        this.logger.info(`Global setting updated: ${key}`);
      });
    }
  }

  /** Refresh all globals from Homey. */
  refreshGlobals() {
    if (!this.homey?.settings) {
      return;
    }
    
    // Homey settings API does not expose list directly; define keys we care about explicitly.
    // Extend this list as needed.
    const knownKeys = ['openai_api_key', 'selected_language_code', 'selected_language_name', 'selected_voice', 'ai_instructions'];

    for (const k of knownKeys) {
      this.globals[k] = this.homey.settings.get(k);
    }

  }


  // Get a single global setting value. 
  getGlobal<T = any>(key: string, fallback?: T): T {
    return (this.globals[key] ?? fallback) as T;
  }

  /*
  // Register or update a device's settings snapshot. 
  registerDevice(deviceId: string, store: DeviceSettings) {
    if (!deviceId) return;
    this.devices.set(deviceId, { ...store });
    this.emitDevice(deviceId);
    this.logger.info(`Registered/updated device settings, deviceId: '${deviceId}'`, undefined, store);
  }

// Merge globals + device-specific (device overrides). 
  getDeviceContext(deviceId: string): Readonly<GlobalSettings & DeviceSettings> {
    const device = this.devices.get(deviceId) || {};
    return Object.freeze({ ...this.globals, ...device });
  }

  // Raw device settings (unmerged). 
  getDeviceSettings(deviceId: string): Readonly<DeviceSettings> {
    return Object.freeze({ ...(this.devices.get(deviceId) || {}) });
  }
*/
  /** Subscribe to global settings changes. */
  onGlobals(sub: Subscriber<GlobalSettings>): () => void {
    this.globalSubs.add(sub);
    sub({ ...this.globals }); // initial
    return () => this.globalSubs.delete(sub);
  }

  /*
  // Subscribe to device settings changes. 
  onDevice(deviceId: string, sub: Subscriber<DeviceSettings>): () => void {
    if (!this.deviceSubs.has(deviceId)) this.deviceSubs.set(deviceId, new Set());
    const set = this.deviceSubs.get(deviceId)!;
    set.add(sub);
    sub({ ...(this.devices.get(deviceId) || {}) }); // initial
    return () => set.delete(sub);
  }
*/
  private emitGlobals() {
    const snapshot = { ...this.globals };
    for (const sub of this.globalSubs) sub(snapshot);
  }

  /*
  private emitDevice(deviceId: string) {
    const snapshot = { ...(this.devices.get(deviceId) || {}) };
    const set = this.deviceSubs.get(deviceId);
    if (!set) return;
    for (const sub of set) sub(snapshot);
  }*/
}

// Export a convenient singleton instance
export const settingsManager = SettingsManager.getInstance();
