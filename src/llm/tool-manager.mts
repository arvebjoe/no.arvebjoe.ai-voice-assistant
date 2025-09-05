import { EventEmitter } from "events";
import { TypedEmitter } from "tiny-typed-emitter";
import { DeviceManager } from '../helpers/device-manager.mjs';
import { createLogger } from '../helpers/logger.mjs';

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

type ToolManagerEvents = {    
    //continue_conversation: () => void;    // Didn't need this after all. Kept is in case i need events in the future.
}

export class ToolManager extends (EventEmitter as new () => TypedEmitter<ToolManagerEvents>) {
    private homey: any;
    private deviceManager: DeviceManager;
    private tools: Map<string, ToolDefinition> = new Map();
    private logger = createLogger('ToolManage', true);

    constructor(homey: any, deviceManager: DeviceManager) {
        super();

        this.homey = homey;
        this.deviceManager = deviceManager;
        this.registerDefaultTools();
    }

    /**
     * Register a new tool with both its definition and handler
     */
    registerTool(definition: ToolDefinition): void {
        this.logger.info(definition.name, "REGISTER TOOL");
        this.tools.set(definition.name, definition);
    }

    /**
     * Get all tool handlers for execution
     */
    getToolHandlers(): Record<string, ToolHandler> {
        const handlers: Record<string, ToolHandler> = {};
        for (const [name, tool] of this.tools) {
            handlers[name] = tool.handler;
        }
        return handlers;
    }

    /**
     * Get tool definitions in OpenAI format (without handlers)
     */
    getToolDefinitions(): Array<Omit<ToolDefinition, 'handler'>> {
        return Array.from(this.tools.values()).map(tool => ({
            type: tool.type,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        }));
    }

    /**
     * Get a specific tool definition by name
     */
    getToolDefinition(name: string): Omit<ToolDefinition, 'handler'> | undefined {
        const tool = this.tools.get(name);
        if (!tool) return undefined;

        return {
            type: tool.type,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        };
    }

    /**
     * Check if a tool exists
     */
    hasTool(name: string): boolean {
        return this.tools.has(name);
    }

    /**
     * Get all tool names
     */
    getToolNames(): string[] {
        return Array.from(this.tools.keys());
    }

    private registerDefaultTools(): void {

        
        // get_local_time tool
        this.registerTool({
            type: "function",
            name: "get_local_time",
            description: "Get the local time for a given IANA timezone or city name (default Europe/Oslo).",
            parameters: {
                type: "object",
                properties: {
                    timezone: {
                        type: "string",
                        description: "IANA timezone like 'Europe/Oslo'. If omitted, use Europe/Oslo.",
                    },
                    locale: {
                        type: "string",
                        description: "BCP-47 locale, default 'nb-NO'.",
                    },
                },
                required: [],
                additionalProperties: false,
            },
            handler: ({ timezone, locale }) => {
                const tz = (timezone as string) || "Europe/Oslo";
                const loc = (locale as string) || "nb-NO";
                const now = new Date();
                try {
                    const fmt = new Intl.DateTimeFormat(loc, {
                        timeZone: tz,
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        weekday: "long",
                        day: "2-digit",
                        month: "long",
                        year: "numeric",
                    });
                    const s = fmt.format(now);
                    return { text: `The time is ${s} in ${tz}.` };
                } catch (error: any) {
                    return {
                        text: `Could not interpret timezone '${tz}'.`,
                        error: error?.message ?? "Unknown error"
                    };
                }
            }
        });


        // Smart Home Tools - migrated from toolMaker.mts

        // get_zones tool
        this.registerTool({
            type: "function",
            name: "get_zones",
            description: "Get a list of all zones",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
            },
            handler: async () => {
                this.logger.info('get_zones', 'TOOL', 'Executing getZones tool...');
                try {
                    return await this.deviceManager.getZones();
                } catch (error: any) {
                    this.logger.error(`Error executing getZones tool`, error);
                    return {
                        text: `Could not retrieve zones.`,
                        error: error?.message ?? "Unknown error"
                    };
                }
            }
        });

