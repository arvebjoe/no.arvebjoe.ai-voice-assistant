// Type definitions
export declare interface AudioData {
    data: Buffer;
    extension: string; // File extension, e.g., 'wav', 'flac'
    prefix: string;
}

export declare interface FileInfo {
    filename: string;
    filepath: string;
    url: string;
    /**
     * Expected playback duration (ms). When set, file deletion is scheduled
     * TTL + this, so a clip longer than the base TTL isn't unlinked while the
     * device is still streaming it.
     */
    playbackMs?: number;
}

export declare interface StreamInfo {
    name: string;
    audioFormat: any;
    url: string;
    appendChunk: (chunk: Buffer) => void;
}


export declare interface SetDeviceCapabilityResult {
    deviceId: string;
    status: "success" | "error";
    error?: string;
}



export declare interface IDeviceManager {
    init(): Promise<void>;
    fetchData(): Promise<void>;
    registerDevice(mac: string, callback: (changed: ZoneChanged) => void): string;
    unRegisterDevice(mac: string): void;
    getZones(): string[];
    getAllDeviceTypes(): string[];
    getSmartHomeDevices(zone?: string, type?: string, page_size?: number, page_token?: string | null): PaginatedDevices;
    setDeviceCapability(deviceId: string, capabilityId: string, newValue: any, options?: any): Promise<SetDeviceCapabilityResult>;
    setDeviceCapabilityBulk(deviceIds: string[], capabilityId: string, newValue: any, options?: any): Promise<SetDeviceCapabilityResult[]>;
}

// Type definitions
export declare interface Device {
    id: string;
    name: string;
    zone: string;
    zones: string[];
    type: string;
    capabilities: string[];
    dataId: string;
}

export declare interface ZoneChanged {
    device: Device;
    oldZone: string;
    newZone: string;
}


export declare interface Zone {
    id: string;
    name: string;
    parent: string | null;
    [key: string]: any;
}

export declare interface DevicesCollection {
    [deviceId: string]: Device;
}

export declare interface ZonesCollection {
    [zoneId: string]: Zone;
}



export declare interface PaginatedDevices {
    devices: Device[];
    next_page_token: string | null;
}

export type PairDevice = {
    name: string;
    data: { id: string };
    store: {
        address: string;
        port: number;
        mac?: string;
        platform?: string;
        serviceName?: string;
        deviceType?: string | null; // 'pe' | 'xiaozhi' | null
        // ESPHome API encryption key (base64, 32 bytes) captured at pair time.
        encryptionKey?: string;
        // Pair-list only (never persisted on a real device): the device refuses
        // plaintext (mDNS txt.api_encryption, or the probe hit the Noise
        // indicator). Selecting it routes to manual entry to collect the key.
        requiresEncryption?: boolean;
    };
    // Initial device settings (Homey merges these into the settings store on
    // createDevice) — used to pre-fill the user-editable encryption_key field.
    settings?: { [key: string]: any };
};


export interface DeviceStore {
    address: string;
    port: number;
    mac: string;
    [key: string]: any;
}