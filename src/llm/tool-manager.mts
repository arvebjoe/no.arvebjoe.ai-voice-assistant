import { EventEmitter } from "events";
import { TypedEmitter } from "tiny-typed-emitter";
import { DeviceManager } from '../helpers/device-manager.mjs';
import { WeatherHelper } from '../helpers/weather-helper.mjs';
import { createLogger } from '../helpers/logger.mjs';
import { GeoHelper } from "../helpers/geo-helper.mjs";
import { settingsManager } from "../settings/settings-manager.mjs";
import { TimerManager } from "../voice_assistant/timer-manager.mjs";
import { openaiWebSearch, braveWebSearch } from "../helpers/web-search.mjs";
import { BringClient } from "../helpers/bring-client.mjs";
import { MusicAssistantClient, getMusicAssistantClient, MaPlayer, MaMediaItem, MaQueueCommand } from "../helpers/music-assistant-client.mjs";

type ToolHandler = (args: any) => Promise<any> | any;

interface ToolDefinition {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: Record<string, any>;
        required: string[];
        additionalProperties: boolean;
    };
    handler: ToolHandler;
}

type ToolManagerEvents = { /* reserved */ };

export class ToolManager extends (EventEmitter as new () => TypedEmitter<ToolManagerEvents>) {
    private homey: any;
    private deviceManager: DeviceManager;
    private geoHelper: GeoHelper;
    private weatherHelper: WeatherHelper;
    private timerManager?: TimerManager;
    private tools: Map<string, ToolDefinition> = new Map();
    private logger = createLogger('ToolManager', true);
    private standardZone: string;

    // Bring! shopping-list integration (opt-in via settings). The client is
    // created lazily on first use; `shoppingListActive` mirrors whether the
    // four shopping tools below are currently registered.
    private bringClient?: BringClient;
    private shoppingListActive = false;
    private static readonly SHOPPING_TOOL_NAMES = [
        'get_shopping_list', 'add_to_shopping_list', 'update_shopping_list_item', 'remove_from_shopping_list',
    ];

    // Music Assistant integration (opt-in via settings). One shared client for
    // the whole app (see getMusicAssistantClient); `musicActive` mirrors
    // whether the music tools below are currently registered.
    private musicClient?: MusicAssistantClient;
    private musicActive = false;
    // Identifies THIS satellite so "play music" without a room targets the
    // speaker the user is talking to (matched against the MA player list by
    // IP address, then name). Set by the device after construction.
    private musicPlayerHint?: () => { address?: string; deviceName?: string; zone?: string };
    private musicPlayersCache: { players: MaPlayer[]; fetchedAt: number } | null = null;
    private static readonly MUSIC_TOOL_NAMES = [
        'search_music', 'play_music', 'music_control', 'get_music_state',
    ];

    // Weather / web search / timers are gated the same way (docs/cost-of-growth.md
    // rule 1: every optional feature has an on/off gate so disabled features cost
    // no context). All three default ON to preserve pre-gate behavior.
    private weatherActive = false;
    private webSearchActive = false;
    private timerToolsActive = false;
    private static readonly WEATHER_TOOL_NAMES = [
        'get_current_weather', 'get_weather_forecast', 'will_it_rain', 'get_weather_summary', 'get_outside_illumination',
    ];
    private static readonly TIMER_TOOL_NAMES = ['set_timer', 'cancel_timer', 'get_timer'];
    private static readonly WEB_SEARCH_TOOL_NAMES = ['web_search'];

    /** Tool names per optional feature — the settings cost endpoint groups by this. */
    static readonly FEATURE_TOOLS: Record<string, readonly string[]> = {
        weather: ToolManager.WEATHER_TOOL_NAMES,
        timers: ToolManager.TIMER_TOOL_NAMES,
        websearch: ToolManager.WEB_SEARCH_TOOL_NAMES,
        shopping: ToolManager.SHOPPING_TOOL_NAMES,
        music: ToolManager.MUSIC_TOOL_NAMES,
    };

    /** Read a boolean-ish global setting ('true'/'false' strings included). */
    private static boolSetting(key: string, fallback: boolean): boolean {
        const v = settingsManager.getGlobal<any>(key, fallback);
        if (v === true || v === 'true') return true;
        if (v === false || v === 'false') return false;
        return fallback;
    }

    constructor(homey: any, standardZone: string, deviceManager: DeviceManager, geoHelper: GeoHelper, weatherHelper: WeatherHelper, timerManager?: TimerManager) {
        super();
        this.homey = homey;
        this.deviceManager = deviceManager;
        this.standardZone = standardZone;
        this.geoHelper = geoHelper;
        this.weatherHelper = weatherHelper;
        this.timerManager = timerManager;
        this.registerDefaultTools();
    }

    /** The zone `get_devices_in_standard_zone` resolves against (the device's own zone). */
    getStandardZone(): string {
        return this.standardZone;
    }

    /**
     * Update the standard zone after the device is moved to another Homey zone.
     * Without this the tool keeps querying the zone the device was in at startup.
     */
    setStandardZone(zone: string): void {
        if (!zone || zone === this.standardZone) return;
        this.logger.info(`Standard zone updated: ${this.standardZone} -> ${zone}`);
        this.standardZone = zone;
    }

    registerTool(definition: ToolDefinition): void {
        this.logger.info(definition.name, "REGISTER TOOL");
        this.tools.set(definition.name, definition);
    }

    unregisterTool(name: string): void {
        if (this.tools.delete(name)) {
            this.logger.info(name, "UNREGISTER TOOL");
        }
    }

    getToolHandlers(): Record<string, ToolHandler> {
        const handlers: Record<string, ToolHandler> = {};
        for (const [name, tool] of this.tools) handlers[name] = tool.handler;
        return handlers;
    }

    /**
     * Execute a registered tool by name (Org 2: the lookup/run/error-wrap dance
     * lives here instead of being copied into every provider). Never throws:
     * an unknown tool or a throwing handler both come back as a structured
     * `{ error }` output the model can explain to the user.
     *
     * `failed` is true only when the handler THREW — the OpenAI provider uses
     * it to switch the continuation response to error instructions. An unknown
     * tool keeps failed=false (historical behavior: the model just relays the
     * error text).
     */
    async execute(name: string, args: any): Promise<{ output: any; failed: boolean }> {
        const tool = this.tools.get(name);
        if (!tool) {
            return { output: { error: `Unknown tool: ${name}` }, failed: false };
        }
        try {
            return { output: await tool.handler(args ?? {}), failed: false };
        } catch (err: any) {
            return { output: { error: String(err?.message ?? err) }, failed: true };
        }
    }

    getToolDefinitions(): Array<Omit<ToolDefinition, 'handler'>> {
        return Array.from(this.tools.values()).map(tool => ({
            type: tool.type,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        }));
    }

