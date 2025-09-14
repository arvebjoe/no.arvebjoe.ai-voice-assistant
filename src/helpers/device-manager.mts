// Using require for HomeyAPI as it might not have TypeScript typings
import { Device, Zone, ZonesCollection, PaginatedDevices, SetDeviceCapabilityResult, DeviceZoneChangedCallback, ZoneChanged } from './interfaces.mjs';
import { createLogger } from './logger.mjs';
import { IDeviceManager } from './interfaces.mjs';
import { ApiHelper } from './api-helper.mjs';


export class DeviceManager implements IDeviceManager {
    private homey: any;
    private apiHelper: ApiHelper;
    private devices: Device[];
    private zoneList: string[];
    private zones: ZonesCollection | null;
    private deviceTypes: string[];
    private logger = createLogger('DeviceManager', false);
    private voiceAssistantDevices: Map<string, DeviceZoneChangedCallback> = new Map();


    constructor(homey: any, apiHelper: ApiHelper) {
        this.homey = homey;
        this.apiHelper = apiHelper;
        this.devices = [];
        this.zoneList = [];
        this.zones = null;
        this.deviceTypes = [];

    }

    async init(): Promise<void> {
        this.logger.info('DeviceManager initialized');

        this.apiHelper.devices.on("device.update", (updated: any) => {

            if (!this.zones) {
                return;
            }

            // Check if we find the zone. Might be a new zone :-o
            const currentZone = this.zones[updated.zone];

            if (!currentZone) {
                this.logger.warn(`Zone ${updated.zone} not found`);
                return;
            }

            // Get the registered entry by device ID (guid)
            const entry = this.voiceAssistantDevices.get(updated.id);
            if (!entry) {
                return;
            }

            const voiceAssistantDevice = entry.device;
            const oldZoneName = voiceAssistantDevice.zone;
            const newZoneName = currentZone.name;

            if (oldZoneName !== newZoneName) {
                this.logger.info(`Device ${voiceAssistantDevice.name} moved from zone ${oldZoneName} to ${newZoneName}`);
                entry.callback({
                    device: voiceAssistantDevice,
                    oldZone: oldZoneName,
                    newZone: newZoneName
                });
            }

        });
    }

    registerDevice(mac: string, callback: (changed: ZoneChanged) => void): string {

        const device = this.devices.find(d => d.dataId === mac);

        if (device) {

            const entry: DeviceZoneChangedCallback = {
                device: device,
                callback: callback
            }

            this.voiceAssistantDevices.set(device.id, entry);

            return device.zone;

        } else {
            this.logger.warn(`Device with MAC ${mac} not found, cannot register for zone changes`);
            return "<Unknown Zone>";
        }
    }

    unRegisterDevice(mac: string): void {

        const device = this.devices.find(d => d.dataId === mac);

        if (device) {
            this.voiceAssistantDevices.delete(device.id);
        } else {
            this.logger.warn(`Device with MAC ${mac} not found, cannot unregister for zone changes`);
        }
    }



