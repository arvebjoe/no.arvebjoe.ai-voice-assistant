// Type definitions
export declare interface AudioData {
    data: Buffer;
    extension: string; // File extension, e.g., 'wav', 'flac'
}

export declare interface StreamInfo {
    name: string;
    audioFormat: any;
    url: string;
    appendChunk: (chunk: Buffer) => void;
}




// Type definitions
export declare interface Device {
    id: string;
    name: string;
    zones: string[];
    type: string;
    capabilities: string[];
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
  [key: string]: any;
}