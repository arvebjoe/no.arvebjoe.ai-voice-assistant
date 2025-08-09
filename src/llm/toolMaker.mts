import { tool } from '@openai/agents';
import * as z from 'zod';
import { DeviceManager } from '../helpers/device-manager.mjs';
import { createLogger } from '../helpers/logger.mjs';

const log = createLogger('TOOL_MAKER');

// Define an interface for the tools collection
interface ToolCollection {
    getWeatherTool: ReturnType<typeof tool>;
    historyFunFact: ReturnType<typeof tool>;
    getZones: ReturnType<typeof tool>;
    getAllDeviceTypes: ReturnType<typeof tool>;
    setDeviceCapability: ReturnType<typeof tool>;
    setDeviceCapabilityBulk: ReturnType<typeof tool>;
    getSmartHomeDevices: ReturnType<typeof tool>;
    getTime: ReturnType<typeof tool>;
}

export class ToolMaker {
    private deviceManager: DeviceManager;

    constructor(deviceManager: DeviceManager) {
        this.deviceManager = deviceManager;
    }

    createTools(): ToolCollection {

        const getZones = tool({
            name: 'get_zones',
            description: 'Get a list of all zones',
            parameters: z.object({}),
            execute: async () => {
                log.info('Executing getZones tool...');
                return this.deviceManager.getZones();
            },
        });

        const getAllDeviceTypes = tool({
            name: 'get_all_device_types',
            description: 'Get all device types available',
            parameters: z.object({}),
            execute: async () => {
                log.info('Executing getAllDeviceTypes tool...');
                return this.deviceManager.getAllDeviceTypes();
            },
        });

        const setDeviceCapability = tool({
            name: 'set_device_capability',
            description: 'Set a capability value for a device',
            parameters: z.object({
                deviceId: z.string(),
                capabilityId: z.string(),
                newValue: z.union([z.string(), z.number(), z.boolean()]),
            }),
            execute: async ({ deviceId, capabilityId, newValue }) => {
                log.info(`Executing setDeviceCapability tool for device ${deviceId}, capability ${capabilityId}, value ${newValue}`);
                return this.deviceManager.setDeviceCapability(deviceId, capabilityId, newValue);
            },
        });


        const setDeviceCapabilityBulk = tool({
            name: 'set_device_capability_bulk',
            description: 'Set a capability value for multiple devices',
            parameters: z.object({
                deviceIds: z.array(z.string()),
                capabilityId: z.string(),
                newValue: z.union([z.string(), z.number(), z.boolean()]),
            }),
            execute: async ({ deviceIds, capabilityId, newValue }) => {
                log.info(`Executing setDeviceCapabilityBulk tool for devices ${deviceIds.join(', ')}.`);
                log.info(`Capability ${capabilityId} = value ${newValue}`);
                return this.deviceManager.setDeviceCapabilityBulk(deviceIds, capabilityId, newValue);
            },
        });

        const getSmartHomeDevices = tool({
            name: 'get_smart_home_devices',
            description: 'Get smart home devices in a specific zone and type',
            parameters: z.object({
                zone: z.string().optional().nullable(),
                type: z.string().optional().nullable(),
                page_size: z.number().optional().nullable(),
                page_token: z.string().optional().nullable(),
            }),
            execute: async ({ zone, type, page_size, page_token }) => {
                log.info(`Executing getSmartHomeDevices tool for zone ${zone}, type ${type}, page_size ${page_size}, page_token ${page_token}`);
                // Handle nullable values properly to match DeviceManager's interface
                const zoneSafe = zone || undefined;
                const typeSafe = type || undefined;
                const pageSizeSafe = page_size || undefined;
                const pageTokenSafe = page_token || null;

                return this.deviceManager.getSmartHomeDevices(zoneSafe, typeSafe, pageSizeSafe, pageTokenSafe);
            },
        });

        const getTime = tool({
            name: 'get_time',
            description: 'Get the current time in a specific timezone',
            parameters: z.object({
                timezone: z.string().optional().default('Europe/Oslo'),
            }),
            execute: async ({ timezone }) => {
                const now = new Date().toLocaleString('no-NO', { timeZone: timezone });
                log.info(`Executing get_time tool for timezone: ${timezone}`);
                return `The current time in ${timezone} is ${now}.`;
            },
        });

        const getWeatherTool = tool({
            name: 'get_weather',
            description: 'Get the weather for a given city',
            parameters: z.object({ city: z.string() }),
            async execute({ city }) {
                log.info(`Executing get_weather tool for city: ${city}`);
                return `The weather in ${city} is sunny.`;
            },
        });

        const historyFunFact = tool({
            // The name of the tool will be used by the agent to tell what tool to use.
            name: 'history_fun_fact',
            // The description is used to describe **when** to use the tool by telling it **what** it does.
            description: 'Give a fun fact about a historical event',
            // This tool takes no parameters, so we provide an empty Zod Object.
            parameters: z.object({}),
            execute: async () => {
                log.info('Executing history fun fact tool...');
                // The output will be returned back to the Agent to use
                return 'Sharks are older than trees.';
            },
        });



        return {
            getWeatherTool,
            historyFunFact,
            getZones,
            getAllDeviceTypes,
            setDeviceCapability,
            setDeviceCapabilityBulk,
            getSmartHomeDevices,
            getTime
        };
    }
}