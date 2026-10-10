import { IVoiceProvider, VoiceProviderOptions } from '../llm/voice-provider.mjs';
import { createVoiceProvider, DEFAULT_VOICE_PROVIDER, getVoicesForProvider } from '../llm/voice-provider-factory.mjs';
import { ToolManager } from '../llm/tool-manager.mjs';
import { settingsManager } from '../settings/settings-manager.mjs';
import { flacToPcmBuffer, pcmToMp3Buffer } from '../helpers/audio-encoders.mjs';
import { resamplePcm16Mono } from '../helpers/wav.mjs';
import { scheduleAudioFileDeletion } from '../helpers/file-helper.mjs';
import { AppServices } from '../helpers/app-services.mjs';
import { createLogger } from '../helpers/logger.mjs';

// Same container/rate as a device's Flow-URL reply (see FLOW_URL_* in
// voice-assistant-device.mts): the URL goes to a third-party speaker, and MP3
// at 48 kHz is what every networked player handles.
const FLOW_AUDIO_SAMPLE_RATE = 48_000;

// Grace on top of playback length before the file is deleted. Longer than the
// device path's 2 minutes: these cards exist for announcement Flows, which
// often group speakers, wait for a door or delay before they play the URL.
const FLOW_AUDIO_GRACE_MS = 5 * 60_000;

// How long an ask waits for the provider to come up (OpenAI: session.updated).
const CONNECT_TIMEOUT_MS = 20_000;
// How long an ask waits for its answer — matches the device's text ask.
const ANSWER_TIMEOUT_MS = 30_000;
// A realtime provider holds a websocket open; nobody needs it between Flows.
const IDLE_CLOSE_MS = 5 * 60_000;

export type FlowSpeech = {
    url: string;
    /** Seconds, rounded. */
    duration: number;
};

/**
 * The app-level ("headless") assistant behind the device-less Flow cards:
 * *Create speech*, *Ask assistant* and *Ask assistant and create speech*. It
 * owns its own provider + ToolManager — no satellite, no ESP client — so the
 * app is useful to users without a voice device: the speech comes back as a
 * LAN URL that a Flow plays on Sonos, Chromecast or any speaker that takes one.
 *
 * Built lazily on first use from the same global settings a device uses
 * (provider, voice, language, AI instructions, feature gates). Any settings
 * save marks it stale and the next call rebuilds it — cheaper and simpler than
 * mirroring the device's per-setting reconcilers for a path that runs a few
 * times a day. After a few idle minutes the provider is closed again.
 *
 * Every call runs through one queue: the providers answer text asks on a
 * shared `text.done` broadcast with no request id (the device serializes for
 * the same reason), and a per-call voice override must not leak into a
 * concurrent call.
 */
export class FlowAssistant {
    private logger = createLogger('FLOW_ASSISTANT');
    private provider: IVoiceProvider | null = null;
    private toolManager: ToolManager | null = null;
    private ready = false;
    private stale = false;
    private queue: Promise<unknown> = Promise.resolve();
    private idleTimer: any = null;
    private unsubscribe: (() => void) | null = null;

    constructor(private homey: any, private services: AppServices) {}

    init(): void {
        // The first callback is the initial snapshot — nothing built yet, so
        // marking stale is harmless.
        this.unsubscribe = settingsManager.onGlobals(() => {
            this.stale = true;
        });
    }

    dispose(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.teardown();
    }

    /** Voices for the card's autocomplete, from the currently selected provider. */
    async voiceOptions(query: string): Promise<{ name: string; id: string }[]> {
        const providerId = settingsManager.getGlobal<string>('voice_provider', DEFAULT_VOICE_PROVIDER);
        const voices = await getVoicesForProvider(providerId);
        const q = (query ?? '').trim().toLowerCase();
        return voices
            .filter((v) => !q || v.name.toLowerCase().includes(q) || v.value.toLowerCase().includes(q))
            .map((v) => ({ name: v.name, id: v.value }));
    }

    /** Text -> speech, served as an MP3 URL. `voice` overrides the app's voice for this call. */
    speak(text: string, voice?: string): Promise<FlowSpeech> {
        return this.enqueue(async () => {
            this.logger.info(`Create speech: "${text}"${voice ? ` (voice ${voice})` : ''}`);
            return this.synthesize(text, voice);
        });
    }

    /** Ask the assistant (tools included — it can read and control the home); returns the answer text. */
    ask(question: string): Promise<string> {
        return this.enqueue(async () => {
            this.logger.info(`Ask: "${question}"`);
            return this.askNow(question);
        });
    }

    /** Ask, then speak the answer. One queue slot, so the voice can't change in between. */
    askAndSpeak(question: string, voice?: string): Promise<FlowSpeech & { answer: string }> {
        return this.enqueue(async () => {
            this.logger.info(`Ask with speech: "${question}"${voice ? ` (voice ${voice})` : ''}`);
            const answer = await this.askNow(question);
            if (!answer.trim()) {
                throw new Error('The assistant gave no answer');
            }
            return { answer, ...(await this.synthesize(answer, voice)) };
        });
    }

    // --- internals -------------------------------------------------------------

    private enqueue<T>(job: () => Promise<T>): Promise<T> {
        const run = this.queue.then(() => {
            this.clearIdleTimer();
            return job();
        });
        // A failed call must not wedge later ones.
        this.queue = run.then(() => undefined, () => undefined).then(() => this.armIdleTimer());
        return run;
    }

