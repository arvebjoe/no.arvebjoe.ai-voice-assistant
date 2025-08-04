// Using require for HomeyAPI as it might not have TypeScript typings
const { HomeyAPI } = require('homey-api');
import { createLogger } from './logger';

// Type definitions
interface Device {
    id: string;
    name: string;
    zone: string;
    class: string;
    capabilities: string[];
    capabilitiesObj: {
        [key: string]: {
            value: any;
            [key: string]: any;
        };
    };
    [key: string]: any;
}

interface Zone {
    id: string;
    name: string;
    parent: string | null;
    [key: string]: any;
}

interface DevicesCollection {
    [deviceId: string]: Device;
}

interface ZonesCollection {
    [zoneId: string]: Zone;
}

interface SimplifiedDevice {
    id: string;
    name: string;
    zone: string[];
    type: string;
    capabilities: string[];
}

interface PaginatedDevices {
    devices: SimplifiedDevice[];
    next_page_token: string | null;
}

const log = createLogger('DeviceManager');



class DeviceManager {
    private homey: any;
    private api: any;
    private devices: DevicesCollection | null;
    private zones: ZonesCollection | null;

    constructor(homey: any) {
        this.homey = homey;
        this.api = null;
        this.devices = null;
        this.zones = null;
    }

    async init(): Promise<void> {
        this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
        log.info('DeviceManager initialized');
        
    }

    async fetchData(): Promise<void> {

        const [devices, zones] = await Promise.all([
            this.api.devices.getDevices(),
            this.api.zones.getZones(),
        ]);

        // Todo: simplify devices and zones data
        this.devices = devices;
        this.zones = zones; 
    }

    /**
     * Get device by ID
     * @param deviceId The ID of the device to get
     * @returns The device object or null if not found
     */
    getDeviceById(deviceId: string): Device | null {
        if (!this.devices) return null;
        return this.devices[deviceId] || null;
    }

    /**
     * Get zone by ID
     * @param zoneId The ID of the zone to get
     * @returns The zone object or null if not found
     */
    getZoneById(zoneId: string): Zone | null {
        if (!this.zones) return null;
        return this.zones[zoneId] || null;
    }

    /**
     * Get a simple list of all zone names, excluding any with "_hide_" in their name
     * @returns Array of zone names
     */
    getZones(): string[] {
        if (!this.zones) return [];
        
        const zonesList: string[] = [];
        for (const zoneId in this.zones) {
            if (this.zones.hasOwnProperty(zoneId)) {
                const zoneName = this.zones[zoneId].name;
                if (!zoneName.includes("_hide_")) {
                    zonesList.push(zoneName);
                }
            }
        }
        
        return zonesList;
    }

    /**
     * Get a distinct list of all device types (classes) in the system
     * @returns Array of unique device types
     */
    getAllDeviceTypes(): string[] {
        if (!this.devices) return [];
        
        // Use a Set to automatically keep track of unique values
        const deviceTypes = new Set<string>();
        
        // Iterate through all devices and collect unique types
        for (const deviceId in this.devices) {
            if (this.devices.hasOwnProperty(deviceId)) {
                const device = this.devices[deviceId];
                if (device.class) {
                    deviceTypes.add(device.class);
                }
            }
        }
        
        // Convert Set to Array and sort alphabetically
        return Array.from(deviceTypes).sort();
    }


    /**
     * Helper method to get a zone's full hierarchy path
     * @param zoneId - The ID of the starting zone
     * @returns Array of zone names from child to parent, excluding root zone
     * @private
     */
    private _getZoneHierarchy(zoneId: string): string[] {
        const zoneNames: string[] = [];
        
        // If no zones data or invalid zoneId, return empty array
        if (!this.zones || !zoneId || !this.zones[zoneId]) {
            return zoneNames;
        }
        
        let currentZoneId: string | null = zoneId;
        
        // Prevent infinite loops due to circular references
        const visitedZones = new Set<string>();
        
        // Traverse up the zone hierarchy
        while (currentZoneId && !visitedZones.has(currentZoneId) && this.zones[currentZoneId]) {
            const currentZone: Zone = this.zones[currentZoneId];
            visitedZones.add(currentZoneId);
            
            // Skip the root zone (zone without a parent)
            if (currentZone.parent || zoneNames.length === 0) {
                // Only add non-root zones or at least the immediate zone
                zoneNames.push(currentZone.name);
            }
            
            // Move up to the parent zone
            currentZoneId = currentZone.parent;
        }
        
        return zoneNames;
    }