    async fetchData(): Promise<void> {
        this.logger.info('Fetching devices and zones from Homey...');
    
        const zones = await this.apiHelper.zones.getZones();
        const devices = await this.apiHelper.devices.getDevices();

        this.logger.info(`Found ${Object.keys(devices).length} devices and ${Object.keys(zones).length} zones`);

        this.zones = zones;


        // Transform zones first
        this.zoneList = [];
        for (const zoneId in this.zones) {
            if (this.zones.hasOwnProperty(zoneId)) {
                const zoneName = this.zones[zoneId].name;
                if (!zoneName.includes("_hide_")) {
                    this.zoneList.push(zoneName);
                }
            }
        }


        // Transform devices
        this.devices = [];
        const types = new Set<string>();

        for (const deviceId in devices) {
            if (devices.hasOwnProperty(deviceId)) {
                const device = devices[deviceId];

                // Get the zone hierarchy for this device
                let zoneHierarchy = ["Unknown Zone"];
                if (device.zone && this.zones && this.zones[device.zone]) {
                    zoneHierarchy = this._getZoneHierarchy(device.zone);
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

                // Add device class to the set of device types
                if (device.class) {
                    types.add(device.class);
                }

                if (device.virtualClass) {
                    types.add(device.virtualClass);
                }


                // Create a simplified device object with only the requested properties
                const simplifiedDevice: Device = {
                    id: device.id,
                    name: device.name,
                    zone: this.zones == null ? '' : this.zones[device.zone]?.name ?? '',
                    zones: zoneHierarchy,
                    type: device.virtualClass ?? device.class,
                    capabilities: formattedCapabilities,
                    dataId: device.data?.id ?? null
                };

                this.devices.push(simplifiedDevice);
            }
        }

        this.deviceTypes = Array.from(types).sort();

        this.logger.info('Done processing devices and zones');

    }





    /**
     * Get a simple list of all zone names, excluding any with "_hide_" in their name
     * @returns Array of zone names
     */
    getZones(): string[] {
        if (!this.zoneList) {
            this.logger.info("No zones found");
            return [];
        }
        this.logger.info(`Found zones: ${this.zoneList.join(', ')}`);
        return this.zoneList;
    }

    /**
     * Get a distinct list of all device types (classes) in the system
     * @returns Array of unique device types
     */
    getAllDeviceTypes(): string[] {
        if (!this.deviceTypes) {
            this.logger.info("No device types found");
            return [];
        }
        this.logger.info(`Found device types: ${this.deviceTypes.join(', ')}`);
        return this.deviceTypes;
    }



    /**
     * Get a list of smart home devices with selected properties
     * @param zone - Optional filter for devices by zone name (case-insensitive)
     * @param type - Optional filter for devices by device type (case-insensitive)
     * @param page_size - Number of devices per page (1-100)
     * @param page_token - Opaque cursor for the next page
     * @returns Object containing devices array and next_page_token
     */
    getSmartHomeDevices(zone?: string, type?: string, page_size: number = 25, page_token: string | null = null): PaginatedDevices {

        if (!this.devices) {
            this.logger.info("No devices found");
            return {
                devices: [],
                next_page_token: null
            };
        }

        // Validate page_size
        page_size = Math.max(1, Math.min(100, typeof page_size === 'string' ? parseInt(page_size) || 25 : page_size));

        const devicesList: Device[] = [];
        const zoneFilter = zone ? zone.toLowerCase() : null;
        const typeFilter = type ? type.toLowerCase() : null;

        for (const device of this.devices) {

            // Apply zone filter if specified
            if (zoneFilter) {
                if (!device.zones || device.zones.length === 0) continue; // exclude devices with no zones when filtering
                const zoneMatch = device.zones.some(z => z.toLowerCase() === zoneFilter);
                if (!zoneMatch) continue;
            }

            // Apply type filter if specified
            if (typeFilter) {
                if (!device.type || device.type.toLowerCase() !== typeFilter) continue;
            }

            devicesList.push(device);
        }

        if (devicesList.length === 0) {
            this.logger.info("No devices found matching the filters");
            return {
                devices: [],
                next_page_token: null
            };
        }

        // Apply pagination
        const start = page_token ? parseInt(page_token, 10) : 0;
        const slice = devicesList.slice(start, start + page_size);
        const next_page_token = start + page_size < devicesList.length ? String(start + page_size) : null;

        for (const device of slice) {
            this.logger.info(`Device: ${device.name} (${device.id}) - Zone: ${device.zones.join(' > ')} - Type: ${device.type} - Capabilities: ${device.capabilities.join(', ')}`);
        }

        return {
            devices: slice,
            next_page_token: next_page_token
        };
    }



    /**
     * Set a capability value for a device
     * @param deviceId - The ID of the device to update
     * @param capabilityId - The capability ID to set
     * @param newValue - The new value to set for the capability
     * @returns Promise resolving when the capability is set
     */
    async setDeviceCapability(deviceId: string, capabilityId: string, newValue: any, options?: any): Promise<SetDeviceCapabilityResult> {

        try {
            await this.apiHelper.devices.setCapabilityValue({
                deviceId: deviceId,
                capabilityId: capabilityId,
                value: newValue,
            });
            //this.logger.info(`Setting capability ${capabilityId} to ${newValue} for device ${deviceId}`)
        } catch (error: any) {
            this.logger.warn(`Error setting capability ${capabilityId} for device ${deviceId}`, error?.message ?? "Unknown error");
            return {
                deviceId,
                status: "error",
                error: error?.message ?? "Unknown error"
            };
        }

        return { deviceId, status: "success" };

    }

    async setDeviceCapabilityBulk(deviceIds: string[], capabilityId: string, newValue: any, options?: any): Promise<SetDeviceCapabilityResult[]> {

        const results = await Promise.all(deviceIds.map(deviceId =>
            this.setDeviceCapability(deviceId, capabilityId, newValue, options)
        ));

        return results;
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

}
