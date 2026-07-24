import Homey from 'homey';
import { EspVoiceAssistantClient } from '../voice_assistant/esp-voice-assistant-client.mjs';
import { NoiseFrameCodec } from '../voice_assistant/noise-frame-codec.mjs';
import { PairDevice } from '../helpers/interfaces.mjs';
import VoiceAssistantDevice from './voice-assistant-device.mjs';
import { createLogger } from '../helpers/logger.mjs';
import { registerImprovPairHandlers } from '../ble/improv-pair-handlers.mjs';


export default abstract class VoiceAssistantDriver extends Homey.Driver {
    abstract readonly thisAssistantType: string;
    // Advertised-name filter for the Bluetooth Wi-Fi wizard's scan, so each
    // driver's pair dialog only lists its own model (see ImprovPairOptions.
    // deviceNameFilter). Null = list every Improv device.
    protected improvNameFilter: RegExp | null = null;
    // Whether this driver's pair flow can collect an API encryption key: it
    // must have the manual_entry and encryption_check views (PE + TR do).
    // When true, devices that refuse plaintext are still listed in the network
    // scan and selecting one routes to manual entry with the address prefilled.
    // When false (XiaoZhi), they stay hidden — its system add_devices flow
    // would otherwise add them without a key, creating a device that can
    // never connect.
    protected supportsEncryptedPairing = false;
    private logger = createLogger('Voice_Assistant_Driver', true);
    // Always-on logger for pair-session lifecycle (the main driver logger is
    // quieted; pairing problems are rare and need visible breadcrumbs).
    private pairLogger = createLogger('Pair');
    private static flowCardsInitialized = false;

    constructor(...args: any[]) {
        super(...args);
    }

    async onInit(): Promise<void> {

        // Only register flow card listeners once across all driver instances
        if (!VoiceAssistantDriver.flowCardsInitialized) {
            this.registerFlowCardListeners();
            VoiceAssistantDriver.flowCardsInitialized = true;
        }
    }

    private registerFlowCardListeners(): void {
        this.logger.info('Initializing');

        const cardIsMuted = this.homey.flow.getConditionCard('is-muted');
        cardIsMuted.registerRunListener(async (args) => {
            const device = args.device as VoiceAssistantDevice;
            try {
                return device.isMuted();
            } catch (error) {
                this.logger.error('Error checking mute status:', error);
                return false;
            }
        });

        // Timer triggers (timer-started/finished/cancelled) carry a device arg, so
        // they are device-trigger cards: the device fires them via
        // getDeviceTriggerCard().trigger(this, ...) and Homey scopes each flow to
        // that device automatically. No run-listener registration is needed here.

        const cardTimerRunning = this.homey.flow.getConditionCard('timer-is-running');
        cardTimerRunning.registerRunListener(async (args) => {
            const device = args.device as VoiceAssistantDevice;
            try {
                return device.isTimerRunning();
            } catch (error) {
                this.logger.error('Error checking timer status:', error);
                return false;
            }
        });

        const startTimerCard = this.homey.flow.getActionCard('start-timer');
        startTimerCard.registerRunListener(async (args) => {
            const device = args.device as VoiceAssistantDevice;
            try {
                device.startTimerFromFlow(Number(args.duration), args.name);
            } catch (error) {
                this.logger.error('Error starting timer:', error);
                throw error;
            }
        });

        const cancelTimerCard = this.homey.flow.getActionCard('cancel-timer');
        cancelTimerCard.registerRunListener(async (args) => {
            const device = args.device as VoiceAssistantDevice;
            try {
                device.cancelTimerFromFlow();
            } catch (error) {
                this.logger.error('Error cancelling timer:', error);
            }
        });

        const playUrlCard = this.homey.flow.getActionCard('playback-audio-from-url');
        playUrlCard.registerRunListener(async (args) => {
            const device = args.device as VoiceAssistantDevice;
            const url = args.Url;
            try {
                await device.playUrl(url);
            } catch (error) {
                this.logger.error('Error playing URL:', error);
            }
        });

        const speakTextCard = this.homey.flow.getActionCard('speak-text');
        speakTextCard.registerRunListener(async (args) => {
            const device = args.device as VoiceAssistantDevice;
            const text = args.text;
            try {
                await device.speakText(text);
            } catch (error) {
                this.logger.error('Error speaking text:', error);
            }
        });


        const askAgentAudioOutCard = this.homey.flow.getActionCard('ask-agent-output-to-speaker');
        askAgentAudioOutCard.registerRunListener(async (args) => {
            const device = args.device as VoiceAssistantDevice;
            const question = args.Question;
            try {
                await device.askAgentOutputToSpeaker(question);
            } catch (error) {
                this.logger.error('Error asking agent output to speaker:', error);
            }
        });



        const askAgentTextOutCard = this.homey.flow.getActionCard('ask-agent-output-as-text');
        askAgentTextOutCard.registerRunListener(async (args) => {
            const device = args.device as VoiceAssistantDevice;
            const question = args.Question;
            try {
                const response = await device.askAgentOutputToText(question);
                return {
                    'ai-output': response
                };
            } catch (error: any) {
                this.logger.error('Error getting text response:', error);
                return {
                    'ai-output': `Error: ${error.message || 'Unknown error occurred'}`
                };
            }
        });

        this.logger.info('Initialized');
    }