    /**
     * Set a capability value for a device
     * @param deviceId - The ID of the device to update
     * @param capabilityId - The capability ID to set
     * @param newValue - The new value to set for the capability
     * @returns Promise resolving when the capability is set
     */
    async setDeviceCapability(deviceId: string, capabilityId: string, newValue: any): Promise<void> {
        console.log(`Setting capability for device ${deviceId}: ${capabilityId} = ${newValue}`);
        
        await this.api.devices.setCapabilityValue({
            deviceId: deviceId,
            capabilityId: capabilityId,
            value: newValue,
        }); 

    }    

    
    /**
     * Get a list of smart home devices with selected properties
     * @param zone - Optional filter for devices by zone name (case-insensitive)
     * @param type - Optional filter for devices by device type (case-insensitive)
     * @param page_size - Number of devices per page (1-100)
     * @param page_token - Opaque cursor for the next page
     * @returns Object containing devices array and next_page_token
     */
    getSmartHomeDevices(
        zone?: string, 
        type?: string, 
        page_size: number = 25, 
        page_token: string | null = null
    ): PaginatedDevices {
        if (!this.devices) return { devices: [], next_page_token: null };
        
        // Validate page_size
        page_size = Math.max(1, Math.min(100, typeof page_size === 'string' ? parseInt(page_size) || 25 : page_size));
        
        const devicesList = [];
        
        // First, build the filtered list
        for (const deviceId in this.devices) {
            if (this.devices.hasOwnProperty(deviceId)) {
                const device = this.devices[deviceId];
                
                // Get the zone hierarchy for this device
                let zoneHierarchy = ["Unknown Zone"];
                if (device.zone && this.zones && this.zones[device.zone]) {
                    zoneHierarchy = this._getZoneHierarchy(device.zone);
                }
                
                // Apply zone filter if specified
                if (zone && zoneHierarchy.length > 0) {
                    // Check if any zone in the hierarchy matches the filter
                    const zoneMatch = zoneHierarchy.some(zoneName => zoneName.toLowerCase() === zone.toLowerCase());
                    
                    if (!zoneMatch) continue; // Skip this device if zone doesn't match
                }
                
                // Apply type filter if specified
                // Note: In the source device object, the property is called "class"
                // but we're exposing it as "type" in our API
                if (type && device.class) {
                    if (device.class.toLowerCase() !== type.toLowerCase()) {
                        continue; // Skip this device if class/type doesn't match
                    }
                }
                
                // Format capabilities with their values
                const formattedCapabilities = [];
                if (device.capabilities && device.capabilitiesObj) {
                    for (const capability of device.capabilities) {
                        if (device.capabilitiesObj[capability] && 
                            device.capabilitiesObj[capability].hasOwnProperty('value')) {
                            formattedCapabilities.push(`${capability}=${device.capabilitiesObj[capability].value}`);
                        } else {
                            // If we can't get the value, just add the capability name
                            formattedCapabilities.push(capability);
                        }
                    }
                }
                
                // Create a simplified device object with only the requested properties
                const simplifiedDevice = {
                    id: device.id,
                    name: device.name,
                    zone: zoneHierarchy,
                    type: device.class, // We use "type" in our API but it's "class" in the original data
                    capabilities: formattedCapabilities
                };
                
                devicesList.push(simplifiedDevice);
            }
        }
        
        // Apply pagination
        const start = page_token ? parseInt(page_token, 10) : 0;
        const slice = devicesList.slice(start, start + page_size);
        const next_page_token = start + page_size < devicesList.length ? String(start + page_size) : null;
        
        return {
            devices: slice,
            next_page_token: next_page_token
        };
    }


}

// Use CommonJS exports for compatibility with Homey
module.exports = {
    DeviceManager
};