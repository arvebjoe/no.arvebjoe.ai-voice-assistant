/**
 * The smart_home tool's actions and the exact, code-side part of carrying them
 * out: which capability an action writes on a device, and which devices can do
 * it at all. Shared by ToolManager and the emulator's Jev benchmark, so the
 * benchmark sends Jev exactly the candidates production does.
 */

export const JEV_ACTIONS = [
    'turn_on', 'turn_off', 'set_brightness', 'set_temperature', 'lock', 'unlock',
    'open', 'close', 'stop', 'set_position', 'get_status',
];
export const JEV_VALUE_ACTIONS = ['set_brightness', 'set_temperature', 'set_position'];

/**
 * What each smart_home action writes on one device, or null when the device
 * cannot do it. Capability filtering is exact, so it happens here in code —
 * Jev only judges which of the capable devices the user meant.
 */
export function planJevWrite(action: string, caps: Set<string>, value: number | undefined): { capabilityId: string; newValue: any } | null {
    const fraction = value === undefined ? undefined : value / 100;
    switch (action) {
        case 'turn_on': return caps.has('onoff') ? { capabilityId: 'onoff', newValue: true } : null;
        case 'turn_off': return caps.has('onoff') ? { capabilityId: 'onoff', newValue: false } : null;
        case 'set_brightness': return caps.has('dim') && fraction !== undefined ? { capabilityId: 'dim', newValue: fraction } : null;
        case 'set_temperature': return caps.has('target_temperature') && value !== undefined ? { capabilityId: 'target_temperature', newValue: value } : null;
        case 'lock': return caps.has('locked') ? { capabilityId: 'locked', newValue: true } : null;
        case 'unlock': return caps.has('locked') ? { capabilityId: 'locked', newValue: false } : null;
        case 'open':
        case 'close': {
            const open = action === 'open';
            if (caps.has('windowcoverings_set')) return { capabilityId: 'windowcoverings_set', newValue: open ? 1 : 0 };
            if (caps.has('windowcoverings_state')) return { capabilityId: 'windowcoverings_state', newValue: open ? 'up' : 'down' };
            return null;
        }
        case 'stop': return caps.has('windowcoverings_state') ? { capabilityId: 'windowcoverings_state', newValue: 'idle' } : null;
        case 'set_position': return caps.has('windowcoverings_set') && fraction !== undefined ? { capabilityId: 'windowcoverings_set', newValue: fraction } : null;
        default: return null;
    }
}

/** `capabilities` holds "onoff=true" strings; split into name -> raw value. */
export function capabilityValues(device: { capabilities?: string[] }): Map<string, string | undefined> {
    const values = new Map<string, string | undefined>();
    for (const entry of device.capabilities ?? []) {
        const eq = entry.indexOf('=');
        if (eq < 0) values.set(entry, undefined);
        else values.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
    return values;
}

/** The devices Jev is asked about: all of them for a status read, else those that can do the action. */
export function jevCandidates<T extends { capabilities?: string[] }>(action: string, devices: T[], value: number | undefined): T[] {
    if (action === 'get_status') return devices;
    return devices.filter(d => planJevWrite(action, new Set(capabilityValues(d).keys()), value) !== null);
}
