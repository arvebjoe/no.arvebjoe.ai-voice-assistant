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


export declare interface DeviceZoneChangedCallback {
    device: Device;
    callback: (changed: ZoneChanged) => void;
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

export declare interface WavOptions {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
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
    };
};


export interface DeviceStore {
    address: string;
    port: number;
    mac: string;
    [key: string]: any;
}