    /**
     * Convert a Homey Discovery result to our PairDevice shape.
     */
    private resultToDevice(r: any): PairDevice {
        return {
            name: r.txt?.friendly_name || r.name || r.host || `ESPHome ${String(r.id).slice(-4)}`,
            data: { id: r.id }, // must stay stable and match device.ts:onDiscoveryResult
            store: {
                address: r.address,
                port: r.port ?? 6053,
                mac: r.txt?.mac,
                platform: r.txt?.platform,
                serviceName: r.name,
                deviceType: null,
                // ESPHome advertises txt.api_encryption when an API encryption
                // key is configured — plaintext (and thus the capability probe)
                // is refused, so this is known before ever touching the device.
                requiresEncryption: !!r.txt?.api_encryption,
            },
        };
    }

    /**
     * Flag a pair-list entry as needing an encryption key and make that visible
     * in the device list (selecting it routes to manual entry, not add_devices).
     */
    private markRequiresEncryption(device: PairDevice): PairDevice {
        device.store.requiresEncryption = true;
        if (!device.name.includes('encryption key')) {
            device.name = `${device.name} (needs encryption key)`;
        }
        return device;
    }

    /**
     * Whether an encrypted (un-probeable) discovery result plausibly belongs to
     * this driver. Without a key the identity handshake can't run, so the mDNS
     * platform TXT record is the only signal: ThirdReality announces
     * platform=ThirdReality; PE/XiaoZhi both announce esp32 and can't be told
     * apart here — the keyed manual probe does the authoritative check later.
     */
    private encryptedResultMatchesDriver(device: PairDevice): boolean {
        const isThirdReality = /thirdreality/i.test(device.store.platform ?? '');
        return this.thisAssistantType === 'tr' ? isThirdReality : !isThirdReality;
    }

