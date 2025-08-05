// Type definitions
export declare interface AudioData {
    data: Buffer;
    rate: number;
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

export declare interface SimplifiedDevice {
    id: string;
    name: string;
    zone: string[];
    type: string;
    capabilities: string[];
}

export declare interface PaginatedDevices {
    devices: SimplifiedDevice[];
    next_page_token: string | null;
}
