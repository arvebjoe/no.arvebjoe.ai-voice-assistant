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

        // First, output all zones
        const processZoneHierarchy = (zoneId) => {
            const zone = zones[zoneId];
            const simpleId = this.getSimpleZoneId(zone.id);
            const parentId = zone.parent ? this.getSimpleZoneId(zone.parent) : '';
            
            output.push(`Z|${zone.name}|${simpleId}|${parentId}`);

            // Process child zones
            Object.values(zones)
                .filter(z => z.parent === zoneId)
                .forEach(childZone => processZoneHierarchy(childZone.id));
        };

        // Output all zones first
        Object.values(zones)
            .filter(zone => !zone.parent)
            .forEach(zone => processZoneHierarchy(zone.id));

        // Then output all devices with their capabilities
        const deviceList = Object.values(devices).map(dev => {
            const zoneId = this.getSimpleZoneId(dev.zone);
            const capabilities = dev.capabilities
                .filter(capId => CAPABILITIES_OF_INTEREST.includes(capId))
                .map(capId => {
                    const capObj = dev.capabilitiesObj[capId];
                    return `${capId}=${capObj?.value}`;
                })
                .filter(cap => cap);

            return {
                name: dev.name,
                id: dev.id,
                type: dev.class,
                zoneId,
                capabilities
            };
        }).filter(dev => dev.capabilities.length > 0);

        // Sort devices by zoneId then by name
        deviceList.sort((a, b) => {
            // First sort by zoneId
            if (a.zoneId !== b.zoneId) {
                return parseInt(a.zoneId) - parseInt(b.zoneId);
            }
            // Then by device name
            return a.name.localeCompare(b.name);
        });

        // Add sorted devices to output
        deviceList.forEach(dev => {
            output.push(`D|${dev.name}|${dev.id}|${dev.type}|${dev.zoneId}|${dev.capabilities.join('|')}`);
        });

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