    /**
     * Returns enriched device if it supports voice, otherwise null. Ensures
     * cleanup + timeout. `definitive` tells the caller whether the outcome is
     * final (the device answered and identified itself — match or mismatch) or
     * transient (timeout / connection failure — e.g. a satellite whose mDNS is
     * already up but whose API server is still booting), so background re-scans
     * can retry transient failures without hammering known-foreign devices.
     */
    private async checkVoiceCapabilities(device: PairDevice, timeoutMs = 5000): Promise<{ device: PairDevice | null; definitive: boolean }> {

        let client: EspVoiceAssistantClient | null = null;
        let done = false;
        let intentionalDisconnect = false;
        let resultToReturn: { device: PairDevice | null; definitive: boolean } = { device: null, definitive: false };

        const finish = async (result: PairDevice | null, definitive: boolean) => {
            if (done) return;
            done = true;
            resultToReturn = { device: result, definitive };

            // stop further handlers from flipping the result
            try {
                intentionalDisconnect = true;
                // Detach listeners first (if your client supports it)
                client?.off?.('capabilities', onCapabilities as any);
                client?.off?.('Unhealthy', onDisconnected as any);
                client?.off?.('requires_encryption', onRequiresEncryption as any);

            } catch { }

            try {
                if (client) await client.disconnect();
            } catch { }
            client = null;

            return result;
        };

        const onCapabilities = async (mediaPlayersCount: number, subscribeVoiceAssistantCount: number, voiceAssistantConfigurationCount: number, deviceType: string | null) => {

            this.logger.info(`Capabilities from ${device.name}`, undefined, {
                mediaPlayersCount,
                subscribeVoiceAssistantCount,
                voiceAssistantConfigurationCount,
                deviceType,
            });        

            if (this.thisAssistantType == deviceType && mediaPlayersCount > 0 && subscribeVoiceAssistantCount > 0 && voiceAssistantConfigurationCount > 0) {
                this.logger.info(`Found matching device: ${deviceType}`);
                device.store.deviceType = deviceType;
                await finish(device, true);
                return;
            } else {
                // Explicitly reject devices that don't match our type
                await finish(null, true);
                return;
            }
        };

        const onDisconnected = async () => {
            // Ignore if *we* initiated the disconnect after success/finish
            if (!intentionalDisconnect && !done) {
                await finish(null, false);
            }
        };

        // The device refuses plaintext (it has an API encryption key set), so
        // its identity can't be probed. Where the pair flow can collect a key
        // (PE/TR), list it anyway — selecting it routes to manual entry with
        // the address prefilled. Otherwise it's a definitive reject.
        const onRequiresEncryption = async () => {
            if (this.supportsEncryptedPairing && this.encryptedResultMatchesDriver(device)) {
                this.pairLogger.info(`${device.name} has API encryption enabled — listing it; selection routes to manual entry`);
                await finish(this.markRequiresEncryption(device), true);
                return;
            }
            this.pairLogger.info(`${device.name} has API encryption enabled — add it via manual IP entry with its encryption key`);
            await finish(null, true);
        };

        return new Promise<{ device: PairDevice | null; definitive: boolean }>(async (resolve) => {
            try {
                client = new EspVoiceAssistantClient(this.homey, {
                    host: device.store.address,
                    apiPort: device.store.port,
                    discoveryMode: true,
                });

                client.on('capabilities', onCapabilities as any);
                client.on?.('Unhealthy', onDisconnected as any);
                client.on?.('requires_encryption', onRequiresEncryption as any);

                await client.start();

                this.homey.setTimeout(async () => {
                    if (!done) await finish(null, false);
                }, timeoutMs).unref?.();

                // Resolve when finish() completes with the stored result
                const poll = () => done ? resolve(resultToReturn) : this.homey.setTimeout(poll, 10);
                poll();
            } catch {
                resolve({ device: null, definitive: false });
            }
        });
    }