    private async synthesize(text: string, voice?: string): Promise<FlowSpeech> {
        if (!text.trim()) {
            throw new Error('No text to speak');
        }
        const provider = this.ensureProvider();
        const defaultVoice = this.defaultVoice();
        const override = voice && voice !== defaultVoice ? voice : null;

        let flac: Buffer;
        if (override) {
            await provider.updateVoice(override);
        }
        try {
            flac = await provider.textToSpeech(text);
        } finally {
            if (override) {
                await provider.updateVoice(defaultVoice);
            }
        }

        // textToSpeech() returns FLAC (the seam's contract); re-encode for the
        // third-party speaker the same way the feedback clips are.
        const { pcm, sampleRate, channels } = await flacToPcmBuffer(flac);
        const durationMs = Math.round((pcm.length / (2 * channels) / sampleRate) * 1000);
        const shouldResample = channels === 1 && sampleRate !== FLOW_AUDIO_SAMPLE_RATE;
        const samples = shouldResample ? resamplePcm16Mono(pcm, sampleRate, FLOW_AUDIO_SAMPLE_RATE) : pcm;
        const mp3 = await pcmToMp3Buffer(samples, {
            sampleRate: shouldResample ? FLOW_AUDIO_SAMPLE_RATE : sampleRate,
            channels,
            bitsPerSample: 16,
        });

        const fileInfo = await this.services.webServer.buildStream({ data: mp3, extension: 'mp3', prefix: 'flow' });
        scheduleAudioFileDeletion(this.homey, fileInfo, durationMs + FLOW_AUDIO_GRACE_MS);
        this.logger.info(`Speech ready: ${fileInfo.url} (${durationMs} ms)`);
        return { url: fileInfo.url, duration: Math.round(durationMs / 1000) };
    }

    private async askNow(question: string): Promise<string> {
        const provider = this.ensureProvider();
        await this.ensureConnected(provider);
        // Every Flow ask stands alone — a dishwasher announcement must not be
        // answered in the context of this morning's weather summary.
        provider.resetConversation();
        await this.services.deviceManager.fetchData();

        return new Promise<string>((resolve, reject) => {
            let timeoutId: any = null;
            const done = (msg: any) => {
                this.homey.clearTimeout(timeoutId);
                resolve(String(msg?.text ?? ''));
            };
            const fail = (err: any) => {
                this.homey.clearTimeout(timeoutId);
                provider.off('text.done', done);
                reject(err instanceof Error ? err : new Error(String(err)));
            };
            provider.once('text.done', done);
            timeoutId = this.homey.setTimeout(() => fail(new Error('Timeout waiting for the assistant to answer')), ANSWER_TIMEOUT_MS);
            try {
                this.toolManager?.noteUserTurn();
                Promise.resolve(provider.sendTextForTextResponse(question)).catch(fail);
            } catch (err) {
                fail(err);
            }
        });
    }

    private ensureProvider(): IVoiceProvider {
        if (this.provider && this.stale) {
            this.logger.info('Settings changed — rebuilding the Flow assistant');
            this.teardown();
        }
        if (this.provider) {
            return this.provider;
        }
        this.stale = false;

        // No room of its own: tools that default to "this room" have nothing to
        // default to, so the model has to name the zone (or ask for all of them).
        const zone = '';
        const toolManager = new ToolManager(this.homey, zone, this.services.deviceManager,
            this.services.geoHelper, this.services.weatherHelper);
        const options: VoiceProviderOptions = {
            voice: this.defaultVoice(),
            languageCode: settingsManager.getGlobal('selected_language_code') || 'en',
            languageName: settingsManager.getGlobal('selected_language_name') || 'English',
            additionalInstructions: settingsManager.getGlobal('ai_instructions') || '',
            deviceZone: zone,
            // No satellite, so no timer ring to run one on.
            supportsTimers: false,
            supportsShoppingList: toolManager.isShoppingListActive(),
            supportsMusic: toolManager.isMusicActive(),
            supportsJev: toolManager.isJevActive(),
        };
        const provider = createVoiceProvider(this.homey, toolManager, options);
        provider.on('open', () => { this.ready = true; });
        provider.on('close', () => { this.ready = false; });
        // Errors surface on the card that hit them; the provider's own reconnect
        // campaign is not ours to drive, so just keep them out of the crash path.
        provider.on('error', (err) => this.logger.warn('Provider error:', err));

        this.provider = provider;
        this.toolManager = toolManager;
        this.ready = false;
        return provider;
    }

    private async ensureConnected(provider: IVoiceProvider): Promise<void> {
        if (!provider.hasApiKey()) {
            throw new Error('No API key set for the selected AI engine — add it in the app settings');
        }
        if (this.ready && provider.isConnected()) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const onOpen = () => {
                this.homey.clearTimeout(timeoutId);
                resolve();
            };
            const timeoutId = this.homey.setTimeout(() => {
                provider.off('open', onOpen);
                reject(new Error('Could not connect to the AI engine'));
            }, CONNECT_TIMEOUT_MS);
            provider.once('open', onOpen);
            Promise.resolve(provider.start()).catch((err) => {
                this.homey.clearTimeout(timeoutId);
                provider.off('open', onOpen);
                reject(err);
            });
        });
    }

    private defaultVoice(): string {
        return settingsManager.getGlobal('selected_voice') || 'alloy';
    }

    private armIdleTimer(): void {
        this.clearIdleTimer();
        this.idleTimer = this.homey.setTimeout(() => {
            this.idleTimer = null;
            if (this.provider) {
                this.logger.info('Idle — closing the Flow assistant');
                this.teardown();
            }
        }, IDLE_CLOSE_MS);
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) {
            this.homey.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    private teardown(): void {
        this.clearIdleTimer();
        const provider = this.provider;
        this.provider = null;
        this.toolManager = null;
        this.ready = false;
        if (provider) {
            try {
                provider.close();
            } catch (err) {
                this.logger.warn('Closing the provider failed:', err);
            }
            provider.removeAllListeners();
        }
    }
}
