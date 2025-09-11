import { 
    IDeviceManager, 
    Device, 
    PaginatedDevices, 
    SetDeviceCapabilityResult, 
    ZoneChanged 
} from '../../src/helpers/interfaces.mjs';

/**
 * Mock implementation of IDeviceManager for testing purposes
 * Provides predictable, controllable behavior for unit tests
 */
export class MockDeviceManager implements IDeviceManager {
    private devices: Device[] = [];
    private zones: string[] = [];
    private deviceTypes: string[] = [];
    private registeredDevices: Map<string, { device: Device; callback: (changed: ZoneChanged) => void }> = new Map();
    
    // Flags to control mock behavior
    public shouldFailInit = false;
    public shouldFailFetchData = false;
    public shouldFailSetCapability = false;
    public initCallCount = 0;
    public fetchDataCallCount = 0;

    constructor() {
        this.setupDefaultData();
    }

    /**
     * Set up some default test data
     */
    private setupDefaultData(): void {
        this.zones = ['Living Room', 'Kitchen', 'Bedroom', 'Office'];
        this.deviceTypes = ['light', 'socket', 'sensor', 'thermostat', 'speaker'];
        
        this.devices = [
            // Living Room devices (4 devices)
            {
                id: 'device-1',
                name: 'Living Room Main Light',
                zone: 'Living Room',
                zones: ['Living Room'],
                type: 'light',
                capabilities: ['onoff=true', 'dim=0.75'],
                dataId: 'mac-001'
            },
            {
                id: 'device-2',
                name: 'Living Room Floor Lamp',
                zone: 'Living Room',
                zones: ['Living Room'],
                type: 'light',
                capabilities: ['onoff=false', 'dim=0.5'],
                dataId: 'mac-002'
            },
            {
                id: 'device-3',
                name: 'Living Room TV Socket',
                zone: 'Living Room',
                zones: ['Living Room'],
                type: 'socket',
                capabilities: ['onoff=true'],
                dataId: 'mac-003'
            },
            {
                id: 'device-4',
                name: 'Living Room Speaker',
                zone: 'Living Room',
                zones: ['Living Room'],
                type: 'speaker',
                capabilities: ['volume=0.6', 'speaker_playing=false'],
                dataId: 'mac-004'
            },
            
            // Kitchen devices (3 devices)
            {
                id: 'device-5',
                name: 'Kitchen Ceiling Light',
                zone: 'Kitchen',
                zones: ['Kitchen'],
                type: 'light',
                capabilities: ['onoff=true', 'dim=0.8'],
                dataId: 'mac-005'
            },
            {
                id: 'device-6',
                name: 'Kitchen Under Cabinet Lights',
                zone: 'Kitchen',
                zones: ['Kitchen'],
                type: 'light',
                capabilities: ['onoff=false', 'dim=0.3'],
                dataId: 'mac-006'
            },
            {
                id: 'device-7',
                name: 'Kitchen Coffee Machine',
                zone: 'Kitchen',
                zones: ['Kitchen'],
                type: 'socket',
                capabilities: ['onoff=false'],
                dataId: 'mac-007'
            },
            
            // Bedroom devices (4 devices)
            {
                id: 'device-8',
                name: 'Bedroom Main Light',
                zone: 'Bedroom',
                zones: ['Bedroom'],
                type: 'light',
                capabilities: ['onoff=false', 'dim=0.4'],
                dataId: 'mac-008'
            },
            {
                id: 'device-9',
                name: 'Bedroom Bedside Lamp',
                zone: 'Bedroom',
                zones: ['Bedroom'],
                type: 'light',
                capabilities: ['onoff=true', 'dim=0.2'],
                dataId: 'mac-009'
            },
            {
                id: 'device-10',
                name: 'Bedroom Temperature Sensor',
                zone: 'Bedroom',
                zones: ['Bedroom'],
                type: 'sensor',
                capabilities: ['measure_temperature=21.2', 'measure_humidity=45'],
                dataId: 'mac-010'
            },
            {
                id: 'device-11',
                name: 'Bedroom Phone Charger',
                zone: 'Bedroom',
                zones: ['Bedroom'],
                type: 'socket',
                capabilities: ['onoff=true'],
                dataId: 'mac-011'
            },
            
            // Office devices (4 devices)
            {
                id: 'device-12',
                name: 'Office Desk Light',
                zone: 'Office',
                zones: ['Office'],
                type: 'light',
                capabilities: ['onoff=true', 'dim=0.9'],
                dataId: 'mac-012'
            },
            {
                id: 'device-13',
                name: 'Office Thermostat',
                zone: 'Office',
                zones: ['Office'],
                type: 'thermostat',
                capabilities: ['target_temperature=22', 'measure_temperature=21.5'],
                dataId: 'mac-013'
            },
            {
                id: 'device-14',
                name: 'Office Ceiling Light',
                zone: 'Office',
                zones: ['Office'],
                type: 'light',
                capabilities: ['onoff=false', 'dim=0.6'],
                dataId: 'mac-014'
            },
            {
                id: 'device-15',
                name: 'Office Reading Lamp',
                zone: 'Office',
                zones: ['Office'],
                type: 'light',
                capabilities: ['onoff=true', 'dim=0.4'],
                dataId: 'mac-015'
            }
        ];
    }