    getToolDefinition(name: string): Omit<ToolDefinition, 'handler'> | undefined {
        const tool = this.tools.get(name);
        if (!tool) return undefined;
        const { handler, ...def } = tool;
        return def;
    }

    hasTool(name: string): boolean { return this.tools.has(name); }
    getToolNames(): string[] { return Array.from(this.tools.keys()); }

    /**
     * Device + zone names for the provider's STT vocabulary prompt (§2 STT
     * accuracy). Optional-chained so test doubles without the helper stay valid;
     * empty until DeviceManager has fetched the catalog.
     */
    getSttVocabulary(): string[] {
        return (this.deviceManager as any)?.getVocabularyNames?.() ?? [];
    }

    private async listDeviceIdsBy(zone?: string | null, type?: string | null): Promise<string[]> {
        // Page through getSmartHomeDevices to collect device IDs for safety checks
        const ids: string[] = [];
        let pageToken: string | null = null;
        do {
            const data = await this.deviceManager.getSmartHomeDevices(zone || undefined, type || undefined, 100, pageToken);
            const devices = Array.isArray((data as any)?.devices) ? (data as any).devices : (Array.isArray(data) ? data : []);
            for (const d of devices) {
                if (d && typeof d.id === 'string') ids.push(d.id);
            }
            pageToken = (data as any)?.next_page_token ?? null;
        } while (pageToken);
        return Array.from(new Set(ids));
    }

    /**
     * S3: code-side whitelist + value coercion for set_device_capability — the
     * schema's enum/oneOf only constrain a model that honors it. Mirrors what
     * the instructions already tell the model (dim in [0,1] rounded to two
     * decimals, temperature clamped to 5-35 °C).
     */
    private validateCapabilityWrite(capabilityId: string, newValue: any): { ok: true; value: any } | { ok: false; message: string } {
        switch (capabilityId) {
            case "onoff":
            case "locked": {
                const b = typeof newValue === "boolean" ? newValue
                    : newValue === "true" ? true
                        : newValue === "false" ? false
                            : null;
                if (b === null) {
                    return { ok: false, message: `'${capabilityId}' requires a boolean value.` };
                }
                return { ok: true, value: b };
            }
            case "dim": {
                let n = typeof newValue === "number" ? newValue : (typeof newValue === "string" ? Number(newValue) : NaN);
                if (!Number.isFinite(n)) {
                    return { ok: false, message: "'dim' requires a number in [0,1]." };
                }
                // A value in (1,100] is almost certainly a percentage the model
                // forgot to divide (the instructions define dim as X/100).
                if (n > 1 && n <= 100) n = n / 100;
                n = Math.min(1, Math.max(0, n));
                return { ok: true, value: Math.round(n * 100) / 100 };
            }
            case "target_temperature": {
                const n = typeof newValue === "number" ? newValue : (typeof newValue === "string" ? Number(newValue) : NaN);
                if (!Number.isFinite(n)) {
                    return { ok: false, message: "'target_temperature' requires a number (°C)." };
                }
                return { ok: true, value: Math.min(35, Math.max(5, n)) };
            }
            default:
                return { ok: false, message: `Capability '${capabilityId}' is not writable. Writable capabilities: onoff, dim, target_temperature, locked.` };
        }
    }

    private registerDefaultTools(): void {
        this.registerSystemTools();
        this.registerDeviceManagementTools();
        this.refreshWeatherTools();
        this.refreshWebSearchTools();
        this.refreshTimerTools();
        this.refreshShoppingListTools();
        this.refreshMusicTools();
    }

    /** Whether the weather tools are currently registered. */
    isWeatherActive(): boolean {
        return this.weatherActive;
    }

    /** Whether the web_search tool is currently registered. */
    isWebSearchActive(): boolean {
        return this.webSearchActive;
    }

    /** Whether the timer tools are currently registered (device support is separate). */
    areTimerToolsActive(): boolean {
        return this.timerToolsActive;
    }

    /**
     * Reconcile the weather tools with the `weather_enabled` setting (default
     * on). Same contract as the Bring!/Music refreshes: returns the new active
     * state so the device can restart the provider when it flips.
     */
    refreshWeatherTools(): boolean {
        const active = ToolManager.boolSetting('weather_enabled', true);
        if (active === this.weatherActive) return active;
        if (active) {
            this.registerWeatherTools();
        } else {
            for (const name of ToolManager.WEATHER_TOOL_NAMES) this.unregisterTool(name);
        }
        this.weatherActive = active;
        this.logger.info(`Weather tools ${active ? 'registered' : 'removed'}`);
        return active;
    }

    /**
     * Reconcile the web_search tool with the `web_search_provider` setting:
     * registered unless the backend is 'disabled'. Before this gate the tool
     * was always sent to the model and only its handler refused when disabled
     * — now a disabled web search costs no context at all.
     */
    refreshWebSearchTools(): boolean {
        const backend = settingsManager.getGlobal<string>('web_search_provider', 'openai');
        const active = backend !== 'disabled';
        if (active === this.webSearchActive) return active;
        if (active) {
            this.registerWebSearchTool();
        } else {
            for (const name of ToolManager.WEB_SEARCH_TOOL_NAMES) this.unregisterTool(name);
        }
        this.webSearchActive = active;
        this.logger.info(`Web search tool ${active ? 'registered' : 'removed'}`);
        return active;
    }

    /**
     * Reconcile the timer tools with the `timers_enabled` setting (default on).
     * Device firmware support is a separate axis: the instructions block is
     * gated on `esp.supportsTimers` AND this, in the device.
     */
    refreshTimerTools(): boolean {
        const active = !!this.timerManager && ToolManager.boolSetting('timers_enabled', true);
        if (active === this.timerToolsActive) return active;
        if (active) {
            this.registerTimerTools();
        } else {
            for (const name of ToolManager.TIMER_TOOL_NAMES) this.unregisterTool(name);
        }
        this.timerToolsActive = active;
        this.logger.info(`Timer tools ${active ? 'registered' : 'removed'}`);
        return active;
    }

    /**
     * Cost measurement ONLY (settings page budget panel): register every
     * optional feature's tools regardless of settings, credentials or device
     * support, so their definitions can be sized. Never call this on a
     * ToolManager that serves a live session — handlers of force-registered
     * tools may lack their backing services.
     */
    registerAllToolsForMeasurement(): void {
        this.registerWeatherTools();
        this.registerWebSearchTool();
        this.registerTimerTools();
        this.registerShoppingListTools();
        this.registerMusicTools();
    }

    /** Whether the Bring! shopping-list tools are currently registered. */
    isShoppingListActive(): boolean {
        return this.shoppingListActive;
    }

    /** Whether the Music Assistant tools are currently registered. */
    isMusicActive(): boolean {
        return this.musicActive;
    }

