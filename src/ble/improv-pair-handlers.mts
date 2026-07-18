import { createLogger } from '../helpers/logger.mjs';
import {
    BleManagerLike,
    discoverImprovDevices,
    ImprovBleSession,
    ImprovDeviceError,
    ImprovDiscoveredDevice,
    ImprovErrorState,
    ImprovProvisionOptions,
    ImprovSessionOptions,
    ImprovState,
    ImprovTimeoutError,
} from './improv-ble-client.mjs';

/**
 * Wires the Improv BLE Wi-Fi setup wizard (drivers' pair/improv_setup.html)
 * to the protocol client. Lives outside the driver class so the whole pair
 * flow is unit-testable with a fake session + fake BLE manager.
 *
 * All handlers return result objects ({ ok: true, ... } | { ok: false, code,
 * message }) instead of throwing, so the view can branch on error codes
 * (e.g. wrong Wi-Fi password → back to the credentials form).
 */

export interface PairSessionLike {
    setHandler(event: string, handler: (data?: any) => Promise<any>): any;
    emit(event: string, data?: any): Promise<any>;
}

export interface ImprovPairOptions {
    ble: BleManagerLike;
    session: PairSessionLike;
    sessionOptions?: ImprovSessionOptions;
    provisionOptions?: ImprovProvisionOptions;
    /** View id of the BLE wizard; navigating anywhere else disposes the BLE connection. */
    improvViewId?: string;
    /** Safety net: drop the BLE connection after this much inactivity. */
    idleTimeoutMs?: number;
    /**
     * Per-driver scan filter: only list Improv devices whose advertised name
     * matches (e.g. /3rspk|thirdreality/i for the TR driver, so a factory-reset
     * PE waiting in BLE mode doesn't show up in the TR wizard and vice versa).
     * Devices advertising WITHOUT a name are always kept: ESPHome alternates
     * between name and Improv-service advertisements, so a matching device can
     * legitimately be discovered nameless — only positively-identified foreign
     * devices are hidden.
     */
    deviceNameFilter?: RegExp;
    /**
     * Notified on every pair-view change (this module owns the session's single
     * 'showView' handler; the driver uses this to stop its background device
     * list re-scan when the user leaves the list view).
     */
    onShowView?: (viewId: string) => void;
}

export type ImprovFailureCode =
    | 'scan_failed'
    | 'device_not_found'
    | 'connect_failed'
    | 'invalid_input'
    | 'authorization_timeout'
    | 'provisioning_timeout'
    | 'unable_to_connect'
    | 'not_authorized'
    | 'device_error'
    | 'ble_error';

interface Failure {
    ok: false;
    code: ImprovFailureCode;
    message: string;
}

const fail = (code: ImprovFailureCode, message: string): Failure => ({ ok: false, code, message });

function toFailure(err: any): Failure {
    if (err instanceof ImprovTimeoutError) {
        return fail(err.phase === 'authorization' ? 'authorization_timeout' : 'provisioning_timeout', err.message);
    }
    if (err instanceof ImprovDeviceError) {
        switch (err.code) {
            case ImprovErrorState.UnableToConnect:
                return fail('unable_to_connect', 'The device could not join the Wi-Fi network. Check the network name and password (2.4 GHz networks only).');
            case ImprovErrorState.NotAuthorized:
                return fail('not_authorized', 'The device refused the request — it was not authorized. Press the button on the device and try again.');
            default:
                return fail('device_error', err.message);
        }
    }
    return fail('ble_error', err?.message ?? String(err));
}

export interface ImprovPairController {
    /** Disconnect BLE and stop timers. Safe to call multiple times. */
    dispose(): Promise<void>;
}

