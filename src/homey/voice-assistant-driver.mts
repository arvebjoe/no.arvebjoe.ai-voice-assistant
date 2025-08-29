import Homey from 'homey';
import { EspVoiceAssistantClient } from '../voice_assistant/esp-voice-assistant-client.mjs';
import { PairDevice } from '../helpers/interfaces.mjs';
import VoiceAssistantDevice from './voice-assistant-device.mjs';
import { createLogger } from '../helpers/logger.mjs';


export default abstract class VoiceAssistantDriver extends Homey.Driver {
    abstract readonly thisAssistantType: string;
    private logger = createLogger('Voice_Assistant_Driver', true);
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
            return device.isMuted();
        });

        const playUrlCard = this.homey.flow.getActionCard('playback-audio-from-url');
        playUrlCard.registerRunListener(async (args) => {
            const device = args.device as VoiceAssistantDevice;
            const url = args.Url;
            device.playUrl(url);
        });

        const speakTextCard = this.homey.flow.getActionCard('speak-text');
        speakTextCard.registerRunListener(async (args) => {
            const device = args.device as VoiceAssistantDevice;
            const text = args.text;
            device.speakText(text);
        });


        const askAgentAudioOutCard = this.homey.flow.getActionCard('ask-agent-output-to-speaker');
        askAgentAudioOutCard.registerRunListener(async (args) => {
            const device = args.device as VoiceAssistantDevice;
            const question = args.Question;
            await device.askAgentOutputToSpeaker(question);
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
                this.error('Error getting text response:', error);
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
     * Returns enriched device if it supports voice,
     * otherwise resolves to null. Ensures cleanup + timeout.
     */
    private async checkVoiceCapabilities(device: PairDevice, timeoutMs = 5000): Promise<PairDevice | null> {

        let client: EspVoiceAssistantClient | null = null;
        let done = false;
        let intentionalDisconnect = false;
        let resultToReturn: PairDevice | null = null;

        const finish = async (result: PairDevice | null) => {
            if (done) return;
            done = true;
            resultToReturn = result; // Store the result for later use

            // stop further handlers from flipping the result
            try {
                intentionalDisconnect = true;
                // Detach listeners first (if your client supports it)
                client?.off?.('capabilities', onCapabilities as any);
                client?.off?.('disconnected', onDisconnected as any);

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
                await finish(device);
                return;
            } else {
                // Explicitly reject devices that don't match our type
                await finish(null);
                return;
            }
        };

        const onDisconnected = async () => {
            // Ignore if *we* initiated the disconnect after success/finish
            if (!intentionalDisconnect && !done) {
                await finish(null);
            }
        };

        return new Promise<PairDevice | null>(async (resolve) => {
            try {
                client = new EspVoiceAssistantClient({
                    host: device.store.address,
                    apiPort: device.store.port,
                    discoveryMode: true,
                });

                client.on('capabilities', onCapabilities as any);
                client.on?.('disconnected', onDisconnected as any);

                await client.start();

                setTimeout(async () => {
                    if (!done) await finish(null);
                }, timeoutMs).unref?.();

                // Resolve when finish() completes with the stored result
                const poll = () => done ? resolve(resultToReturn) : setTimeout(poll, 10);
                poll();
            } catch {
                resolve(null);
            }
        });
    }

    /**
     * Limit concurrency so we don't open too many sockets at once.
     */
    private async filterByVoiceCapabilities(devices: PairDevice[], { timeoutMs = 5000, concurrency = 4 } = {}): Promise<PairDevice[]> {
        const queue = devices.slice();
        const results: PairDevice[] = [];

        const worker = async () => {
            while (queue.length) {
                const d = queue.shift()!;
                const ok = await this.checkVoiceCapabilities(d, timeoutMs);
                this.logger.info(`Checked device ${d.name} (${d.store.address}:${d.store.port})`, undefined, { ok });
                if (ok) results.push(ok);
            }
        };

        const workers = Array.from({ length: Math.min(concurrency, devices.length) }, worker);
        await Promise.all(workers);

        this.logger.info(`Checked ${results.length} devices for voice capabilities`, undefined, { results });

        return results;
    }

    /**
     * One-shot list call used by the default Add Devices UI.
     * 1) Read discovery results
     * 2) Map to PairDevice
     * 3) Probe voice capability (your logic)
     * 4) Return only capable devices
     */
    async onPairListDevices() {
        const strategy = this.getDiscoveryStrategy();

        if (!strategy) {
            this.logger.info('No discovery strategy configured for this driver');
            return [];
        }

        const results = strategy.getDiscoveryResults();        

        // Step 1–2: discovery -> PairDevice[]
        const candidates: PairDevice[] = Object.values(results).map((r: any) => this.resultToDevice(r));

        // Step 3: run your capability filter (kept separate and readable)
        const capable = await this.filterByVoiceCapabilities(candidates, {
            timeoutMs: 5_000,
            concurrency: 4, // tune if you have many devices
        });

        // Step 4: return to Homey
        return capable;
    }

}