    /**
     * Tell the music tools which physical satellite this ToolManager belongs
     * to, so playback targets the speaker the user is talking to by default.
     * A callback (not a snapshot) because the device's IP and name can change.
     */
    setMusicPlayerHint(hint: () => { address?: string; deviceName?: string; zone?: string }): void {
        this.musicPlayerHint = hint;
    }

    /**
     * Read the Music Assistant settings and reconcile the music tools with
     * them: registered only when the feature is enabled AND a server host is
     * set, removed otherwise. Returns the new active state so the device can
     * gate the prompt block to match (same contract as the Bring! refresh).
     */
    refreshMusicTools(): boolean {
        const enabledSetting = settingsManager.getGlobal<any>('music_assistant_enabled', false);
        const enabled = enabledSetting === true || enabledSetting === 'true';
        const host = (settingsManager.getGlobal<string>('music_assistant_host', '') || '').trim();
        const port = Number(settingsManager.getGlobal<any>('music_assistant_port', 8095)) || 8095;
        const active = enabled && host.length > 0;

        if (active) {
            if (!this.musicClient) this.musicClient = getMusicAssistantClient();
            this.musicClient.configure(host, port);
        }

        if (active === this.musicActive) {
            return active; // no change (the address may have been refreshed above)
        }

        if (active) {
            this.registerMusicTools();
        } else {
            for (const name of ToolManager.MUSIC_TOOL_NAMES) this.unregisterTool(name);
        }
        this.musicActive = active;
        this.logger.info(`Music tools ${active ? 'registered' : 'removed'}`);
        return active;
    }

    /**
     * Read the Bring! settings and reconcile the shopping-list tools with them:
     * the four tools are registered only when the feature is enabled AND the
     * account credentials are present, and removed otherwise. Returns the new
     * active state so the device can gate the prompt block to match and restart
     * the provider when it flips.
     */
    refreshShoppingListTools(): boolean {
        const enabledSetting = settingsManager.getGlobal<any>('bring_enabled', false);
        const enabled = enabledSetting === true || enabledSetting === 'true';
        const email = (settingsManager.getGlobal<string>('bring_email', '') || '').trim();
        const password = settingsManager.getGlobal<string>('bring_password', '') || '';
        const listName = (settingsManager.getGlobal<string>('bring_list_name', '') || '').trim();
        const active = enabled && email.length > 0 && password.length > 0;

        if (active) {
            if (!this.bringClient) this.bringClient = new BringClient();
            this.bringClient.setCredentials(email, password, listName);
        }

        if (active === this.shoppingListActive) {
            return active; // no change (credentials may have been refreshed above)
        }

        if (active) {
            this.registerShoppingListTools();
        } else {
            for (const name of ToolManager.SHOPPING_TOOL_NAMES) this.unregisterTool(name);
        }
        this.shoppingListActive = active;
        this.logger.info(`Shopping list tools ${active ? 'registered' : 'removed'}`);
        return active;
    }

    private registerSystemTools(): void {
        this.registerTool({
            type: "function",
            name: "get_local_time",
            description: "Get the current local time using the system's timezone and the user's preferred language locale. No parameters needed - automatically uses current location and language settings.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false
            },
            handler: () => {
                const now = new Date();
                
                // Get timezone from GeoHelper
                const timezone = this.geoHelper.timezone || "Europe/Oslo";
                
                // Get locale from SettingsManager
                const locale = settingsManager.getCurrentLocale();
                
                try {
                    const formatted = new Intl.DateTimeFormat(locale, {
                        timeZone: timezone,
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        weekday: "long",
                        day: "2-digit",
                        month: "long",
                        year: "numeric"
                    }).format(now);
                    
                    return { 
                        ok: true, 
                        data: { 
                            iso: now.toISOString(), 
                            formatted, 
                            timezone, 
                            locale,
                            location: this.geoHelper.getLocationInfoString()
                        } 
                    };
                } catch (error: any) {
                    this.logger.error('Error formatting local time:', error);
                    return {
                        ok: false,
                        error: {
                            code: "TIME_FORMAT_ERROR",
                            message: `Could not format time for timezone '${timezone}' and locale '${locale}'.`
                        }
                    };
                }
            }
        });

