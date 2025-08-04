const { tool } = require('@openai/agents');
const z = require('zod');

class Toolmaker {
    constructor(deviceManager) {
        this.deviceManager = deviceManager;     
    }

    createTools() {

        const getZones = tool({
            name: 'get_zones',
            description: 'Get a list of all zones',
            parameters: z.object({}),
            execute: async () => {
                console.log('Executing getZones tool...');
                return this.deviceManager.getZones();
            },
        });

        const getAllDeviceTypes = tool({
            name: 'get_all_device_types',
            description: 'Get all device types available',
            parameters: z.object({}),
            execute: async () => {
                console.log('Executing getAllDeviceTypes tool...');
                return this.deviceManager.getAllDeviceTypes();
            },
        });

        const setDeviceCapability = tool({
            name: 'set_device_capability',
            description: 'Set a capability value for a device',
            parameters: z.object({
                deviceId: z.string(),
                capabilityId: z.string(),
                newValue: z.string(), 
            }),
            execute: async ({ deviceId, capabilityId, newValue }) => {
                console.log(`Executing setDeviceCapability tool for device ${deviceId}, capability ${capabilityId}, value ${newValue}`);
                return this.deviceManager.setDeviceCapability(deviceId, capabilityId, newValue);
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
                console.log(`Executing getSmartHomeDevices tool for zone ${zone}, type ${type}, page_size ${page_size}, page_token ${page_token}`);
                return this.deviceManager.getSmartHomeDevices(zone, type, page_size, page_token);
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
                console.log(`Executing get_time tool for timezone: ${timezone}`);
                return `The current time in ${timezone} is ${now}.`;
            },
        });

        const getWeatherTool = tool({
            name: 'get_weather',
            description: 'Get the weather for a given city',
            parameters: z.object({ city: z.string() }),
            async execute({ city }) {
                console.log(`Executing get_weather tool for city: ${city}`);
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
                console.log('Executing history fun fact tool...');
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
            getSmartHomeDevices,
            getTime
        };
    }

}



module.exports = Toolmaker;