    async init(): Promise<void> {
        this.initCallCount++;
        if (this.shouldFailInit) {
            throw new Error('Mock init failure');
        }
        // Mock successful initialization
    }

    async fetchData(): Promise<void> {
        this.fetchDataCallCount++;
        if (this.shouldFailFetchData) {
            throw new Error('Mock fetch data failure');
        }
        // Mock successful data fetch
    }

    registerDevice(mac: string, callback: (changed: ZoneChanged) => void): string {
        const device = this.devices.find(d => d.dataId === mac);
        
        if (device) {
            this.registeredDevices.set(device.id, { device, callback });
            return device.zone;
        } else {
            return "<Unknown Zone>";
        }
    }

    unRegisterDevice(mac: string): void {
        const device = this.devices.find(d => d.dataId === mac);
        if (device) {
            this.registeredDevices.delete(device.id);
        }
    }

    getZones(): string[] {
        return [...this.zones];
    }

    getAllDeviceTypes(): string[] {
        return [...this.deviceTypes];
    }

    getSmartHomeDevices(
        zone?: string, 
        type?: string, 
        page_size: number = 25, 
        page_token: string | null = null
    ): PaginatedDevices {
        let filteredDevices = [...this.devices];

        // Apply zone filter
        if (zone) {
            const zoneFilter = zone.toLowerCase();
            filteredDevices = filteredDevices.filter(device => 
                device.zones.some(z => z.toLowerCase() === zoneFilter)
            );
        }

        // Apply type filter
        if (type) {
            const typeFilter = type.toLowerCase();
            filteredDevices = filteredDevices.filter(device => 
                device.type.toLowerCase() === typeFilter
            );
        }

        // Apply pagination
        const validPageSize = Math.max(1, Math.min(100, page_size));
        const start = page_token ? parseInt(page_token, 10) : 0;
        const slice = filteredDevices.slice(start, start + validPageSize);
        const next_page_token = start + validPageSize < filteredDevices.length ? 
            String(start + validPageSize) : null;

        return {
            devices: slice,
            next_page_token
        };
    }

    async setDeviceCapability(
        deviceId: string, 
        capabilityId: string, 
        newValue: any, 
        options?: any
    ): Promise<SetDeviceCapabilityResult> {
        if (this.shouldFailSetCapability) {
            return {
                deviceId,
                status: "error",
                error: "Mock capability set failure"
            };
        }

        // Find the device and update its capability in the mock data
        const device = this.devices.find(d => d.id === deviceId);
        if (device) {
            // Update the capability value in the mock data
            const capabilityIndex = device.capabilities.findIndex(cap => 
                cap.startsWith(`${capabilityId}=`)
            );
            
            if (capabilityIndex >= 0) {
                device.capabilities[capabilityIndex] = `${capabilityId}=${newValue}`;
            } else {
                device.capabilities.push(`${capabilityId}=${newValue}`);
            }
        }

        return {
            deviceId,
            status: "success"
        };
    }

    async setDeviceCapabilityBulk(
        deviceIds: string[], 
        capabilityId: string, 
        newValue: any, 
        options?: any
    ): Promise<SetDeviceCapabilityResult[]> {
        const results = await Promise.all(
            deviceIds.map(deviceId => 
                this.setDeviceCapability(deviceId, capabilityId, newValue, options)
            )
        );
        return results;
    }

    // Helper methods for testing

    /**
     * Add a device to the mock data (for testing)
     */
    addDevice(device: Device): void {
        this.devices.push(device);
    }

    /**
     * Remove a device from the mock data (for testing)
     */
    removeDevice(deviceId: string): void {
        this.devices = this.devices.filter(d => d.id !== deviceId);
    }

    /**
     * Clear all devices (for testing)
     */
    clearDevices(): void {
        this.devices = [];
    }

    /**
     * Reset mock to initial state (for testing)
     */
    reset(): void {
        this.shouldFailInit = false;
        this.shouldFailFetchData = false;
        this.shouldFailSetCapability = false;
        this.initCallCount = 0;
        this.fetchDataCallCount = 0;
        this.registeredDevices.clear();
        this.setupDefaultData();
    }

    /**
     * Simulate a device zone change event (for testing)
     */
    simulateDeviceZoneChange(deviceId: string, newZone: string): void {
        const registeredDevice = this.registeredDevices.get(deviceId);
        if (registeredDevice) {
            const oldZone = registeredDevice.device.zone;
            registeredDevice.device.zone = newZone;
            registeredDevice.device.zones = [newZone];
            
            registeredDevice.callback({
                device: registeredDevice.device,
                oldZone,
                newZone
            });
        }
    }

    /**
     * Get registered devices count (for testing)
     */
    getRegisteredDevicesCount(): number {
        return this.registeredDevices.size;
    }
}
