// Using require for HomeyAPI as it might not have TypeScript typings
import { Device, Zone, ZonesCollection, PaginatedDevices, SetDeviceCapabilityResult, ZoneChanged } from './interfaces.mjs';
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
    private logger = createLogger('DeviceManager', true);
    // Zone-change subscriptions keyed by the satellite's MAC (its `data.id`) —
    // NOT by a captured Device object: fetchData() rebuilds `this.devices` with
    // fresh objects, so a stored reference goes stale on any re-fetch (the root
    // of H-h). The MAC is the only stable identity; the catalog entry is
    // resolved fresh per event. `currentZone` is the last zone we notified for,
    // which is what makes the dedup survive the device.update storm.
    private zoneSubscriptions: Map<string, { currentZone: string; callback: (changed: ZoneChanged) => void }> = new Map();


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

            // Resolve the subscription via the stable MAC — from the event itself
            // when it carries `data.id`, else via the catalog. Never from an
            // object captured at registration time.
            const mac: string | null = updated?.data?.id
                ?? this.devices.find(d => d.id === updated?.id)?.dataId
                ?? null;
            if (!mac) {
                return;
            }
            const sub = this.zoneSubscriptions.get(mac);
            if (!sub) {
                return;
            }

            const currentZone = this.zones[updated.zone];
            if (!currentZone) {
                this.logger.warn(`Zone ${updated.zone} not found`);
                return;
            }

            // device.update fires on ANY device change (e.g. the app's own onoff
            // capability writes every session) — only a real move counts (H-h).
            if (sub.currentZone === currentZone.name) {
                return;
            }

            const oldZoneName = sub.currentZone;
            // Update the tracked zone BEFORE firing so the follow-up update storm
            // can't see a stale zone and re-fire the callback.
            sub.currentZone = currentZone.name;

            // Resolve the catalog entry fresh (it may be a rebuilt object) and
            // keep it in sync so device queries report the new zone too. `zones`
            // (the hierarchy) must follow as well — zone-filtered queries match
            // on it, and it previously kept matching the OLD room after a move.
            const device = this.devices.find(d => d.dataId === mac);
            if (device) {
                device.zone = currentZone.name;
                device.zones = this._getZoneHierarchy(updated.zone);
            }

            this.logger.info(`Device ${device?.name ?? mac} moved from zone ${oldZoneName} to ${currentZone.name}`);
            sub.callback({
                // Fallback stub for a device not (yet) in the catalog — consumers
                // only read identity fields off this.
                device: device ?? {
                    id: updated?.id ?? '',
                    name: updated?.name ?? mac,
                    zone: currentZone.name,
                    zones: [currentZone.name],
                    type: '',
                    capabilities: [],
                    dataId: mac,
                },
                oldZone: oldZoneName,
                newZone: currentZone.name
            });

        });
    }

    registerDevice(mac: string, callback: (changed: ZoneChanged) => void): string {

        const device = this.devices.find(d => d.dataId === mac);
        const zone = device?.zone ?? "<Unknown Zone>";

        if (!device) {
            // Not in the catalog (yet) — e.g. the voice device initialized before
            // fetchData completed, or it was paired since the last fetch. Still
            // subscribe by MAC: the first device.update resolves the real zone
            // and notifies. (Previously this silently never subscribed.)
            this.logger.warn(`Device with MAC ${mac} not in the catalog yet — zone resolves on its first update`);
        }

        this.zoneSubscriptions.set(mac, { currentZone: zone, callback });
        return zone;
    }

    unRegisterDevice(mac: string): void {
        if (!this.zoneSubscriptions.delete(mac)) {
            this.logger.warn(`No zone subscription for MAC ${mac} to unregister`);
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
     * Unique zone + device names, for the STT vocabulary prompt: domain words
     * ("Taklampe stue") the transcriber would otherwise mis-hear. Zones first
     * (short list), then devices. Empty until fetchData() has run.
     */
    getVocabularyNames(): string[] {
        const names = new Set<string>();
        for (const zone of this.zoneList) {
            if (zone) names.add(zone);
        }
        for (const device of this.devices) {
            if (device?.name) names.add(device.name);
        }
        return Array.from(names);
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
