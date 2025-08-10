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