        this.registerAssistantCapabilitiesTool();
    }

    private registerWebSearchTool(): void {
        this.registerTool({
            type: "function",
            name: "web_search",
            description: "Search the web for current or local information the smart home does not know: news, opening hours, " +
                "cinema programs, bus/train departures, prices, sports results, events. Use a short, focused query in the " +
                "user's language and include the place name when the question is about something local.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "The web search query, e.g. 'cinema program Oslo today' or 'next bus from Majorstuen to Oslo S'." }
                },
                required: ["query"],
                additionalProperties: false
            },
            handler: async ({ query }) => {
                this.logger.info('web_search', 'TOOL', `query=${query}`);
                const q = String(query ?? '').trim();
                if (!q) {
                    return { ok: false, error: { code: "EMPTY_QUERY", message: "A search query is required." } };
                }
                const backend = settingsManager.getGlobal<string>('web_search_provider', 'openai');
                try {
                    if (backend === 'disabled') {
                        return { ok: false, error: { code: "WEB_SEARCH_DISABLED", message: "Web search is disabled in the app settings." } };
                    }
                    if (backend === 'brave') {
                        const key = (settingsManager.getGlobal<string>('brave_api_key', '') || '').trim();
                        if (!key) {
                            return { ok: false, error: { code: "NO_API_KEY", message: "The Brave Search API key is not set in the app settings." } };
                        }
                        const results = await braveWebSearch(q, key);
                        if (!results.length) {
                            return { ok: false, error: { code: "NO_RESULTS", message: "The web search returned no results." } };
                        }
                        return { ok: true, data: { results } };
                    }
                    // Default: OpenAI Responses web_search on the app's OpenAI key.
                    const key = (settingsManager.getGlobal<string>('openai_api_key', '') || '').trim();
                    if (!key) {
                        return { ok: false, error: { code: "NO_API_KEY", message: "Web search uses the OpenAI API key, which is not set in the app settings." } };
                    }
                    const { answer, sources } = await openaiWebSearch(q, key, { timezone: this.geoHelper.timezone ?? undefined });
                    return { ok: true, data: { answer, sources } };
                } catch (error: any) {
                    this.logger.error('web_search failed:', error);
                    return { ok: false, error: { code: "SEARCH_FAILED", message: String(error?.message ?? error) } };
                }
            }
        });
    }

    private registerAssistantCapabilitiesTool(): void {
        this.registerTool({
            type: "function",
            name: "get_assistant_capabilities",
            description: "Explain what this voice assistant can do. Call this when the user asks for help or what the assistant can do (e.g. \"help\", \"what can you do?\", \"what are you able to control?\"). " +
                "Summarize the returned capabilities briefly and conversationally in the user's language — don't read the tool list verbatim.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false
            },
            handler: () => {
                this.logger.info('get_assistant_capabilities', 'TOOL', 'Executing get_assistant_capabilities...');
                const tools = Array.from(this.tools.values())
                    .filter(t => t.name !== 'get_assistant_capabilities')
                    .map(t => ({ name: t.name, description: t.description }));
                return {
                    ok: true,
                    data: {
                        summary: "This voice assistant can: control smart home devices (lights, sockets, thermostats, locks — on/off, dim level, target temperature) in any room/zone; " +
                            "look up devices and read sensor values (temperature, humidity, motion, etc.); " +
                            (this.weatherActive ? "report the current weather and the forecast for the home's location; " : "") +
                            "tell the current local time and date; " +
                            (this.webSearchActive ? "search the web for current information (news, opening hours, departures); " : "") +
                            (this.timerToolsActive ? "set, check and cancel a countdown timer or alarm on the voice device; " : "") +
                            (this.shoppingListActive ? "read the Bring! shopping list and add, change or remove items on it; " : "") +
                            (this.musicActive ? "find and play music (artists, albums, tracks, playlists, radio) on the speakers via Music Assistant, and pause, skip or shuffle playback; " : "") +
                            "and answer general questions conversationally.",
                        tools
                    }
                };
            }
        });
    }

    private registerTimerTools(): void {

        this.registerTool({
            type: "function",
            name: "set_timer",
            description: "Start a countdown timer (or an alarm) on the voice device. The device shows a countdown on its LED ring and rings when the time is up. " +
                "For an ALARM at a specific clock time (e.g. \"set an alarm for 11:00\"): first call get_local_time, compute how many seconds from now until that time (use the next occurrence if it has already passed today), then call this with that duration_seconds. " +
                "Only ONE timer can exist at a time. If a timer is already running this returns code TIMER_ALREADY_ACTIVE with the existing timer; in that case ask the user whether to replace it, and only retry with replace=true if they agree.",
            parameters: {
                type: "object",
                properties: {
                    duration_seconds: { type: "integer", description: "Countdown length in seconds. For an alarm, the seconds from now until the target clock time.", minimum: 1 },
                    name: { type: "string", description: "Optional short label for the timer (e.g. \"pasta\", \"alarm 11:00\")." },
                    replace: { type: "boolean", description: "Set true to cancel any existing timer and start this one. Only use after the user confirms replacing the running timer.", default: false }
                },
                required: ["duration_seconds"],
                additionalProperties: false
            },
            handler: async ({ duration_seconds, name, replace }) => {
                this.logger.info('set_timer', 'TOOL', `duration_seconds=${duration_seconds}, name=${name}, replace=${replace}`);
                const result = this.timerManager!.startTimer(duration_seconds, name || '', replace === true);
                if (result.ok) {
                    return { ok: true, data: result.timer };
                }
                return { ok: false, error: { code: result.code, message: result.message }, active_timer: result.active };
            }
        });

        this.registerTool({
            type: "function",
            name: "cancel_timer",
            description: "Cancel the currently running timer, or stop the timer/alarm that is ringing on the device. No parameters needed.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false
            },
            handler: async () => {
                this.logger.info('cancel_timer', 'TOOL', 'Executing cancel_timer...');
                const result = this.timerManager!.cancelTimer();
                if (result.ok) {
                    return { ok: true, data: result.cancelled };
                }
                return { ok: false, error: { code: result.code, message: result.message } };
            }
        });

        this.registerTool({
            type: "function",
            name: "get_timer",
            description: "Get the currently running timer/alarm and how much time is left on it (in seconds). No parameters needed.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false
            },
            handler: async () => {
                this.logger.info('get_timer', 'TOOL', 'Executing get_timer...');
                const active = this.timerManager!.getActiveTimer();
                return { ok: true, data: { active_timer: active } };
            }
        });
    }

    private registerShoppingListTools(): void {

        this.registerTool({
            type: "function",
            name: "get_shopping_list",
            description: "Get the items currently on the Bring! shopping list. Use for questions like \"what's on the shopping list?\" or \"do we need milk?\". No parameters needed.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false
            },
            handler: async () => {
                this.logger.info('get_shopping_list', 'TOOL', 'Executing get_shopping_list...');
                try {
                    const snapshot = await this.bringClient!.getList();
                    return { ok: true, data: { list_name: snapshot.listName, item_count: snapshot.items.length, items: snapshot.items } };
                } catch (error: any) {
                    this.logger.error('Error executing get_shopping_list', error);
                    return { ok: false, error: { code: "SHOPPING_LIST_UNAVAILABLE", message: String(error?.message ?? error) } };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "add_to_shopping_list",
            description: "Add a single item to the Bring! shopping list. If the item is already on the list this returns code ITEM_ALREADY_EXISTS with the existing amount — in that case do NOT add it again; ask the user whether to increase the amount (use update_shopping_list_item) or leave it. Only pass force=true after the user explicitly confirms adding/overwriting a duplicate.",
            parameters: {
                type: "object",
                properties: {
                    item: { type: "string", description: "The item to add, e.g. \"milk\" or \"bananas\". One item per call." },
                    specification: { type: "string", description: "Optional amount or note, e.g. \"2\" or \"2 liters\". Only set it if the user stated an amount." },
                    force: { type: "boolean", description: "Set true only after the user confirms adding an item that already exists (overwrites its amount).", default: false }
                },
                required: ["item"],
                additionalProperties: false
            },
            handler: async ({ item, specification, force }) => {
                this.logger.info('add_to_shopping_list', 'TOOL', `item=${item}, specification=${specification}, force=${force}`);
                const name = String(item ?? '').trim();
                if (!name) {
                    return { ok: false, error: { code: "EMPTY_ITEM", message: "An item name is required." } };
                }
                try {
                    if (force !== true) {
                        const existing = await this.bringClient!.findItem(name);
                        if (existing) {
                            return {
                                ok: false,
                                error: {
                                    code: "ITEM_ALREADY_EXISTS",
                                    message: `"${existing.name}" is already on the shopping list${existing.specification ? ` (${existing.specification})` : ''}. Ask the user whether to increase the amount or leave it.`
                                },
                                existing: { name: existing.name, specification: existing.specification }
                            };
                        }
                    }
                    await this.bringClient!.saveItem(name, specification || '');
                    return { ok: true, data: { added: { name, specification: (specification || '').trim() } } };
                } catch (error: any) {
                    this.logger.error('Error executing add_to_shopping_list', error);
                    return { ok: false, error: { code: "SHOPPING_LIST_ADD_FAILED", message: String(error?.message ?? error) } };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "update_shopping_list_item",
            description: "Change the amount/specification of an item already on the Bring! shopping list. Use this when the user wants to increase the amount of a duplicate item (e.g. after add_to_shopping_list reported ITEM_ALREADY_EXISTS).",
            parameters: {
                type: "object",
                properties: {
                    item: { type: "string", description: "The existing item to update, e.g. \"milk\"." },
                    specification: { type: "string", description: "The new amount or note, e.g. \"3\" or \"3 liters\"." }
                },
                required: ["item", "specification"],
                additionalProperties: false
            },
            handler: async ({ item, specification }) => {
                this.logger.info('update_shopping_list_item', 'TOOL', `item=${item}, specification=${specification}`);
                const name = String(item ?? '').trim();
                if (!name) {
                    return { ok: false, error: { code: "EMPTY_ITEM", message: "An item name is required." } };
                }
                try {
                    await this.bringClient!.saveItem(name, String(specification ?? '').trim());
                    return { ok: true, data: { updated: { name, specification: String(specification ?? '').trim() } } };
                } catch (error: any) {
                    this.logger.error('Error executing update_shopping_list_item', error);
                    return { ok: false, error: { code: "SHOPPING_LIST_UPDATE_FAILED", message: String(error?.message ?? error) } };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "remove_from_shopping_list",
            description: "Remove a single item from the Bring! shopping list, e.g. \"take bread off the shopping list\".",
            parameters: {
                type: "object",
                properties: {
                    item: { type: "string", description: "The item to remove, e.g. \"bread\"." }
                },
                required: ["item"],
                additionalProperties: false
            },
            handler: async ({ item }) => {
                this.logger.info('remove_from_shopping_list', 'TOOL', `item=${item}`);
                const name = String(item ?? '').trim();
                if (!name) {
                    return { ok: false, error: { code: "EMPTY_ITEM", message: "An item name is required." } };
                }
                try {
                    await this.bringClient!.removeItem(name);
                    return { ok: true, data: { removed: name } };
                } catch (error: any) {
                    this.logger.error('Error executing remove_from_shopping_list', error);
                    return { ok: false, error: { code: "SHOPPING_LIST_REMOVE_FAILED", message: String(error?.message ?? error) } };
                }
            }
        });
    }

    // ------------------------------------------------------------------
    // Music Assistant tools
    // ------------------------------------------------------------------

    /** Lowercase, letters/digits only, single spaces — for player/item matching. */
    private static normalizeMusicName(s: string): string {
        return (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    }

    /** MA player list, cached briefly so one conversation turn is one fetch. */
    private async getMusicPlayers(): Promise<MaPlayer[]> {
        const now = Date.now();
        if (this.musicPlayersCache && now - this.musicPlayersCache.fetchedAt < 10_000) {
            return this.musicPlayersCache.players;
        }
        const players = await this.musicClient!.getPlayers();
        this.musicPlayersCache = { players, fetchedAt: now };
        return players;
    }

    /**
     * Pick the MA player to act on. An explicit name from the user wins;
     * otherwise the satellite the user is talking to (matched by IP, then by
     * device name, then by zone name); otherwise a single available player.
     * Failure returns the list of available player names so the model can ask.
     */
    private async resolveMusicPlayer(explicitName?: string): Promise<{ player: MaPlayer } | { error: { code: string; message: string } }> {
        const all = await this.getMusicPlayers();
        const players = all.filter(p => p.available);
        if (players.length === 0) {
            return { error: { code: "NO_PLAYERS", message: "Music Assistant reports no available players." } };
        }
        const names = players.map(p => p.name).join(', ');

        if (explicitName && explicitName.trim()) {
            const wanted = ToolManager.normalizeMusicName(explicitName);
            const match = players.find(p => ToolManager.normalizeMusicName(p.name) === wanted)
                ?? players.find(p => ToolManager.normalizeMusicName(p.name).includes(wanted) || wanted.includes(ToolManager.normalizeMusicName(p.name)));
            if (match) return { player: match };
            return { error: { code: "PLAYER_NOT_FOUND", message: `No music player matches "${explicitName}". Available players: ${names}.` } };
        }

        const hint = this.musicPlayerHint?.();
        if (hint) {
            if (hint.address) {
                const byIp = players.find(p => p.ipAddress && p.ipAddress === hint.address);
                if (byIp) return { player: byIp };
            }
            for (const candidate of [hint.deviceName, hint.zone]) {
                if (!candidate) continue;
                const wanted = ToolManager.normalizeMusicName(candidate);
                if (!wanted) continue;
                const match = players.find(p => ToolManager.normalizeMusicName(p.name) === wanted)
                    ?? players.find(p => ToolManager.normalizeMusicName(p.name).includes(wanted) || wanted.includes(ToolManager.normalizeMusicName(p.name)));
                if (match) return { player: match };
            }
        }

        if (players.length === 1) {
            return { player: players[0] };
        }
        return { error: { code: "PLAYER_AMBIGUOUS", message: `This speaker is not a music player in Music Assistant — ask the user which player to use. Available players: ${names}.` } };
    }

    /**
     * Pick the item to play from search results: exact name match first, then
     * partial, preferring artists > albums > tracks > playlists > radio.
     * When the model stated a media_type only that list is considered.
     */
    private static pickMusicItem(results: { artists: MaMediaItem[]; albums: MaMediaItem[]; tracks: MaMediaItem[]; playlists: MaMediaItem[]; radio: MaMediaItem[] }, query: string, mediaType?: string): MaMediaItem | null {
        const listByType: Record<string, MaMediaItem[]> = {
            artist: results.artists, album: results.albums, track: results.tracks,
            playlist: results.playlists, radio: results.radio,
        };
        const lists: MaMediaItem[][] = mediaType
            ? [listByType[mediaType] ?? []]
            : [results.artists, results.albums, results.tracks, results.playlists, results.radio];
        const wanted = ToolManager.normalizeMusicName(query);

        let best: MaMediaItem | null = null;
        let bestScore = 0;
        for (const list of lists) {
            for (const item of list ?? []) {
                const name = ToolManager.normalizeMusicName(item.name);
                let score = 1;
                if (name === wanted) score = 3;
                else if (name.includes(wanted) || wanted.includes(name)) score = 2;
                if (score > bestScore) {
                    best = item;
                    bestScore = score;
                }
            }
            // An exact hit in a higher-priority list wins outright.
            if (bestScore === 3) break;
        }
        return best;
    }

    /** Compact search-result lists for the model (top 5 per type, with URIs). */
    private static compactMusicResults(results: { artists: MaMediaItem[]; albums: MaMediaItem[]; tracks: MaMediaItem[]; playlists: MaMediaItem[]; radio: MaMediaItem[] }) {
        const compact = (list: MaMediaItem[]) => list.slice(0, 5).map(i => ({
            name: i.name,
            ...(i.artists ? { artists: i.artists } : {}),
            ...(i.album ? { album: i.album } : {}),
            uri: i.uri,
        }));
        return {
            artists: compact(results.artists),
            albums: compact(results.albums),
            tracks: compact(results.tracks),
            playlists: compact(results.playlists),
            radio: compact(results.radio),
        };
    }

    private registerMusicTools(): void {

        this.registerTool({
            type: "function",
            name: "search_music",
            description: "Search Music Assistant (the user's music library and streaming providers) for artists, albums, tracks, playlists or radio stations. " +
                "Use it to browse or disambiguate (\"which albums do we have by X?\"); to just play something, call play_music directly.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "What to search for, e.g. \"Abbey Road\" or \"Beatles\"." },
                    media_type: { type: "string", enum: ["artist", "album", "track", "playlist", "radio"], description: "Optional: only search this kind of item." }
                },
                required: ["query"],
                additionalProperties: false
            },
            handler: async ({ query, media_type }) => {
                this.logger.info('search_music', 'TOOL', `query=${query}, media_type=${media_type}`);
                const q = String(query ?? '').trim();
                if (!q) {
                    return { ok: false, error: { code: "EMPTY_QUERY", message: "A search query is required." } };
                }
                try {
                    const results = await this.musicClient!.search(q, media_type ? [media_type] : undefined, 8);
                    return { ok: true, data: ToolManager.compactMusicResults(results) };
                } catch (error: any) {
                    this.logger.error('Error executing search_music', error);
                    return { ok: false, error: { code: "MUSIC_UNAVAILABLE", message: String(error?.message ?? error) } };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "play_music",
            description: "Find music in Music Assistant and play it on a speaker. Give either a search query (with an optional media_type) or a uri from an earlier search_music result. " +
                "Plays on the speaker the user is talking to unless the user names another player/room. Confirm briefly what started playing (the tool returns it).",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "What to play, e.g. \"Abbey Road\", \"Queen\", \"NRK P1\". Not needed when uri is given." },
                    media_type: { type: "string", enum: ["artist", "album", "track", "playlist", "radio"], description: "What kind of item the user asked for, e.g. album for \"play the album X\". Strongly recommended when the user said it." },
                    uri: { type: "string", description: "A Music Assistant item uri from a previous search_music call. Takes precedence over query." },
                    mode: { type: "string", enum: ["play", "next", "add"], description: "play (default) = play now replacing the queue; next = play after the current track; add = append to the queue." },
                    radio_mode: { type: "boolean", description: "Set true for \"play music LIKE X\": keeps the queue going with similar tracks.", default: false },
                    player: { type: "string", description: "Player/room name, only when the user names one (e.g. \"in the kitchen\")." }
                },
                required: [],
                additionalProperties: false
            },
            handler: async ({ query, media_type, uri, mode, radio_mode, player }) => {
                this.logger.info('play_music', 'TOOL', `query=${query}, media_type=${media_type}, uri=${uri}, mode=${mode}, radio_mode=${radio_mode}, player=${player}`);
                try {
                    const resolved = await this.resolveMusicPlayer(player);
                    if ('error' in resolved) {
                        return { ok: false, error: resolved.error };
                    }
                    const queue = await this.musicClient!.getActiveQueue(resolved.player.playerId);
                    const option = mode === 'next' ? 'next' : mode === 'add' ? 'add' : 'replace';

                    if (uri && String(uri).trim()) {
                        await this.musicClient!.playMedia(queue.queueId, String(uri).trim(), option, radio_mode === true);
                        return { ok: true, data: { playing: String(uri).trim(), player: resolved.player.name, mode: option } };
                    }

                    const q = String(query ?? '').trim();
                    if (!q) {
                        return { ok: false, error: { code: "EMPTY_QUERY", message: "Either a query or a uri is required." } };
                    }
                    const type = typeof media_type === 'string' && media_type ? media_type : undefined;
                    const results = await this.musicClient!.search(q, type ? [type] : undefined, 8);
                    const item = ToolManager.pickMusicItem(results, q, type);
                    if (!item) {
                        return { ok: false, error: { code: "NO_MATCH", message: `Nothing found in Music Assistant for "${q}"${type ? ` (${type})` : ''}. Tell the user briefly.` } };
                    }
                    await this.musicClient!.playMedia(queue.queueId, item.uri, option, radio_mode === true);
                    return {
                        ok: true,
                        data: {
                            playing: {
                                name: item.name,
                                ...(item.artists ? { artists: item.artists } : {}),
                                ...(item.album ? { album: item.album } : {}),
                                media_type: item.mediaType,
                            },
                            player: resolved.player.name,
                            mode: option,
                        }
                    };
                } catch (error: any) {
                    this.logger.error('Error executing play_music', error);
                    return { ok: false, error: { code: "MUSIC_UNAVAILABLE", message: String(error?.message ?? error) } };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "music_control",
            description: "Control music playback: pause, resume, stop, skip to the next or previous track, or toggle shuffle. " +
                "Acts on the speaker the user is talking to unless the user names another player/room.",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["pause", "resume", "stop", "next", "previous", "shuffle_on", "shuffle_off"], description: "What to do." },
                    player: { type: "string", description: "Player/room name, only when the user names one." }
                },
                required: ["action"],
                additionalProperties: false
            },
            handler: async ({ action, player }) => {
                this.logger.info('music_control', 'TOOL', `action=${action}, player=${player}`);
                try {
                    const resolved = await this.resolveMusicPlayer(player);
                    if ('error' in resolved) {
                        return { ok: false, error: resolved.error };
                    }
                    const queue = await this.musicClient!.getActiveQueue(resolved.player.playerId);
                    if (action === 'shuffle_on' || action === 'shuffle_off') {
                        await this.musicClient!.setShuffle(queue.queueId, action === 'shuffle_on');
                    } else {
                        // 'play' unpauses; 'resume' restarts a stopped/idle queue.
                        const command: MaQueueCommand = action === 'resume'
                            ? (queue.state === 'paused' ? 'play' : 'resume')
                            : action as MaQueueCommand;
                        await this.musicClient!.queueCommand(queue.queueId, command);
                    }
                    return { ok: true, data: { action, player: resolved.player.name } };
                } catch (error: any) {
                    this.logger.error('Error executing music_control', error);
                    return { ok: false, error: { code: "MUSIC_UNAVAILABLE", message: String(error?.message ?? error) } };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "get_music_state",
            description: "Get what is currently playing on a speaker (track, artist, play/pause state, shuffle/repeat). Use for \"what's playing?\" or before changing playback.",
            parameters: {
                type: "object",
                properties: {
                    player: { type: "string", description: "Player/room name, only when the user names one." }
                },
                required: [],
                additionalProperties: false
            },
            handler: async ({ player }) => {
                this.logger.info('get_music_state', 'TOOL', `player=${player}`);
                try {
                    const resolved = await this.resolveMusicPlayer(player);
                    if ('error' in resolved) {
                        return { ok: false, error: resolved.error };
                    }
                    const queue = await this.musicClient!.getActiveQueue(resolved.player.playerId);
                    return {
                        ok: true,
                        data: {
                            player: resolved.player.name,
                            state: queue.state,
                            now_playing: queue.nowPlaying,
                            shuffle: queue.shuffleEnabled,
                            repeat: queue.repeatMode,
                            items_in_queue: queue.itemsInQueue,
                        }
                    };
                } catch (error: any) {
                    this.logger.error('Error executing get_music_state', error);
                    return { ok: false, error: { code: "MUSIC_UNAVAILABLE", message: String(error?.message ?? error) } };
                }
            }
        });
    }

    private registerDeviceManagementTools(): void {

        this.registerTool({
            type: "function",
            name: "get_zones",
            description: "Get a list of all zones.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false
            },
            handler: async () => {
                this.logger.info('get_zones', 'TOOL', 'Executing get_zones...');
                try {
                    const data = await this.deviceManager.getZones();
                    return { ok: true, data };
                } catch (error: any) {
                    this.logger.error(`Error executing get_zones`, error);
                    return { ok: false, error: { code: "ZONES_UNAVAILABLE", message: "Could not retrieve zones." } };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "get_device_types",
            description: "Get all device types available.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false
            },
            handler: async () => {
                this.logger.info('get_device_types', 'TOOL', 'Executing get_device_types...');
                try {
                    const data = await this.deviceManager.getAllDeviceTypes();
                    return { ok: true, data };
                } catch (error: any) {
                    this.logger.error(`Error executing get_device_types`, error);
                    return { ok: false, error: { code: "DEVICE_TYPES_UNAVAILABLE", message: "Could not retrieve device types." } };
                }
            }
        });

       
        this.registerTool({
            type: "function",
            name: "get_devices_in_standard_zone",
            description: "Get smart home devices in the standard zone for specific device type (with pagination).",
            parameters: {
                type: "object",
                properties: {                    
                    type: { type: "string", description: "Device type to filter devices (optional)." },
                    page_size: { type: "integer", description: "Number of devices to return per page (default 50, max 100).", minimum: 1, maximum: 100 },
                    page_token: { type: "string", description: "Token for pagination (optional)." }
                },
                required: [],
                additionalProperties: false
            },
            handler: async ({ type, page_size, page_token }) => {
                this.logger.info('get_devices_in_standard_zone', 'TOOL', `zone=${this.standardZone}, type=${type}, page_size=${page_size}, page_token=${page_token}`);                
                const typeSafe = type || undefined;
                const pageSizeSafe = page_size || undefined;
                const pageTokenSafe = page_token || null;
                try {
                    const data = await this.deviceManager.getSmartHomeDevices(this.standardZone, typeSafe, pageSizeSafe, pageTokenSafe);
                    return { ok: true, data };
                } catch (error: any) {
                    this.logger.error(`Error executing get_devices_in_standard_zone`, error);
                    return { ok: false, error: { code: "DEVICES_UNAVAILABLE", message: "Could not retrieve smart home devices." } };
                }
            }
        });


        this.registerTool({
            type: "function",
            name: "get_devices",
            description: "Get smart home devices in a specific zone and/or type (with pagination).",
            parameters: {
                type: "object",
                properties: {
                    zone: { type: "string", description: "Zone name to filter devices (optional)." },
                    type: { type: "string", description: "Device type to filter devices (optional)." },
                    page_size: { type: "integer", description: "Number of devices to return per page (default 50, max 100).", minimum: 1, maximum: 100 },
                    page_token: { type: "string", description: "Token for pagination (optional)." }
                },
                required: [],
                additionalProperties: false
            },
            handler: async ({ zone, type, page_size, page_token }) => {
                this.logger.info('get_devices', 'TOOL', `zone=${zone}, type=${type}, page_size=${page_size}, page_token=${page_token}`);
                const zoneSafe = zone || undefined;
                const typeSafe = type || undefined;
                const pageSizeSafe = page_size || undefined;
                const pageTokenSafe = page_token || null;
                try {
                    const data = await this.deviceManager.getSmartHomeDevices(zoneSafe, typeSafe, pageSizeSafe, pageTokenSafe);
                    return { ok: true, data };
                } catch (error: any) {
                    this.logger.error(`Error executing get_devices`, error);
                    return { ok: false, error: { code: "DEVICES_UNAVAILABLE", message: "Could not retrieve smart home devices." } };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "set_device_capability",
            description: "Set a capability value for one or many devices at once.",
            parameters: {
                type: "object",
                properties: {
                    deviceIds: { type: "array", items: { type: "string" }, description: "Array of device IDs to control.", minItems: 1 },
                    capabilityId: { type: "string", description: "Capability to set.", enum: ["onoff", "dim", "target_temperature", "locked"] },
                    newValue: {
                        oneOf: [
                            { type: "boolean", description: "For 'onoff' and 'locked' (true = locked)." },
                            { type: "number", description: "For 'dim' (0..1) and 'target_temperature' (°C)." }
                        ],
                        description: "New value for the capability."
                    },
                    expected_zone: { type: "string", description: "Zone the agent expects these devices to be in (defense-in-depth)." },
                    expected_type: { type: "string", description: "Expected device type (e.g., 'light') to prevent over-broad actions." },
                    allow_cross_zone: { type: "boolean", description: "Must be true to allow cross-zone writes.", default: false },
                    confirmed: { type: "boolean", description: "Must be true if >10 devices would change." }
                },
                required: ["deviceIds", "capabilityId", "newValue"],
                additionalProperties: false
            },
            handler: async ({ deviceIds, capabilityId, newValue, expected_zone, expected_type, allow_cross_zone, confirmed }) => {
                // S3: don't rely on the model honoring the JSON schema —
                // whitelist the capability and coerce/clamp the value in code.
                const validated = this.validateCapabilityWrite(capabilityId, newValue);
                if (!validated.ok) {
                    return { ok: false, error: { code: "INVALID_CAPABILITY_WRITE", message: validated.message } };
                }
                const value = validated.value;

                const originalCount = Array.isArray(deviceIds) ? deviceIds.length : 0;
                const uniqueIds = Array.from(new Set((deviceIds || []).filter(Boolean) as string[]));
                let filteredIds = uniqueIds;

                // Enforce type/zone narrowing if hints provided
                if (expected_type || expected_zone) {
                    const allowedIds = await this.listDeviceIdsBy(expected_zone || null, expected_type || null);
                    const allowedSet = new Set(allowedIds);
                    filteredIds = uniqueIds.filter(id => allowedSet.has(id));
                }

                // S2: cross-zone writes are opt-in ("everywhere"/"whole house").
                // Without allow_cross_zone, confine the write to one zone: the
                // verified expected_zone when given (already applied above),
                // otherwise this assistant's standard zone.
                let crossZoneBlocked = 0;
                if (allow_cross_zone !== true && !expected_zone && this.standardZone) {
                    const inZone = new Set(await this.listDeviceIdsBy(this.standardZone, null));
                    const before = filteredIds.length;
                    filteredIds = filteredIds.filter(id => inZone.has(id));
                    crossZoneBlocked = before - filteredIds.length;
                }

                const deduped = filteredIds.length;

                if (deduped === 0) {
                    if (crossZoneBlocked > 0) {
                        return { ok: false, error: { code: "CROSS_ZONE_BLOCKED", message: `All ${crossZoneBlocked} devices are outside the standard zone (${this.standardZone}). Retry with allow_cross_zone=true only if the user explicitly asked for all zones / the whole house, or pass the zone the user named as expected_zone.` } };
                    }
                    return { ok: false, error: { code: "NO_MATCHING_DEVICES_FOR_TYPE", message: "No devices match the expected type/zone for this action." } };
                }
                if (deduped > 10 && confirmed !== true) {
                    return { ok: false, error: { code: "CONFIRMATION_REQUIRED", message: `Refusing to change ${deduped} devices without explicit confirmation.` } };
                }

                // S3: unlocking is physical security — allow it for exactly ONE
                // device per call, so "unlock all doors" (or a prompt-injected
                // equivalent) can't happen in a single write. Locking in bulk
                // stays allowed. Deliberately NOT a confirmation prompt (that
                // guard was removed on purpose).
                if (capabilityId === "locked" && value === false && deduped > 1) {
                    return { ok: false, error: { code: "UNLOCK_SINGLE_DEVICE_ONLY", message: `Refusing to unlock ${deduped} devices at once. Unlock only the specific lock the user named, one call per device.` } };
                }

                this.logger.info('set_device_capability_bulk', 'TOOL', `devices=${deduped}/${originalCount}, cap=${capabilityId}, value=${value}, zone=${expected_zone}, type=${expected_type}, xzoneBlocked=${crossZoneBlocked}`);
                try {
                    const data = await this.deviceManager.setDeviceCapabilityBulk(filteredIds, capabilityId, value, { expected_zone, allow_cross_zone, confirmed });
                    return { ok: true, data, meta: { requested: originalCount, deduplicated: deduped, cross_zone_blocked: crossZoneBlocked } };
                } catch (error: any) {
                    this.logger.error(`Error executing set_device_capability_bulk`, error);
                    return { ok: false, error: { code: "BULK_SET_CAPABILITY_FAILED", message: "Could not set capability for multiple devices." } };
                }
            }
        });
    }

    private registerWeatherTools(): void {
        
        this.registerTool({
            type: "function",
            name: "get_current_weather",
            description: "Get the current weather conditions at the user's location including temperature, conditions, humidity, and wind speed.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false
            },
            handler: async () => {
                try {
                    const weather = await this.weatherHelper.getCurrentWeather();
                    return {
                        temperature: weather.temperature,
                        feels_like: weather.feelsLike,
                        conditions: weather.conditions[0]?.description || 'Unknown',
                        humidity: weather.humidity,
                        wind_speed: weather.windSpeed,
                        wind_gusts: weather.windGusts,
                        cloud_cover: weather.cloudiness,
                        uv_index: weather.uvIndex,
                        is_daylight: weather.isDaylight,
                        precipitation: weather.precipitation,
                        location: weather.location
                    };
                } catch (error: any) {
                    this.logger.error('Error getting current weather:', error);
                    return { error: 'Unable to retrieve current weather information' };
                }
            }
        });

        this.registerTool({
            type: "function", 
            name: "get_weather_forecast",
            description: "Get weather forecast for the next few days at the user's location.",
            parameters: {
                type: "object",
                properties: {
                    hours: {
                        type: "number",
                        description: "Number of hours to look ahead (optional, defaults to 24 hours)"
                    }
                },
                required: [],
                additionalProperties: false
            },
            handler: async ({ hours = 24 }) => {
                try {
                    // forecast_days counts from midnight today, so "hours from
                    // now" needs one extra day of headroom (M5).
                    const forecast = await this.weatherHelper.getForecast(false, Math.ceil(hours / 24) + 1);
                    const targetTime = new Date(Date.now() + hours * 60 * 60 * 1000);
                    
                    // Filter forecast items within the requested timeframe
                    const relevantForecasts = forecast.forecasts.filter(item => 
                        item.timestamp.getTime() <= targetTime.getTime()
                    );

                    return {
                        location: forecast.location,
                        forecasts: relevantForecasts.map(item => ({
                            time: item.timestamp.toISOString(),
                            temperature: item.temperature,
                            feels_like: item.feelsLike,
                            conditions: item.conditions[0]?.description || 'Unknown',
                            precipitation_probability: item.precipitationProbability,
                            precipitation: item.precipitation,
                            humidity: item.humidity,
                            wind_speed: item.windSpeed,
                            wind_gusts: item.windGusts,
                            uv_index: item.uvIndex,
                            is_daylight: item.isDaylight
                        }))
                    };
                } catch (error: any) {
                    this.logger.error('Error getting weather forecast:', error);
                    return { error: 'Unable to retrieve weather forecast' };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "will_it_rain",
            description: "Check if it will rain within a specified number of hours from now.",
            parameters: {
                type: "object", 
                properties: {
                    hours: {
                        type: "number",
                        description: "Number of hours from now to check for rain (default: 1 hour)"
                    }
                },
                required: [],
                additionalProperties: false
            },
            handler: async ({ hours = 1 }) => {
                try {
                    const result = await this.weatherHelper.willItRain(hours);
                    return {
                        will_rain: result.willRain,
                        probability: result.probability,
                        description: result.description,
                        timeframe: `${hours} hour${hours !== 1 ? 's' : ''} from now`
                    };
                } catch (error: any) {
                    this.logger.error('Error checking rain prediction:', error);
                    return { error: 'Unable to check rain prediction' };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "get_weather_summary", 
            description: "Get a human-readable summary of the current weather conditions including temperature, description, and location information.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false
            },
            handler: async () => {
                try {
                    const summary = await this.weatherHelper.getWeatherSummary();
                    return { summary };
                } catch (error: any) {
                    this.logger.error('Error getting weather summary:', error);
                    return { summary: 'Weather information is currently unavailable.' };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "get_outside_illumination",
            description: "Get current outside illumination and lighting conditions including solar radiation, UV index, and whether it's daylight.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false
            },
            handler: async () => {
                try {
                    const illumination = await this.weatherHelper.getOutsideIllumination();
                    return {
                        is_day: illumination.isDay,
                        is_daylight: illumination.isDaylight,
                        solar_radiation: illumination.solarRadiation,
                        direct_radiation: illumination.directRadiation,
                        diffuse_radiation: illumination.diffuseRadiation,
                        uv_index: illumination.uvIndex,
                        sun_elevation: illumination.sunElevation,
                        illumination_level: illumination.illuminationLevel,
                        description: illumination.description
                    };
                } catch (error: any) {
                    this.logger.error('Error getting outside illumination:', error);
                    return { error: 'Unable to retrieve outside illumination information' };
                }
            }
        });
    }
}