        // get_all_device_types tool
        this.registerTool({
            type: "function",
            name: "get_all_device_types",
            description: "Get all device types available",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
            },
            handler: async () => {
                this.logger.info('get_all_device_types', 'TOOL', 'Executing getAllDeviceTypes tool...');
                try {
                    return await this.deviceManager.getAllDeviceTypes();
                } catch (error: any) {
                    this.logger.error(`Error executing getAllDeviceTypes tool`, error);
                    return {
                        text: `Could not retrieve device types.`,
                        error: error?.message ?? "Unknown error"
                    };
                }
            }
        });

        // set_device_capability tool
        this.registerTool({
            type: "function",
            name: "set_device_capability",
            description: "Set a capability value for a device",
            parameters: {
                type: "object",
                properties: {
                    deviceId: {
                        type: "string",
                        description: "The ID of the device to control",
                    },
                    capabilityId: {
                        type: "string",
                        description: "The capability to set (e.g., 'onoff', 'dim', 'temperature')",
                    },
                    newValue: {
                        type: ["string", "number", "boolean"],
                        description: "The new value to set for the capability",
                    },
                },
                required: ["deviceId", "capabilityId", "newValue"],
                additionalProperties: false,
            },
            handler: async ({ deviceId, capabilityId, newValue }) => {
                this.logger.info('set_device_capability', 'TOOL', `Executing setDeviceCapability tool for device ${deviceId}, capability ${capabilityId}, value ${newValue}`);
                try {
                    return await this.deviceManager.setDeviceCapability(deviceId, capabilityId, newValue);
                } catch (error: any) {
                    this.logger.error(`Error executing setDeviceCapability tool`, error);
                    return {
                        text: `Could not set device capability.`,
                        error: error?.message ?? "Unknown error"
                    };
                }
            }
        });

        // set_device_capability_bulk tool
        this.registerTool({
            type: "function",
            name: "set_device_capability_bulk",
            description: "Set a capability value for MANY devices at once. Use this when the user says 'all', 'every', or when 2+ devices need the same change.",
            parameters: {
                type: "object",
                properties: {
                    deviceIds: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Array of device IDs to control",
                    },
                    capabilityId: {
                        type: "string",
                        description: "The capability to set (e.g., 'onoff', 'dim', 'temperature')",
                    },
                    newValue: {
                        type: ["string", "number", "boolean"],
                        description: "The new value to set for the capability",
                    },
                },
                required: ["deviceIds", "capabilityId", "newValue"],
                additionalProperties: false,
            },
            handler: async ({ deviceIds, capabilityId, newValue }) => {
                this.logger.info('set_device_capability_bulk', 'TOOL', `Executing setDeviceCapabilityBulk tool for ${deviceIds.length} devices. Capability ${capabilityId} = value ${newValue}`);
                try {
                    return await this.deviceManager.setDeviceCapabilityBulk(deviceIds, capabilityId, newValue);
                } catch (error: any) {
                    this.logger.error(`Error executing setDeviceCapabilityBulk tool`, error);
                    return {
                        text: `Could not set device capability for multiple devices.`,
                        error: error?.message ?? "Unknown error"
                    };
                }
            }
        });

        // get_smart_home_devices tool
        this.registerTool({
            type: "function",
            name: "get_smart_home_devices",
            description: "Get smart home devices in a specific zone and type",
            parameters: {
                type: "object",
                properties: {
                    zone: {
                        type: "string",
                        description: "Zone name to filter devices (optional)",
                    },
                    type: {
                        type: "string",
                        description: "Device type to filter devices (optional)",
                    },
                    page_size: {
                        type: "number",
                        description: "Number of devices to return per page (optional)",
                    },
                    page_token: {
                        type: "string",
                        description: "Token for pagination (optional)",
                    },
                },
                required: [],
                additionalProperties: false,
            },
            handler: async ({ zone, type, page_size, page_token }) => {
                this.logger.info('get_smart_home_devices', 'TOOL', `Executing getSmartHomeDevices tool for zone ${zone}, type ${type}, page_size ${page_size}, page_token ${page_token}`);

                // Handle optional values properly to match DeviceManager's interface
                const zoneSafe = zone || undefined;
                const typeSafe = type || undefined;
                const pageSizeSafe = page_size || undefined;
                const pageTokenSafe = page_token || null;

                try {
                    return await this.deviceManager.getSmartHomeDevices(zoneSafe, typeSafe, pageSizeSafe, pageTokenSafe);
                } catch (error: any) {
                    this.logger.error(`Error executing getSmartHomeDevices tool`, error);
                    return {
                        text: `Could not retrieve smart home devices.`,
                        error: error?.message ?? "Unknown error"
                    };
                }
            }
        });

    }
}
