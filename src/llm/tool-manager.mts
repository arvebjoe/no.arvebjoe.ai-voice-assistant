import { EventEmitter } from "events";
import { TypedEmitter } from "tiny-typed-emitter";
import { DeviceManager } from '../helpers/device-manager.mjs';
import { WeatherHelper } from '../helpers/weather-helper.mjs';
import { JobManager } from '../helpers/job-manager.mjs';
import { createLogger } from '../helpers/logger.mjs';
import { GeoHelper } from "../helpers/geo-helper.mjs";
import { settingsManager } from "../settings/settings-manager.mjs";

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
    private jobManager: JobManager;
    private tools: Map<string, ToolDefinition> = new Map();
    private logger = createLogger('ToolManager', true);
    private standardZone: string;

    constructor(homey: any, standardZone: string, deviceManager: DeviceManager, geoHelper: GeoHelper, weatherHelper: WeatherHelper, jobManager: JobManager) {
        super();
        this.homey = homey;
        this.deviceManager = deviceManager;
        this.standardZone = standardZone;
        this.geoHelper = geoHelper;
        this.weatherHelper = weatherHelper;
        this.jobManager = jobManager;
        this.registerDefaultTools();
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

    private registerDefaultTools(): void {
        this.registerSystemTools();
        this.registerDeviceManagementTools();
        this.registerWeatherTools();
        this.registerJobManagementTools();
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
                    capabilityId: { type: "string", description: "Capability to set.", enum: ["onoff", "dim", "target_temperature"] },
                    newValue: {
                        oneOf: [
                            { type: "boolean", description: "For 'onoff'." },
                            { type: "number", description: "For 'dim' (0..1) and 'target_temperature' (°C)." }
                        ],
                        description: "New value for the capability."
                    },
                    expected_zone: { type: "string", description: "Zone the agent expects these devices to be in (defense-in-depth)." },
                    expected_type: { type: "string", description: "Expected device type (e.g., 'light') to prevent over-broad actions." },
                    allow_cross_zone: { type: "boolean", description: "Must be true to allow cross-zone writes.", default: false },
                    confirmed: { type: "boolean", description: "Must be true if >10 devices or security-sensitive actions." }
                },
                required: ["deviceIds", "capabilityId", "newValue"],
                additionalProperties: false
            },
            handler: async ({ deviceIds, capabilityId, newValue, expected_zone, expected_type, allow_cross_zone, confirmed }) => {
                const originalCount = Array.isArray(deviceIds) ? deviceIds.length : 0;
                const uniqueIds = Array.from(new Set((deviceIds || []).filter(Boolean) as string[]));
                let filteredIds = uniqueIds;

                // Enforce type/zone narrowing if hints provided
                if (expected_type || expected_zone) {
                    const allowedIds = await this.listDeviceIdsBy(expected_zone || null, expected_type || null);
                    const allowedSet = new Set(allowedIds);
                    filteredIds = uniqueIds.filter(id => allowedSet.has(id));
                }

                const deduped = filteredIds.length;

                if (deduped === 0) {
                    return { ok: false, error: { code: "NO_MATCHING_DEVICES_FOR_TYPE", message: "No devices match the expected type/zone for this action." } };
                }
                if (deduped > 10 && confirmed !== true) {
                    return { ok: false, error: { code: "CONFIRMATION_REQUIRED", message: `Refusing to change ${deduped} devices without explicit confirmation.` } };
                }

                this.logger.info('set_device_capability_bulk', 'TOOL', `devices=${deduped}/${originalCount}, cap=${capabilityId}, value=${newValue}, zone=${expected_zone}, type=${expected_type}`);
                try {
                    const data = await this.deviceManager.setDeviceCapabilityBulk(filteredIds, capabilityId, newValue, { expected_zone, allow_cross_zone, confirmed });
                    return { ok: true, data, meta: { requested: originalCount, deduplicated: deduped } };
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
                    const forecast = await this.weatherHelper.getForecast();
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

    private registerJobManagementTools(): void {
        this.registerTool({
            type: "function",
            name: "create_scheduled_job",
            description: "Create a new scheduled job to execute an action at a later time. The agent should parse the user's request to understand WHEN, WHAT, and HOW to execute the task.",
            parameters: {
                type: "object",
                properties: {
                    scheduledTime: {
                        type: "string",
                        description: "When to execute the job as an ISO date string (e.g., '2025-09-17T07:00:00.000Z')"
                    },
                    instruction: {
                        type: "string", 
                        description: "Natural language instruction for what the agent should do when the job executes"
                    },
                    parsedDetails: {
                        type: "object",
                        description: "Pre-parsed details about the action (optional)",
                        properties: {
                            deviceIds: {
                                type: "array",
                                items: { type: "string" },
                                description: "Device IDs if the job involves specific devices"
                            },
                            capability: {
                                type: "string",
                                description: "Device capability to change (e.g., 'onoff', 'dim')"
                            },
                            value: {
                                description: "Value to set for the capability"
                            },
                            zone: {
                                type: "string",
                                description: "Zone name if the job is zone-specific"
                            },
                            action: {
                                type: "string",
                                description: "Action type (e.g., 'turn_on', 'turn_off', 'set_temperature')"
                            }
                        },
                        additionalProperties: true
                    },
                    repeat: {
                        type: "object",
                        description: "Repeat configuration for recurring jobs",
                        properties: {
                            isRepeating: {
                                type: "boolean",
                                description: "Whether this job should repeat"
                            },
                            pattern: {
                                type: "string",
                                description: "Repeat pattern: 'daily', 'weekly', 'weekdays', 'monthly'"
                            },
                            daysOfWeek: {
                                type: "array",
                                items: { type: "number", minimum: 0, maximum: 6 },
                                description: "Days of week for weekly repeats (0=Sunday, 6=Saturday)"
                            },
                            endDate: {
                                type: "string",
                                description: "End date for repeating jobs (ISO string)"
                            }
                        },
                        additionalProperties: false
                    },
                    output: {
                        type: "object",
                        description: "Output/feedback configuration",
                        properties: {
                            shouldNotify: {
                                type: "boolean",
                                description: "Should the agent provide feedback when the job completes?"
                            },
                            message: {
                                type: "string", 
                                description: "Custom message to say when completed (optional)"
                            },
                            type: {
                                type: "string",
                                enum: ["voice", "text", "silent"],
                                description: "Type of feedback to provide"
                            }
                        },
                        additionalProperties: false
                    },
                    sender: {
                        type: "object",
                        description: "Information about who/what created this job",
                        properties: {
                            agentId: {
                                type: "string",
                                description: "Identifier for the agent creating this job"
                            },
                            sessionId: {
                                type: "string",
                                description: "Session identifier for callback (optional)"
                            },
                            userId: {
                                type: "string", 
                                description: "User identifier (optional)"
                            }
                        },
                        required: ["agentId"],
                        additionalProperties: false
                    }
                },
                required: ["scheduledTime", "instruction", "sender"],
                additionalProperties: false
            },
            handler: async ({ scheduledTime, instruction, parsedDetails, repeat, output, sender }) => {
                try {
                    const job = this.jobManager.createJob({
                        scheduledTime: new Date(scheduledTime),
                        instruction,
                        parsedDetails,
                        repeat,
                        output,
                        sender
                    });

                    return {
                        ok: true,
                        data: {
                            jobId: job.id,
                            scheduledTime: job.scheduledTime.toISOString(),
                            instruction: job.instruction,
                            status: job.metadata.status,
                            isRepeating: job.repeat.isRepeating
                        }
                    };
                } catch (error: any) {
                    this.logger.error('Error creating scheduled job:', error);
                    return {
                        ok: false,
                        error: {
                            code: "JOB_CREATION_FAILED",
                            message: "Could not create scheduled job: " + error.message
                        }
                    };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "list_scheduled_jobs",
            description: "Get a list of scheduled jobs, optionally filtered by status or sender.",
            parameters: {
                type: "object",
                properties: {
                    status: {
                        type: "string",
                        enum: ["pending", "running", "completed", "failed", "cancelled"],
                        description: "Filter jobs by status (optional)"
                    },
                    agentId: {
                        type: "string",
                        description: "Filter jobs by agent/sender ID (optional)"
                    },
                    sessionId: {
                        type: "string",
                        description: "Filter jobs by session ID (optional)"
                    }
                },
                required: [],
                additionalProperties: false
            },
            handler: async ({ status, agentId, sessionId }) => {
                try {
                    let jobs;
                    
                    if (status) {
                        jobs = this.jobManager.getJobsByStatus(status);
                    } else if (agentId) {
                        jobs = this.jobManager.getJobsBySender(agentId, sessionId);
                    } else {
                        jobs = this.jobManager.getAllJobs();
                    }

                    const jobList = jobs.map(job => ({
                        id: job.id,
                        scheduledTime: job.scheduledTime.toISOString(),
                        instruction: job.instruction,
                        status: job.metadata.status,
                        isRepeating: job.repeat.isRepeating,
                        nextExecution: job.metadata.nextExecution?.toISOString(),
                        createdAt: job.metadata.createdAt.toISOString(),
                        attempts: job.metadata.attempts,
                        lastError: job.metadata.lastError
                    }));

                    return {
                        ok: true,
                        data: {
                            jobs: jobList,
                            count: jobList.length
                        }
                    };
                } catch (error: any) {
                    this.logger.error('Error listing scheduled jobs:', error);
                    return {
                        ok: false,
                        error: {
                            code: "JOB_LIST_FAILED",
                            message: "Could not retrieve scheduled jobs: " + error.message
                        }
                    };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "delete_scheduled_job",
            description: "Delete a scheduled job by its ID.",
            parameters: {
                type: "object",
                properties: {
                    jobId: {
                        type: "string",
                        description: "The ID of the job to delete"
                    }
                },
                required: ["jobId"],
                additionalProperties: false
            },
            handler: async ({ jobId }) => {
                try {
                    const success = this.jobManager.deleteJob(jobId);
                    
                    if (success) {
                        return {
                            ok: true,
                            data: {
                                message: `Job ${jobId} has been deleted successfully`
                            }
                        };
                    } else {
                        return {
                            ok: false,
                            error: {
                                code: "JOB_NOT_FOUND",
                                message: `Job ${jobId} was not found`
                            }
                        };
                    }
                } catch (error: any) {
                    this.logger.error('Error deleting scheduled job:', error);
                    return {
                        ok: false,
                        error: {
                            code: "JOB_DELETE_FAILED",
                            message: "Could not delete scheduled job: " + error.message
                        }
                    };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "get_job_details",
            description: "Get detailed information about a specific scheduled job.",
            parameters: {
                type: "object",
                properties: {
                    jobId: {
                        type: "string",
                        description: "The ID of the job to get details for"
                    }
                },
                required: ["jobId"],
                additionalProperties: false
            },
            handler: async ({ jobId }) => {
                try {
                    const job = this.jobManager.getJob(jobId);
                    
                    if (job) {
                        return {
                            ok: true,
                            data: {
                                id: job.id,
                                scheduledTime: job.scheduledTime.toISOString(),
                                instruction: job.instruction,
                                parsedDetails: job.parsedDetails,
                                repeat: job.repeat,
                                output: job.output,
                                sender: job.sender,
                                metadata: {
                                    ...job.metadata,
                                    createdAt: job.metadata.createdAt.toISOString(),
                                    lastExecuted: job.metadata.lastExecuted?.toISOString(),
                                    nextExecution: job.metadata.nextExecution?.toISOString()
                                }
                            }
                        };
                    } else {
                        return {
                            ok: false,
                            error: {
                                code: "JOB_NOT_FOUND",
                                message: `Job ${jobId} was not found`
                            }
                        };
                    }
                } catch (error: any) {
                    this.logger.error('Error getting job details:', error);
                    return {
                        ok: false,
                        error: {
                            code: "JOB_DETAILS_FAILED",
                            message: "Could not retrieve job details: " + error.message
                        }
                    };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "parse_schedule_time",
            description: "Parse natural language time expressions into proper datetime for scheduling. Use this to convert user time expressions like 'tomorrow at 7am' or 'in 2 hours' into schedulable dates.",
            parameters: {
                type: "object",
                properties: {
                    timeExpression: {
                        type: "string",
                        description: "Natural language time expression (e.g., 'tomorrow at 7:00', 'in 1 hour', 'next Monday at 9am')"
                    }
                },
                required: ["timeExpression"],
                additionalProperties: false
            },
            handler: async ({ timeExpression }) => {
                try {
                    const parsedDate = this.jobManager.parseTimeExpression(timeExpression);
                    
                    if (parsedDate) {
                        return {
                            ok: true,
                            data: {
                                originalExpression: timeExpression,
                                parsedDateTime: parsedDate.toISOString(),
                                localTime: parsedDate.toLocaleString('en-US', {
                                    timeZone: this.geoHelper.timezone || 'Europe/Oslo'
                                }),
                                isValid: true
                            }
                        };
                    } else {
                        return {
                            ok: false,
                            error: {
                                code: "TIME_PARSE_FAILED",
                                message: `Could not parse time expression: "${timeExpression}"`
                            }
                        };
                    }
                } catch (error: any) {
                    this.logger.error('Error parsing schedule time:', error);
                    return {
                        ok: false,
                        error: {
                            code: "TIME_PARSE_ERROR",
                            message: "Error parsing time expression: " + error.message
                        }
                    };
                }
            }
        });

        this.registerTool({
            type: "function",
            name: "get_job_stats",
            description: "Get statistics about all scheduled jobs (count by status).",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false
            },
            handler: async () => {
                try {
                    const stats = this.jobManager.getJobStats();
                    return {
                        ok: true,
                        data: stats
                    };
                } catch (error: any) {
                    this.logger.error('Error getting job statistics:', error);
                    return {
                        ok: false,
                        error: {
                            code: "JOB_STATS_FAILED",
                            message: "Could not retrieve job statistics: " + error.message
                        }
                    };
                }
            }
        });
    }
}
