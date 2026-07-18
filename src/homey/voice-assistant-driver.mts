import Homey from 'homey';
import { EspVoiceAssistantClient } from '../voice_assistant/esp-voice-assistant-client.mjs';
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
            },
        };
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

        return new Promise<{ device: PairDevice | null; definitive: boolean }>(async (resolve) => {
            try {
                client = new EspVoiceAssistantClient(this.homey, {
                    host: device.store.address,
                    apiPort: device.store.port,
                    discoveryMode: true,
                });

                client.on('capabilities', onCapabilities as any);
                client.on?.('Unhealthy', onDisconnected as any);

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
            if (candidates.length) {
                const { capable, rejectedIds } = await this.filterByVoiceCapabilities(candidates, { timeoutMs: 5_000, concurrency: 4 });
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

        const improv = registerImprovPairHandlers({
            session,
            ble: this.homey.ble,
            deviceNameFilter: this.improvNameFilter ?? undefined,
            // Stop background re-scanning once the user navigates away from
            // the device list (e.g. on to add_devices).
            onShowView: (viewId) => {
                if (viewId !== 'list_devices') stopListPolling();
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
