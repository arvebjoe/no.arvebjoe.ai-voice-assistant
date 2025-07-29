const { HomeyAPI } = require('homey-api');
const { createLogger } = require('./logger');

const log = createLogger('DeviceManager');

// List of capabilities we're interested in
const CAPABILITIES_OF_INTEREST = [
    'dim',
    'onoff',
    'light_temperature',
    'volume_down',
    'volume_up',
    'light_hue',
    'light_saturation',
    'light_mode',
    'measure_battery',
    'measure_temperature',
    'alarm_motion',
    'alarm_fire',
    'measure_humidity',
    'measure_luminance',
    'homealarm_state',
    'locked',
    'target_temperature',
    'thermostat_mode',
    'thermostat_mode_single',
    'thermostat_state',
    'alarm_water',
    'volume_set',
    'volume_mute'
];

/*
PROMT:

# Home Automation Data Format

I will provide you with my home's current state in this format:

## Line Formats
Z|ZoneName|ZoneId|ParentZoneId         # Defines a zone and its parent
D|DeviceName|DeviceId|readonly_cap=val  # Device with optional readonly capabilities
C|CapabilityId|Value                    # Writable capability of the previous device

## Capabilities
- onoff: boolean (true/false) for power state
- dim: number (0-1) for brightness
- light_temperature: number (0-1) for warm/cold
- light_hue: number (0-1) for color
- light_saturation: number (0-1) for color intensity
- light_mode: string (color/temperature)
- measure_battery: readonly number (0-100)
- measure_temperature: readonly number
- alarm_motion: readonly boolean
- locked: boolean for locks
- volume_set: number (0-1)
- volume_mute: boolean

## Response Format
When I ask you to make changes, respond with a JSON array of actions:
```json
{
    "actions": [
        {
            "deviceId": "device-guid-here",
            "capability": "capability-name",
            "value": new-value
        }
    ]
}
```

Example: "Turn off all lights in the kitchen" should return a JSON with actions for each light device in the kitchen zone.


*/


class DeviceManager {

    constructor(homey) {
        this.homey = homey;
        this.api = null;
        this.zoneIdMap = new Map(); // Map GUID to simple ID
        this.nextZoneId = 1;        // Counter for generating simple IDs        
    }

    async init() {
        this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
    }

    getSimpleZoneId(guid) {
        if (!this.zoneIdMap.has(guid)) {
            this.zoneIdMap.set(guid, this.nextZoneId.toString());
            this.nextZoneId++;
        }
        return this.zoneIdMap.get(guid);
    }

    async FetchAllDevices() {
        if (!this.api) {
            throw new Error('Homey API not initialized. Call init() first.');
        }

        const [devices, zones] = await Promise.all([
            this.api.devices.getDevices(),
            this.api.zones.getZones(),
        ]);

        let output = [];
        
        // Reset counters for new fetch
        this.zoneIdMap.clear();
        this.nextZoneId = 1;

        const processZone = (zoneId) => {
            const zone = zones[zoneId];
            const simpleId = this.getSimpleZoneId(zone.id);
            const parentId = zone.parent ? this.getSimpleZoneId(zone.parent) : '';
            
            // Add zone line with simplified IDs
            output.push(`Z|${zone.name}|${simpleId}|${parentId}`);

            // Process devices (unchanged)
            const zoneDevices = Object.values(devices).filter(d => d.zone === zoneId);
            for (const dev of zoneDevices) {
                // Get read-only capabilities first
                const readOnlyCaps = dev.capabilities
                    .filter(capId => CAPABILITIES_OF_INTEREST.includes(capId))
                    .filter(capId => dev.capabilitiesObj[capId]?.setable === false)
                    .map(capId => `${capId}=${dev.capabilitiesObj[capId]?.value}`);

                // Add device line with read-only capabilities
                output.push(`D|${dev.name}|${dev.id}|${dev.class}|${readOnlyCaps.length ? '|' + readOnlyCaps.join('|') : ''}`);

                // Add writable capabilities
                dev.capabilities
                    .filter(capId => CAPABILITIES_OF_INTEREST.includes(capId))
                    .filter(capId => dev.capabilitiesObj[capId]?.setable !== false)
                    .forEach(capId => {
                        output.push(`C|${capId}|${dev.capabilitiesObj[capId]?.value}`);
                    });
            }

            // Process child zones
            Object.values(zones)
                .filter(z => z.parent === zoneId)
				.forEach(childZone => processZone(childZone.id));
        };

        // Start with root zones
        Object.values(zones)
            .filter(zone => !zone.parent)
            .forEach(zone => processZone(zone.id));

        return output.join('\n');
    }

    async PerformActions(actions) {
        if (!this.api) {
            throw new Error('Homey API not initialized. Call init() first.');
        }

        const results = [];
        for (const action of actions) {
            try {
                //const device = await this.api.devices.getDevice({ id: action.deviceId });
                //if (!device) {
                //    throw new Error(`Device ${action.deviceId} not found`);
                //}
                //await device.setCapabilityValue(action.capability, action.value);
                await this.api.devices.setCapabilityValue({
                    deviceId: action.deviceId,
                    capabilityId: action.capability,
                    value: action.value,
                }); 

                results.push({ success: true, action });
            } catch (error) {
                log.error(`Failed to perform action ${JSON.stringify(action)}:`, error);
                results.push({ success: false, action, error: error.message });
            }
        }
        return results;
    }
}

module.exports = {
    DeviceManager: DeviceManager
};