export function registerImprovPairHandlers(options: ImprovPairOptions): ImprovPairController {
    const logger = createLogger('Improv_Pair');
    const { ble, session } = options;
    const improvViewId = options.improvViewId ?? 'improv_setup';
    const idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60 * 1000;

    let scanResults = new Map<string, ImprovDiscoveredDevice>();
    let activeSession: ImprovBleSession | null = null;
    let disposed = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let anyViewShown = false;
    let firstViewTimer: NodeJS.Timeout | null = null;

    const touch = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (disposed) return;
        idleTimer = setTimeout(() => {
            logger.warn('Improv pair session idle — dropping BLE connection');
            void closeActiveSession();
        }, idleTimeoutMs);
        idleTimer.unref?.();
    };

    const closeActiveSession = async () => {
        const current = activeSession;
        activeSession = null;
        if (current) {
            await current.disconnect().catch(() => { });
        }
    };

    const dispose = async () => {
        if (disposed) return;
        disposed = true;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        if (firstViewTimer) clearTimeout(firstViewTimer);
        firstViewTimer = null;
        await closeActiveSession();
    };

    // Blank-first-view detector (diagnostic only): the session opened but the
    // client never rendered a view. Known cause: Firefox's Enhanced Tracking
    // Protection blocks the web app's cross-origin pair-view iframe (confirmed
    // 2026-07-18) — nothing app-side can rescue it (a backend showView() nudge
    // was tried and ignored), so just leave a breadcrumb in the log.
    firstViewTimer = setTimeout(() => {
        firstViewTimer = null;
        if (disposed || anyViewShown) return;
        logger.warn('Pair session opened but no view was shown — client-side render failure (e.g. Firefox ETP blocking the pair-view iframe)');
    }, 2500);
    firstViewTimer.unref?.();

    session.setHandler('improv_scan', async () => {
        touch();
        // A rescan invalidates any half-finished connection
        await closeActiveSession();
        try {
            const discovered = await discoverImprovDevices(ble);
            const filter = options.deviceNameFilter;
            const devices = filter
                ? discovered.filter((d) => !d.advertisement.localName || filter.test(d.advertisement.localName))
                : discovered;
            const hidden = discovered.length - devices.length;
            scanResults = new Map(devices.map((d) => [d.id, d]));
            logger.info(`Found ${devices.length} Improv device(s)`
                + (hidden > 0 ? ` (${hidden} hidden by name filter ${filter})` : ''));
            for (const d of discovered) {
                logger.info(`  Improv adv: localName=${JSON.stringify(d.advertisement.localName ?? null)}`
                    + ` address=${d.advertisement.address ?? '?'}`
                    + (devices.includes(d) ? '' : ' [hidden]'));
            }
            return {
                ok: true,
                devices: devices.map(({ id, name, address, rssi, state }) => ({ id, name, address, rssi, state })),
            };
        } catch (err: any) {
            logger.error('BLE scan failed', err);
            return fail('scan_failed', err?.message ?? String(err));
        }
    });

    session.setHandler('improv_connect', async (data: { id?: string } = {}) => {
        touch();
        const device = data.id ? scanResults.get(data.id) : undefined;
        if (!device) {
            return fail('device_not_found', 'Device not found — scan again and pick a device from the list.');
        }
        await closeActiveSession();
        const improv = new ImprovBleSession(device.advertisement, options.sessionOptions);
        activeSession = improv;
        // Forward live state changes so the wizard can show progress
        // ("press the button…", "joining Wi-Fi…") while provision() runs.
        improv.on('status', (status) => {
            session.emit('improv_status', status).catch(() => { });
        });
        try {
            const info = await improv.connect();
            return {
                ok: true,
                name: device.name,
                state: info.state,
                alreadyProvisioned: info.state === ImprovState.Provisioned,
                supportsIdentify: info.supportsIdentify,
            };
        } catch (err: any) {
            logger.error('Improv connect failed', err);
            await closeActiveSession();
            return fail('connect_failed', err?.message ?? String(err));
        }
    });

    session.setHandler('improv_provision', async (data: { ssid?: string; password?: string } = {}) => {
        touch();
        const ssid = (data.ssid ?? '').trim();
        const password = data.password ?? '';
        if (!ssid) {
            return fail('invalid_input', 'Enter the Wi-Fi network name (SSID).');
        }
        if (!activeSession) {
            return fail('device_not_found', 'Not connected to a device — scan and connect first.');
        }
        try {
            const urls = await activeSession.provision(ssid, password, options.provisionOptions);
            // The device drops the BLE link once provisioned; clean up our side too.
            await closeActiveSession();
            return { ok: true, urls };
        } catch (err: any) {
            logger.error('Provisioning failed', err);
            const failure = toFailure(err);
            // Wrong credentials keep the device in AUTHORIZED state on an open
            // connection — keep the session so the user can retry immediately.
            if (failure.code !== 'unable_to_connect' || !activeSession?.isConnected) {
                await closeActiveSession();
            }
            return failure;
        }
    });

    session.setHandler('improv_identify', async () => {
        touch();
        try {
            await activeSession?.identify();
            return { ok: true };
        } catch (err: any) {
            return fail('ble_error', err?.message ?? String(err));
        }
    });

    session.setHandler('improv_disconnect', async () => {
        touch();
        await closeActiveSession();
        return { ok: true };
    });

    // Leaving the wizard (to list_devices, back to start, …) must never leave
    // a BLE connection dangling — Homey keeps peripherals connected until
    // disconnect() is called explicitly.
    session.setHandler('showView', async (viewId: string) => {
        logger.info(`Pair view shown: ${viewId}`);
        anyViewShown = true;
        if (firstViewTimer) {
            clearTimeout(firstViewTimer);
            firstViewTimer = null;
        }
        try {
            options.onShowView?.(viewId);
        } catch { }
        if (viewId !== improvViewId) {
            await closeActiveSession();
        }
    });

    touch();
    return { dispose };
}