    /**
     * Probe a manually-entered IP/port (mDNS-free path). Connects directly, waits
     * for the capabilities handshake, and — if the device answers as this
     * driver's model — builds a PairDevice from the handshake identity
     * (DeviceInfoResponse), deriving a stable id from the MAC so it matches the
     * mDNS discovery id ({{txt.mac}}) and DHCP moves are still tracked if the
     * device later appears over mDNS. Returns null (with a reason) when the host
     * is unreachable or is not a matching voice device.
     *
     * An optional ESPHome API encryption key runs the connection over the
     * Noise handshake; key problems come back as precise reasons (wrong_key,
     * plaintext_device, requires_encryption, invalid_key) for the pair view.
     */
    private async probeManualEntry(address: string, port: number, encryptionKey?: string, timeoutMs = 8000): Promise<{ device: PairDevice | null; reason: string }> {
        let client: EspVoiceAssistantClient | null = null;
        let done = false;

        return new Promise<{ device: PairDevice | null; reason: string }>((resolve) => {
            const finish = async (device: PairDevice | null, reason: string) => {
                if (done) return;
                done = true;
                try {
                    client?.off?.('capabilities', onCapabilities as any);
                    client?.off?.('Unhealthy', onUnhealthy as any);
                    client?.off?.('requires_encryption', onRequiresEncryption as any);
                    client?.off?.('encryption_error', onEncryptionError as any);
                } catch { }
                try {
                    if (client) await client.disconnect();
                } catch { }
                client = null;
                resolve({ device, reason });
            };

            const onCapabilities = async (mediaPlayersCount: number, subscribeVoiceAssistantCount: number, voiceAssistantConfigurationCount: number, deviceType: string | null) => {
                const isMatch = this.thisAssistantType === deviceType
                    && mediaPlayersCount > 0
                    && subscribeVoiceAssistantCount > 0
                    && voiceAssistantConfigurationCount > 0;

                if (!isMatch) {
                    this.pairLogger.info(`Manual entry ${address}:${port} answered but is not a matching device`, undefined, { deviceType });
                    await finish(null, 'not_a_match');
                    return;
                }

                const mac = client?.getMacAddress() || '';
                const friendly = client?.getFriendlyName() || '';
                const device: PairDevice = {
                    name: friendly || `ESPHome ${address}`,
                    // Prefer the MAC so the id matches the mDNS discovery id; fall
                    // back to host:port only when the device withheld its MAC.
                    data: { id: mac || `${address}:${port}` },
                    store: {
                        address,
                        port,
                        mac: mac || undefined,
                        deviceType,
                        // The key the probe just succeeded with — every future
                        // connection to this device needs it.
                        encryptionKey: encryptionKey || undefined,
                    },
                    // Mirror it into the user-editable device setting so it is
                    // visible/fixable without re-pairing.
                    settings: encryptionKey ? { encryption_key: encryptionKey } : undefined,
                };
                this.pairLogger.info(`Manual entry ${address}:${port} matched: ${device.name} (${device.data.id})${encryptionKey ? ' [encrypted]' : ''}`);
                await finish(device, 'ok');
            };

            const onUnhealthy = async () => {
                await finish(null, 'unreachable');
            };

            // Plaintext probe against an encrypted device: the key is missing.
            const onRequiresEncryption = async () => {
                await finish(null, 'requires_encryption');
            };

            // Noise-path failures map straight to pair-view reasons:
            // wrong_key / plaintext_device / mac_mismatch / invalid_key /
            // protocol_error (see EspVoiceEvents.encryption_error).
            const onEncryptionError = async (code: string) => {
                this.pairLogger.info(`Manual probe ${address}:${port} encryption error: ${code}`);
                await finish(null, code);
            };

            try {
                client = new EspVoiceAssistantClient(this.homey, {
                    host: address,
                    apiPort: port,
                    discoveryMode: true,
                    encryptionKey: encryptionKey || undefined,
                });
                client.on('capabilities', onCapabilities as any);
                client.on?.('Unhealthy', onUnhealthy as any);
                client.on?.('requires_encryption', onRequiresEncryption as any);
                client.on?.('encryption_error', onEncryptionError as any);
                client.start().catch(() => { finish(null, 'unreachable'); });
                this.homey.setTimeout(() => { if (!done) finish(null, 'timeout'); }, timeoutMs).unref?.();
            } catch {
                finish(null, 'unreachable');
            }
        });
    }

    /**
     * Limit concurrency so we don't open too many sockets at once.
     */
    private async filterByVoiceCapabilities(devices: PairDevice[], { timeoutMs = 5000, concurrency = 4 } = {}): Promise<{ capable: PairDevice[]; rejectedIds: string[] }> {
        const queue = devices.slice();
        const capable: PairDevice[] = [];
        const rejectedIds: string[] = [];

        const worker = async () => {
            while (queue.length) {
                const d = queue.shift()!;
                const outcome = await this.checkVoiceCapabilities(d, timeoutMs);
                this.logger.info(`Checked device ${d.name} (${d.store.address}:${d.store.port})`, undefined, { outcome });
                if (outcome.device) capable.push(outcome.device);
                else if (outcome.definitive) rejectedIds.push(String(d.data.id));
                // transient failures land in neither list — eligible for a retry
            }
        };

        const workers = Array.from({ length: Math.min(concurrency, devices.length) }, worker);
        await Promise.all(workers);

        this.logger.info(`Checked ${devices.length} devices for voice capabilities`, undefined, { capable: capable.length, rejected: rejectedIds.length });

        return { capable, rejectedIds };
    }

