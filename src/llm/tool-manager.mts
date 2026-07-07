import { EventEmitter } from "events";
import { TypedEmitter } from "tiny-typed-emitter";
import { DeviceManager } from '../helpers/device-manager.mjs';
import { WeatherHelper } from '../helpers/weather-helper.mjs';
import { createLogger } from '../helpers/logger.mjs';
import { GeoHelper } from "../helpers/geo-helper.mjs";
import { settingsManager } from "../settings/settings-manager.mjs";
import { TimerManager } from "../voice_assistant/timer-manager.mjs";

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
        this.registerWeatherTools();
        if (this.timerManager) {
            this.registerTimerTools();
        }
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
                            "look up devices and read sensor values (temperature, humidity, motion, etc.); report the current weather and the forecast for the home's location; " +
                            "tell the current local time and date; " +
                            (this.timerManager ? "set, check and cancel a countdown timer or alarm on the voice device; " : "") +
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
