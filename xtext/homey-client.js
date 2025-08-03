'use strict';

const fetch = require('node-fetch');

class HomeyClient {
    constructor(host, port) {
        this.baseUrl = `http://${host}:${port}`;
        this.devices = null;
        this.zones = null;
    }

    /**
     * Fetch all devices from the Homey API
     * @returns {Promise<Object>} Object containing all devices
     */
    async fetchDevices() {
        try {
            const response = await fetch(`${this.baseUrl}/devices`);
            if (!response.ok) {
                throw new Error(`Failed to fetch devices: ${response.statusText}`);
            }
            this.devices = await response.json();
            return this.devices;
        } catch (error) {
            console.error('Error fetching devices:', error);
            throw error;
        }
    }

    /**
     * Fetch all zones from the Homey API
     * @returns {Promise<Object>} Object containing all zones
     */
    async fetchZones() {
        try {
            const response = await fetch(`${this.baseUrl}/zones`);
            if (!response.ok) {
                throw new Error(`Failed to fetch zones: ${response.statusText}`);
            }
            this.zones = await response.json();
            return this.zones;
        } catch (error) {
            console.error('Error fetching zones:', error);
            throw error;
        }
    }

    /**
     * Initialize the client by fetching both devices and zones
     */
    async initialize() {
        await Promise.all([
            this.fetchDevices(),
            this.fetchZones()
        ]);
        console.log(`Successfully fetched ${Object.keys(this.devices || {}).length} devices and ${Object.keys(this.zones || {}).length} zones`);
    }

    /**
     * Get device by ID
     * @param {string} deviceId The ID of the device to get
     * @returns {Object|null} The device object or null if not found
     */
    getDeviceById(deviceId) {
        if (!this.devices) return null;
        return this.devices[deviceId] || null;
    }

    /**
     * Get zone by ID
     * @param {string} zoneId The ID of the zone to get
     * @returns {Object|null} The zone object or null if not found
     */
    getZoneById(zoneId) {
        if (!this.zones) return null;
        return this.zones[zoneId] || null;
    }

    /**
     * Get a simple list of all zone names, excluding any with "_hide_" in their name
     * @returns {Array<string>} Array of zone names
     */
    getZones() {
        if (!this.zones) return [];
        
        const zonesList = [];
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
     * @returns {Array<string>} Array of unique device types
     */
    getAllDeviceTypes() {
        if (!this.devices) return [];
        
        // Use a Set to automatically keep track of unique values
        const deviceTypes = new Set();
        
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
     * @param {string} zoneId - The ID of the starting zone
     * @returns {Array<string>} Array of zone names from child to parent, excluding root zone
     * @private
     */
    _getZoneHierarchy(zoneId) {
        const zoneNames = [];
        
        // If no zones data or invalid zoneId, return empty array
        if (!this.zones || !zoneId || !this.zones[zoneId]) {
            return zoneNames;
        }
        
        let currentZoneId = zoneId;
        
        // Prevent infinite loops due to circular references
        const visitedZones = new Set();
        
        // Traverse up the zone hierarchy
        while (currentZoneId && !visitedZones.has(currentZoneId) && this.zones[currentZoneId]) {
            const currentZone = this.zones[currentZoneId];
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
     * @param {string} deviceId - The ID of the device to update
     * @param {string} capabilityId - The capability ID to set
     * @param {any} newValue - The new value to set for the capability
     * @returns {Promise<void>}
     */
    async setDeviceCapability(deviceId, capabilityId, newValue) {
        console.log(`Setting capability for device ${deviceId}: ${capabilityId} = ${newValue}`);
        // This method will be implemented later
    }
    
    /**
     * Get a list of smart home devices with selected properties
     * @param {string} [zone] - Optional filter for devices by zone name (case-insensitive)
     * @param {string} [type] - Optional filter for devices by device type (case-insensitive)
     * @param {number} [page_size=25] - Number of devices per page (1-100)
     * @param {string} [page_token] - Opaque cursor for the next page
     * @returns {Object} Object containing devices array and next_page_token
     */
    getSmartHomeDevices(zone, type, page_size = 25, page_token = null) {
        if (!this.devices) return { devices: [], next_page_token: null };
        
        // Validate page_size
        page_size = Math.max(1, Math.min(100, parseInt(page_size) || 25));
        
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
                    const zoneMatch = zoneHierarchy.some(zoneName => 
                        zoneName.toLowerCase() === zone.toLowerCase());
                    
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
        const next_page_token = start + page_size < devicesList.length ? 
            String(start + page_size) : null;
        
        return {
            devices: slice,
            next_page_token: next_page_token
        };
    }
}

// Example usage:
async function main() {
    try {
        // Replace with your actual server IP and port
        const client = new HomeyClient('192.168.0.99', 7709);
        await client.initialize();
        
        // Get a simple list of zone names
        //const zoneNames = client.getZones();
        //console.log('Zone names:', zoneNames);
        
        // Example: Using a while loop to get all devices in "Trimrom" with pagination (3 per page)
        /*
        console.log('Getting all devices in Trimrom:');
        
        let allTrimromDevices = [];
        let nextPageToken = null;
        let pageNumber = 1;
        
        do {
            // Get a page of devices (3 per page)
            const page = client.getSmartHomeDevices("Ute", null, 3, nextPageToken);
            
            // Add devices from this page to our collection
            allTrimromDevices = allTrimromDevices.concat(page.devices);
            
            // Display the current page
            console.log(`Page ${pageNumber}:`, JSON.stringify(page.devices, null, 2));
            
            // Update the token for the next page
            nextPageToken = page.next_page_token;
            pageNumber++;
            
        } while (nextPageToken); // Continue until there are no more pages
        
        // Show the total number of devices found
        console.log(`Found a total of ${allTrimromDevices.length} devices in Trimrom`);
*/
        // Example: Get all device types available in the system
        const deviceTypes = client.getAllDeviceTypes();
        console.log('All device types in the system:', deviceTypes);
        
        // Example: Set a device capability
        await client.setDeviceCapability("device-123", "onoff", true);

        // Example 2: Get all lights (by device type) with pagination
        //const lightsPage1 = client.getSmartHomeDevices(null, "light", 5);
        //console.log('Lights page 1:', JSON.stringify(lightsPage1, null, 2));
        
        // Example 3: Get devices in a specific zone with pagination
        //const zoneDevices = client.getSmartHomeDevices("Kontoret", null, 5);
        //console.log('Kontoret devices:', JSON.stringify(zoneDevices, null, 2));
        
        // Example 4: Get all lights in a specific zone with pagination
        //const kontoretLights = client.getSmartHomeDevices("Kontoret", "light", 5);
        //console.log('Kontoret lights:', JSON.stringify(kontoretLights, null, 2));
    } catch (error) {
        console.error('Failed to initialize HomeyClient:', error);
    }
}

// Uncomment to run the example
//main();

module.exports = HomeyClient;
