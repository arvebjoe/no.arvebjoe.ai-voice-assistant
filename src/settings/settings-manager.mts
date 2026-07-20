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
  private logger = createLogger('Settings_Manager', true);
  // A settings-page Save writes ~20 keys back-to-back and Homey fires one 'set'
  // event per key. Emitting a snapshot per key made every subscriber (device
  // rebuild/restart, local pipeline health re-probe) run ~20 times concurrently
  // (code_review_2 H1). Coalesce the burst into one emit instead. 1.5 s because a
  // real mobile-webview save burst has >300 ms gaps between keys (observed live
  // 2026-07-19: one Save produced several staggered rebuilds at 300 ms).
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly EMIT_DEBOUNCE_MS = 1_500;

  private constructor() {
  }

  static getInstance(): SettingsManager {

    if (!this.instance) this.instance = new SettingsManager();
    return this.instance;
  }

  // Available voices now live with each provider (IVoiceProvider.getAvailableVoices,
  // surfaced per-provider via the factory's getVoicesForProvider) so the settings
  // UI can switch the list when the provider changes.

  /** Get available voice/LLM providers (for the settings UI). */
  static getAvailableProviders(): { value: string; name: string }[] {
    return [
      { value: 'openai-realtime', name: 'OpenAI Realtime' },
      { value: 'gemini-realtime', name: 'Google Gemini Live' },
      { value: 'mistral-realtime', name: 'Mistral (Voxtral)' },
      { value: 'local', name: 'Local (Whisper + Ollama + Piper)' }
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
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
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

    // Listen for updates from the Homey settings store. The snapshot is updated
    // synchronously (getGlobal readers always see fresh values); only the
    // subscriber notification is debounced so a multi-key save lands as one emit.
    if (homey?.settings?.on) {
      homey.settings.on('set', (key: string) => {
        const value = homey.settings.get(key);
        this.globals[key] = value;
        this.logger.info(`Global setting updated: ${key}`);
        this.scheduleEmitGlobals();
      });
    }
  }

  /** Test hook: fire a pending debounced emit synchronously (no-op when idle). */
  flushGlobalsEmit(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.emitGlobals();
    }
  }

  private scheduleEmitGlobals() {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
    }
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitGlobals();
    }, SettingsManager.EMIT_DEBOUNCE_MS);
  }

  /** Refresh all globals from Homey. */
  refreshGlobals() {
    if (!this.homey?.settings) {
      return;
    }
    
    // Homey settings API does not expose list directly; define keys we care about explicitly.
    // Extend this list as needed.
    const knownKeys = ['openai_api_key', 'openai_model', 'gemini_api_key', 'openweather_api_key', 'selected_language_code', 'selected_language_name', 'selected_voice', 'ai_instructions', 'voice_provider', 'input_buffer_debug',
      // Web search tool (backend choice + the Brave key; 'openai' reuses openai_api_key)
      'web_search_provider', 'brave_api_key',
      // Feature gates (default on) — disabled features cost no LLM context
      'weather_enabled', 'timers_enabled',
      // Bring! shopping-list integration (opt-in): enable flag + account creds + optional list name
      'bring_enabled', 'bring_email', 'bring_password', 'bring_list_name',
      // Music Assistant integration (opt-in): enable flag + server address (control-plane
      // only — MA streams to the speakers itself via Sendspin)
      'music_assistant_enabled', 'music_assistant_host', 'music_assistant_port', 'music_assistant_token',
      // Local pipeline endpoints + per-stage backend selection (Whisper/Voxtral,
      // Ollama/Mistral, Piper/Voxtral) and the shared Mistral credentials/models
      'local_stt_host', 'local_stt_port', 'local_llm_host', 'local_llm_port', 'local_llm_model', 'local_llm_num_ctx', 'local_tts_host', 'local_tts_port',
      'local_stt_provider', 'local_llm_provider', 'local_tts_provider',
      'mistral_api_key', 'mistral_model', 'mistral_stt_model', 'mistral_stt_realtime_model', 'mistral_tts_model',
      // Generic OpenAI-compatible backends (per-stage base URL / key / model)
      'openai_stt_url', 'openai_stt_key', 'openai_stt_model',
      'openai_llm_url', 'openai_llm_key', 'openai_llm_model',
      'openai_tts_url', 'openai_tts_key', 'openai_tts_model', 'openai_tts_voice',
      // Wyoming protocol services (wyoming-faster-whisper 10300, wyoming-piper 10200)
      'wyoming_stt_host', 'wyoming_stt_port', 'wyoming_tts_host', 'wyoming_tts_port',
      // LM Studio desktop app (OpenAI dialect, port 1234, model optional)
      'lmstudio_host', 'lmstudio_port', 'lmstudio_model',
      // Remote syslog logging (third-party log collectors)
      'remote_log_enabled', 'remote_log_host', 'remote_log_port', 'remote_log_protocol', 'remote_log_level'];

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
    try {
      sub({ ...this.globals }); // initial
    } catch (e) {
      this.logger.error('Global settings subscriber threw on initial snapshot', e);
    }
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
    for (const sub of this.globalSubs) {
      try {
        sub(snapshot);
      } catch (e) {
        // One throwing subscriber (e.g. a device mid-rebuild) must not stop
        // the remaining devices from seeing the settings update.
        this.logger.error('Global settings subscriber threw', e);
      }
    }
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