    /**
     * Custom pair flow: the "start" view offers the normal network search
     * (list_devices, backed by onPairListDevices below) or the Bluetooth
     * Wi-Fi setup wizard (improv_setup view) for satellites that are not on
     * the network yet. The Improv handlers live in src/ble/ so they stay
     * unit-testable without the Homey SDK.
     */
    async onPair(session: Homey.Driver.PairSession): Promise<void> {
        // Diagnostic breadcrumb for the intermittently-blank first pair view:
        // if this line appears but the dialog is empty, the session reached the
        // app and the blank is client-side (Homey app rendering); if it never
        // appears, the pair session itself failed to start.
        this.pairLogger.info(`Pair session started (${this.thisAssistantType})`);

        // Live-updating device list: a satellite fresh out of the BLE Wi-Fi
        // wizard can take up to a minute to join the network and announce
        // itself over mDNS, so a one-shot scan often comes up empty. The
        // list_devices handler re-scans every 5s and holds its promise open
        // (spinner) until something is found or a 2-minute deadline passes;
        // afterwards stragglers are appended via session.emit('list_devices').
        // Per-session probe cache: capable devices and definitive rejections
        // (device answered, wrong model) are never re-probed; transient
        // failures (no answer yet) are retried every round.
        const probed = new Map<string, PairDevice | null>();
        let pollTimer: NodeJS.Timeout | null = null;
        let pollDeadline = 0;

        const capableDevices = () => [...probed.values()].filter((d): d is PairDevice => d !== null);

        const listDevicesRound = async (): Promise<PairDevice[]> => {
            const strategy = this.getDiscoveryStrategy();
            if (!strategy) {
                this.logger.info('No discovery strategy configured for this driver');
                return [];
            }
            const candidates = Object.values(strategy.getDiscoveryResults())
                .map((r: any) => this.resultToDevice(r))
                .filter((d) => !probed.has(String(d.data.id)));

            // Devices whose mDNS TXT record announces api_encryption refuse
            // plaintext, so the capability probe can never succeed — skip it.
            // Where the pair flow can collect a key (PE/TR), list them so
            // selection routes to manual entry; otherwise hide them as before.
            const probeable: PairDevice[] = [];
            for (const d of candidates) {
                if (!d.store.requiresEncryption) {
                    probeable.push(d);
                } else if (this.supportsEncryptedPairing && this.encryptedResultMatchesDriver(d)) {
                    this.pairLogger.info(`${d.name} (${d.store.address}) advertises api_encryption — listing without probing`);
                    probed.set(String(d.data.id), this.markRequiresEncryption(d));
                } else {
                    probed.set(String(d.data.id), null);
                }
            }

            if (probeable.length) {
                const { capable, rejectedIds } = await this.filterByVoiceCapabilities(probeable, { timeoutMs: 5_000, concurrency: 4 });
                for (const d of capable) probed.set(String(d.data.id), d);
                for (const id of rejectedIds) probed.set(id, null);
            }
            return capableDevices();
        };

        let searchCancelled = false;

        const stopListPolling = () => {
            searchCancelled = true;
            if (pollTimer) {
                this.homey.clearTimeout(pollTimer);
                pollTimer = null;
            }
        };

        const sleep = (ms: number) => new Promise<void>((resolve) => {
            this.homey.setTimeout(resolve, ms).unref?.();
        });

        // After the initial (non-empty) list resolved, keep looking for
        // stragglers and append them via session.emit — appending to an
        // already-populated list renders cleanly in the system template.
        const scheduleListPoll = () => {
            if (searchCancelled || Date.now() >= pollDeadline) return;
            pollTimer = this.homey.setTimeout(async () => {
                pollTimer = null;
                try {
                    const before = capableDevices().length;
                    const devices = await listDevicesRound();
                    if (devices.length !== before) {
                        this.pairLogger.info(`Background scan found ${devices.length - before} new device(s) — updating pair list`);
                        await session.emit('list_devices', devices);
                    }
                } catch (err) {
                    this.logger.error('Background pair-list scan failed', err);
                }
                scheduleListPoll();
            }, 5_000);
            pollTimer.unref?.();
        };

        session.setHandler('list_devices', async () => {
            searchCancelled = false;
            pollDeadline = Date.now() + 120_000;

            // Hold the promise open while nothing is found: the system template
            // keeps showing "Searching for new devices…" until we return.
            // Resolving with an empty list and emitting devices later leaves the
            // template's "No new devices" text on screen with the late device
            // rendered awkwardly below it — so empty only resolves at deadline.
            let devices = await listDevicesRound();
            while (!devices.length && !searchCancelled && Date.now() < pollDeadline) {
                await sleep(5_000);
                if (searchCancelled) break;
                devices = await listDevicesRound();
            }

            if (devices.length) scheduleListPoll();
            return devices;
        });

        // Manual IP entry: fallback for networks where mDNS multicast does not
        // reach the Homey (e.g. Wi-Fi-only Homey Pro). The manual_entry pair view
        // collects host + port and asks us to verify + add the device directly,
        // bypassing discovery entirely. Returns a small result object the view
        // renders as a success/error message.
        session.setHandler('manual_probe', async (payload: { address?: string; port?: number; encryptionKey?: string }) => {
            const address = (payload?.address ?? '').trim();
            const port = Number(payload?.port) || 6053;
            const encryptionKey = (payload?.encryptionKey ?? '').trim();

            if (!address) {
                return { ok: false, reason: 'no_address' };
            }

            // Reject a malformed key before ever touching the network (the pair
            // view validates too; this is the authoritative check).
            if (encryptionKey && !NoiseFrameCodec.decodePsk(encryptionKey)) {
                return { ok: false, reason: 'invalid_key' };
            }

            // A manual add is a deliberate action — stop background list polling
            // so the two paths don't race for the device's single API slot.
            stopListPolling();

            this.pairLogger.info(`Manual probe requested for ${address}:${port}${encryptionKey ? ' (with encryption key)' : ''}`);
            const { device, reason } = await this.probeManualEntry(address, port, encryptionKey || undefined);

            if (!device) {
                this.pairLogger.info(`Manual probe for ${address}:${port} failed: ${reason}`);
                return { ok: false, reason };
            }

            return { ok: true, device };
        });

        // Encrypted-device detour: list_devices navigates to encryption_check
        // (a loading-template view) instead of straight to add_devices. The
        // showView handler below inspects the selection there — encrypted
        // devices can't be added by the system flow (no key yet), so they
        // route to manual entry with the address prefilled; everything else
        // continues to add_devices unchanged. (XiaoZhi keeps the direct
        // list_devices → add_devices navigation and never hits this.)
        let selectedDevices: PairDevice[] = [];
        session.setHandler('list_devices_selection', async (devices: PairDevice[]) => {
            selectedDevices = devices ?? [];
        });

        // Prefill for the manual-entry view; set when an encrypted device is
        // redirected there, read by the view on load (manual_get_prefill).
        let manualPrefill: { address: string; port: number } | null = null;
        session.setHandler('manual_get_prefill', async () => manualPrefill);

        const routeEncryptionCheck = async () => {
            const encrypted = selectedDevices.find((d) => d?.store?.requiresEncryption);
            if (!encrypted) {
                await session.showView('add_devices');
                return;
            }
            manualPrefill = { address: encrypted.store.address, port: encrypted.store.port ?? 6053 };
            if (selectedDevices.length > 1) {
                this.pairLogger.info('Selection mixed encrypted and plain devices — detouring to manual entry; add the others in a new pair session');
            }
            this.pairLogger.info(`${encrypted.name} requires an encryption key — redirecting to manual entry (${encrypted.store.address})`);
            await session.showView('manual_entry');
        };

        const improv = registerImprovPairHandlers({
            session,
            ble: this.homey.ble,
            deviceNameFilter: this.improvNameFilter ?? undefined,
            // Stop background re-scanning once the user navigates away from
            // the device list (e.g. on to add_devices).
            onShowView: async (viewId) => {
                if (viewId !== 'list_devices') stopListPolling();
                if (viewId === 'encryption_check') await routeEncryptionCheck();
            },
        });

        // Fired when the pair dialog closes — never leave a BLE connection open
        // or a scan loop running.
        session.setHandler('disconnect', async () => {
            stopListPolling();
            await improv.dispose();
        });
    }

    /**
     * One-shot list scan (discovery results -> probe -> capable devices only).
     * The pair flow itself uses the live-updating loop in onPair; this remains
     * for any SDK path that calls the default hook directly.
     */
    async onPairListDevices() {
        const strategy = this.getDiscoveryStrategy();

        if (!strategy) {
            this.logger.info('No discovery strategy configured for this driver');
            return [];
        }

        const candidates: PairDevice[] = Object.values(strategy.getDiscoveryResults())
            .map((r: any) => this.resultToDevice(r));

        const { capable } = await this.filterByVoiceCapabilities(candidates, {
            timeoutMs: 5_000,
            concurrency: 4, // tune if you have many devices
        });

        return capable;
    }

}
