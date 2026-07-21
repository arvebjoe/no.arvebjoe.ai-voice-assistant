import WebSocket from "ws";
import { EventEmitter } from "events";
import { TypedEmitter } from "tiny-typed-emitter";
import { createLogger } from '../../helpers/logger.mjs';
import { ToolManager } from '../tool-manager.mjs';
import { IVoiceProvider, VoiceProviderEvents, VoiceProviderOptions } from '../voice-provider.mjs';
import { InstructionState } from '../instruction-state.mjs';
import { ReconnectPolicy } from '../reconnect-policy.mjs';
import { isBlankOrHallucinatedTranscript } from '../transcript-hallucinations.mjs';
import { settingsManager } from '../../settings/settings-manager.mjs';

/**
 * Event/option shapes now live in the provider-agnostic seam (`voice-provider.mts`).
 * These aliases preserve the historical names used across this file and the tests.
 */
export type RealtimeEvents = VoiceProviderEvents;
export type RealtimeOptions = VoiceProviderOptions;


type RealtimeEvent = {
    type: string;
    [k: string]: any;
};

type PendingToolCall = {
    callId: string;
    itemId?: string;
    outputIndex?: number;
    name?: string;
    argsText: string;          // streamed JSON
    executed?: boolean;        // to avoid double-runs
};

/**
 * OpenAI Realtime Agent that supports both audio and text input/output combinations:
 * 
 * Input/Output Combinations:
 * - Audio -> Audio: Use sendAudioChunk() (default behavior, output mode auto-set to "audio")
 * - Text -> Audio: Use sendTextForAudioResponse(text) or setOutputMode("audio") + sendUserText() + createResponse()
 * - Text -> Text: Use sendTextForTextResponse(text) or setOutputMode("text") + sendUserText() + createResponse()
 * 
 * Direct TTS (minimal AI processing):
 * - Text -> Audio (TTS): Use textToSpeech(text) for text-to-speech with minimal AI processing
 * 
 * Output Events:
 * - Audio output: Emits "audio.delta" events (existing behavior)
 * - Text output: Emits "text.done" events (existing behavior)
 * 
 * Default Behavior:
 * - Output mode defaults to "audio"
 * - sendAudioChunk() automatically sets output mode to "audio" (unless explicitly set to "text")
 * - Text input methods allow explicit output mode control
 */

/** OpenAI Realtime voices the settings UI offers; 'ash' is the default/fallback. */
const OPENAI_VOICES: { value: string; name: string }[] = [
    { value: 'alloy', name: 'Alloy' },
    { value: 'ash', name: 'Ash' },
    { value: 'ballad', name: 'Ballad' },
    { value: 'coral', name: 'Coral' },
    { value: 'echo', name: 'Echo' },
    { value: 'fable', name: 'Fable' },
    { value: 'nova', name: 'Nova' },
    { value: 'onyx', name: 'Onyx' },
    { value: 'sage', name: 'Sage' },
    { value: 'shimmer', name: 'Shimmer' },
    { value: 'verse', name: 'Verse' },
    { value: 'cedar', name: 'Cedar' },
    { value: 'marin', name: 'Marin' },
];
const OPENAI_DEFAULT_VOICE = 'ash';
const OPENAI_VOICE_VALUES = new Set(OPENAI_VOICES.map((v) => v.value));

/**
 * Realtime models selectable via the 'openai_model' global setting.
 * 'full' is the flagship (best quality), 'mini' is cheaper and faster.
 * The model rides in the websocket URL, so changing it requires a reconnect
 * (the device forces a restart when the setting changes).
 */
const OPENAI_REALTIME_MODELS: Record<string, string> = {
    full: 'gpt-realtime-2.1',
    mini: 'gpt-realtime-2.1-mini',
};

/**
 * Normalize a stored voice to a valid OpenAI voice. The app keeps a single
 * `selected_voice` setting shared across providers, so it may hold another
 * provider's voice name after a provider switch — fall back rather than send an
 * invalid voice the Realtime API would reject.
 */
function openaiVoiceName(voice: string | undefined | null): string {
    return voice && OPENAI_VOICE_VALUES.has(voice) ? voice : OPENAI_DEFAULT_VOICE;
}

export class OpenAIRealtimeProvider extends (EventEmitter as new () => TypedEmitter<VoiceProviderEvents>) implements IVoiceProvider {
    // Seam contract: OpenAI Realtime expects 24 kHz PCM input; its key lives under 'openai_api_key'.
    readonly inputSampleRate = 24000;
    readonly apiKeySettingKey = 'openai_api_key';

    /** Voices offered for this provider in the settings UI. */
    static getAvailableVoices(): { value: string; name: string }[] {
        return OPENAI_VOICES;
    }

    private ws?: WebSocket;
    private homey: any;
    private logger = createLogger('AGENT', true);
    private toolManager: ToolManager;
    private instructionState = new InstructionState(this.logger);

    private options: Required<
        Pick<
            RealtimeOptions,
            | "url"
            | "apiKey"
            | "voice"
            | "languageCode"
            | "languageName"
            | "additionalInstructions"
            | "deviceZone"
            | "supportsTimers"
            | "supportsShoppingList"
            | "supportsMusic"
        >
    >;
    // keep your existing maps, but store full records keyed by callId
    private pendingToolCalls: Map<string, PendingToolCall> = new Map();

    // Ids of conversation items the server has, so we can clear context on a fresh session.
    private conversationItemIds: Set<string> = new Set();

    // Reconnection campaign (shared backoff machinery — see ReconnectPolicy).
    private reconnect: ReconnectPolicy;
    private isManuallyClosing = false;
    private pingIntervalId?: NodeJS.Timeout;
    private lastPongTime = 0;
    private connectionHealthCheckInterval = 30000; // Check every 30 seconds

    // Output mode configuration
    private outputMode: "audio" | "text" = "audio"; // Default to audio output

    // Throttle for the low-quota Homey notification (one per hour, not per turn —
    // rate_limits.updated arrives after every response).
    private lastQuotaNotificationAt = 0;

    constructor(homey: any, toolManager: ToolManager, opts: RealtimeOptions) {
        super();

        this.homey = homey;
        this.toolManager = toolManager;

        this.options = {
            apiKey: opts.apiKey ?? '',
            // Empty = resolve from the 'openai_model' setting at connect time
            // (see realtimeUrl). A caller-supplied url always wins (tests).
            url: opts.url ?? '',
            voice: openaiVoiceName(opts.voice),
            languageCode: opts.languageCode ?? "en",
            languageName: opts.languageName ?? "English",
            additionalInstructions: opts.additionalInstructions ?? "",
            deviceZone: opts.deviceZone ?? "<Unknown Zone>",
            supportsTimers: opts.supportsTimers ?? false,
            supportsShoppingList: opts.supportsShoppingList ?? false,
            supportsMusic: opts.supportsMusic ?? false
        };

        this.reconnect = new ReconnectPolicy(homey, {
            connect: () => this.start(),
            onScheduled: (attempt, delay) => this.emit("reconnecting", attempt, delay),
            onAttemptFailed: (attempt, error) => this.emit("reconnectFailed", attempt, error),
        }, this.logger);

        // Kick off the instruction load; session.created awaits it before
        // configuring the session (see ensureLoaded there).
        void this.instructionState.reload(this.instructionParams());
    }

    /**
     * Websocket URL for this connection. An explicit options.url wins; otherwise
     * the model comes from the 'openai_model' global setting ('full' | 'mini'),
     * read fresh on every connect so a settings change + restart picks it up.
     */
    private realtimeUrl(): string {
        if (this.options.url) return this.options.url;
        const quality = settingsManager.getGlobal<string>('openai_model', 'full');
        const model = OPENAI_REALTIME_MODELS[quality] ?? OPENAI_REALTIME_MODELS.full;
        return `wss://api.openai.com/v1/realtime?model=${model}`;
    }

    /**
     * Act on rate_limits.updated (OPENAI_API_IMPROVEMENTS #11): warn in the log
     * when a quota window is running low, and surface a Homey notification
     * (throttled to one per hour) when it is nearly exhausted so the user learns
     * about it before requests start failing.
     */
    private checkRateLimits(msg: any): void {
        const limits = Array.isArray(msg?.rate_limits) ? msg.rate_limits : [];
        for (const l of limits) {
            if (typeof l?.remaining !== "number" || typeof l?.limit !== "number" || l.limit <= 0) continue;
            const fraction = l.remaining / l.limit;
            if (fraction >= 0.2) continue;

            this.logger.warn(`OpenAI quota low: '${l.name}' has ${l.remaining}/${l.limit} left` +
                (typeof l.reset_seconds === "number" ? ` (resets in ${Math.round(l.reset_seconds)}s)` : ""));

            if (fraction < 0.05 && Date.now() - this.lastQuotaNotificationAt > 60 * 60 * 1000) {
                this.lastQuotaNotificationAt = Date.now();
                this.homey?.notifications?.createNotification?.({
                    excerpt: `AI Assistant: OpenAI rate limit '${l.name}' almost exhausted (${l.remaining}/${l.limit} left). Responses may fail until the quota resets.`,
                }).catch((err: any) => this.logger.error("Failed to send quota notification", err));
            }
        }
    }

    /** The option fields the system prompt is built from. */
    private instructionParams() {
        return {
            languageCode: this.options.languageCode,
            languageName: this.options.languageName,
            additionalInstructions: this.options.additionalInstructions,
            supportsTimers: this.options.supportsTimers,
            supportsShoppingList: this.options.supportsShoppingList,
            supportsMusic: this.options.supportsMusic,
        };
    }


    /**
     * Connect to OpenAI Realtime WebSocket and configure the session
     * (voice, output format, STT language, server VAD, tools, instructions).
     */
    async start(): Promise<void> {

        // A fresh start() re-enables auto-reconnect. Without this a previous
        // close() (which sets isManuallyClosing) would leave every future drop
        // un-reconnected. (Matches the Gemini provider.)
        this.isManuallyClosing = false;

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return;
        }

        if (!this.options.apiKey) {
            this.emit("missing_api_key");
            return;
        }

        // A manual start() supersedes any scheduled reconnect attempt.
        this.reconnect.clearTimer();

        const url = this.realtimeUrl();
        this.logger.info("Connecting WS:", 'START', url);

        try {

            this.ws = new WebSocket(url, {
                headers: {
                    Authorization: `Bearer ${this.options.apiKey}`
                },
            });

            this.ws.on("open", () => {
                const wasReconnect = this.reconnect.attemptCount > 0;
                this.logger.info("WebSocket open");
                this.reconnect.reset(); // Successful connection ends the campaign
                this.lastPongTime = Date.now();

                this.startConnectionHealthCheck();

                if (wasReconnect) {
                    this.emit("reconnected");
                }
            });

            // onMessage is async and fire-and-forget — without this catch, any
            // throw in a server-event handler becomes an unhandled rejection
            // (fatal on modern Node).
            this.ws.on("message", (data) => {
                this.onMessage(data).catch((err) => {
                    this.logger.error("Error handling server event", err);
                });
            });

            this.ws.on("error", (err) => {
                // Closing a socket that is still CONNECTING (e.g. restart() right
                // after start(), as happens when a freshly paired device's zone
                // resolves) makes `ws` emit this synthetic error. It's the expected
                // outcome of our own close(), not a failure — don't page anyone.
                if (this.isManuallyClosing
                    && err?.message?.includes("closed before the connection was established")) {
                    this.logger.info("WebSocket closed while still connecting (expected during restart)");
                    return;
                }
                this.logger.error("WebSocket error", err);
                this.emit("error", err);
            });

            this.ws.on("close", (code, reason) => {
                this.logger.info("WebSocket closed", undefined, { code, reason: reason.toString() });
                this.stopConnectionHealthCheck();
                this.emit("close", code, reason.toString());

                // Reconnect on any unexpected close. schedule() coalesces onto a
                // pending timer, so a *failed* reconnect attempt's own close event
                // correctly schedules the next attempt (the C2 fix — start() never
                // rejects on async connect failure, so this close event is the only
                // signal that keeps the campaign alive).
                if (!this.isManuallyClosing) {
                    this.reconnect.schedule();
                }
            });

            this.ws.on("pong", () => {
                this.logger.info("Received pong", 'HEALTH');
                this.lastPongTime = Date.now();
                this.emit("Healthy");
            });

        } catch (error) {
            this.logger.error("Failed to create WebSocket", error);
            this.emit("error", error as Error);

            if (!this.isManuallyClosing) {
                this.reconnect.schedule();
            }
        }
    }

    /**
     * Gracefully close the socket.
     */
    close(code = 1000, reason = "client-close") {
        this.isManuallyClosing = true;
        this.stopConnectionHealthCheck();
        this.reconnect.reset();

        this.ws?.close(code, reason);
    }

    /**
     * Set the output mode for the agent responses.
     * @param mode - "audio" for audio output, "text" for text output
     */
    setOutputMode(mode: "audio" | "text") {
        if (this.outputMode === mode) {
            return;
        }
        this.outputMode = mode;
        this.logger.info(`Output mode set to: ${mode}`);


        this.send({
            type: "session.update",
            session: {
                type: "realtime",
                output_modalities: [this.outputMode]
            }
        });

    }

    /**
     * Send text input and get audio response (Text -> Audio).
     */
    sendTextForAudioResponse(text: string) {
        this.setOutputMode("audio");
        this.sendUserText(text);
        this.createResponse();
    }

    /**
     * Send text input and get text response (Text -> Text).
     */
    sendTextForTextResponse(question: string) {

        this.setOutputMode("text");

        this.send({
            type: "conversation.item.create",
            item: {
                type: "message",
                role: "user",
                content: [{
                    type: "input_text",
                    text: question
                }]
            }
        });

        this.send({
            type: "response.create",
            response: {
                instructions: "Answer in short text. Do not generate audio."
            }
        });

    }


    /**
     * Ask the model to respond (streaming audio + text).
     * You typically do this after a commit, or when sending pure text input.
     */
    createResponse(extra?: Record<string, any>) {
        this.assertOpen();

        const evt = {
            type: "response.create",
            response: {
                //instructions: getResponseInstructions(),
                ...extra,
            },
        };

        this.send(evt);
    }


    /**
     * Direct text-to-speech endpoint call.
     * @param text - The text to convert to speech
     */
    async textToSpeech(text: string): Promise<Buffer> {

        this.logger.info(`Converting text to speech: ${text}`);

        const r = await fetch("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.options.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-4o-mini-tts-2025-12-15",
                voice: this.options.voice,
                input: text,
                response_format: "flac", // mp3 | wav | opus | aac | flac | pcm
                instructions: "Speak in a natural, helpful tone suitable for a smart home assistant."
            }),
        });
        const buf = Buffer.from(await r.arrayBuffer());

        return buf;
    }


    /**
     * Push a PCM16 mono 24kHz chunk into the input buffer.
     * The API expects Base64-encoded audio bytes via input_audio_buffer.append.     
     */
    sendAudioChunk(pcm16Mono24k: Buffer) {
        if (pcm16Mono24k.length === 0) {
            return;
        }

        // The device calls this unguarded per mic frame, so the seam contract is
        // no-throw (Gemini already honors it). On a dead socket, kick the
        // reconnect campaign and drop the frame instead of throwing into the
        // ESP 'chunk' handler.
        if (!this.isSocketOpen()) {
            this.requestReconnect();
            return;
        }

        // Default to audio output when receiving audio input (unless explicitly set to text mode)
        if (this.outputMode !== "audio") {
            this.setOutputMode("audio");
        }

        const b64 = pcm16Mono24k.toString("base64");

        const evt = {
            type: "input_audio_buffer.append",
            audio: b64,
        };
        this.send(evt);
    }

    /**
     * Clear any pending input audio on the server.
     */
    clearInputAudioBuffer() {
        this.assertOpen();
        this.send({ type: "input_audio_buffer.clear" });
    }

    /**
     * Forget the conversation so far by deleting all known items server-side.
     * Keeps the socket open (no reconnect latency). Use to start a fresh
     * conversation, e.g. when a new wake-word session begins after an idle gap
     * while still allowing context to persist across quick follow-ups.
     */
    resetConversation() {
        if (!this.isConnected() || this.conversationItemIds.size === 0) {
            return;
        }
        const count = this.conversationItemIds.size;
        for (const id of this.conversationItemIds) {
            this.send({ type: "conversation.item.delete", item_id: id });
        }
        this.conversationItemIds.clear();
        this.pendingToolCalls.clear();
        this.logger.info(`Cleared conversation context (${count} items)`);
    }




    /**
     * Send a plain text "user" message (no audio).
     * Often followed by createResponse() to trigger the model's reply.
     * Note: This method does not change the output mode. Use sendTextForAudioResponse() 
     * or sendTextForTextResponse() for explicit output mode control.
     */
    sendUserText(text: string) {
        this.assertOpen();
        const evt = {
            type: "conversation.item.create",
            item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text }],
            },
        };
        this.send(evt);
    }

    /**
     * Update session instructions on the fly.
     */
    updateAllInstructions(instructions: string) {
        this.assertOpen();
        this.instructionState.overrideText(instructions);
        this.sendSessionUpdate();
    }

    async updateVoice(newVoice: string): Promise<void> {
        this.options.voice = openaiVoiceName(newVoice);
    }

    async updateAdditionalInstructions(newAdditionalInstructions: string | null): Promise<void> {
        this.options.additionalInstructions = newAdditionalInstructions;
        await this.instructionState.reload(this.instructionParams());
    }

    async updateLanguage(newLanguageCode: string, newLanguageName: string): Promise<void> {
        this.options.languageCode = newLanguageCode;
        this.options.languageName = newLanguageName;
        await this.instructionState.reload(this.instructionParams());
    }

    async updateZone(newDeviceZone: string): Promise<void> {
        this.options.deviceZone = newDeviceZone;
        // The tools query "the standard zone" (this device's zone) — keep the tool
        // manager in sync so get_devices_in_standard_zone targets the new room.
        this.toolManager.setStandardZone(newDeviceZone);
        await this.instructionState.reload(this.instructionParams());
    }

    /**
     * Update whether the device supports timers. Rebuilds the instructions so the
     * timer/alarm section is only present for devices that advertised the feature.
     * Pushes the change to the live session if connected (no reconnect needed).
     */
    async updateTimerSupport(supportsTimers: boolean): Promise<void> {
        if (this.options.supportsTimers === supportsTimers) {
            return;
        }
        this.logger.info(`Timer support ${supportsTimers ? 'enabled' : 'disabled'}, rebuilding instructions`);
        this.options.supportsTimers = supportsTimers;
        await this.instructionState.reload(this.instructionParams());
        if (this.isConnected()) {
            this.sendSessionUpdate();
        }
    }

    /**
     * Enable/disable the Bring! shopping-list section of the prompt. Rebuilds the
     * instructions; the live session gets the new prompt immediately, but the
     * device also restarts the provider so the (un)registered tools are re-sent.
     */
    async updateShoppingListSupport(supportsShoppingList: boolean): Promise<void> {
        if (this.options.supportsShoppingList === supportsShoppingList) {
            return;
        }
        this.logger.info(`Shopping list ${supportsShoppingList ? 'enabled' : 'disabled'}, rebuilding instructions`);
        this.options.supportsShoppingList = supportsShoppingList;
        await this.instructionState.reload(this.instructionParams());
        if (this.isConnected()) {
            this.sendSessionUpdate();
        }
    }

    /**
     * Enable/disable the Music Assistant section of the prompt. Same shape as
     * updateShoppingListSupport: the live session gets the new prompt, and the
     * device restarts the provider so the (un)registered tools are re-sent.
     */
    async updateMusicSupport(supportsMusic: boolean): Promise<void> {
        if (this.options.supportsMusic === supportsMusic) {
            return;
        }
        this.logger.info(`Music ${supportsMusic ? 'enabled' : 'disabled'}, rebuilding instructions`);
        this.options.supportsMusic = supportsMusic;
        await this.instructionState.reload(this.instructionParams());
        if (this.isConnected()) {
            this.sendSessionUpdate();
        }
    }

    async updateApiKey(newApiKey: string): Promise<void> {
        this.logger.info('Updating API key and restarting agent...');
        this.options.apiKey = newApiKey;
    }

    async restart() {
        // Set flag to prevent automatic reconnection during manual restart
        const wasManuallyClosing = this.isManuallyClosing;
        this.isManuallyClosing = true;

        this.close();

        // Wait a bit for clean closure
        await new Promise(resolve => this.homey.setTimeout(resolve, 100));

        // Reset the manual closing flag
        this.isManuallyClosing = wasManuallyClosing;

        // Reconnect with new options
        await this.start();
    }

    /* ----------------- Internals ----------------- */

    private async onMessage(data: WebSocket.RawData) {
        let msg: RealtimeEvent | null = null;
        try {
            const text = typeof data === "string" ? data : data.toString("utf8");
            msg = JSON.parse(text);
        } catch {
            // Not JSON (Realtime audio is also sent as JSON with base64 per docs,
            // so we shouldn't get raw binary here). Ignore quietly.
            return;
        }

        if (!msg || !msg.type) return;
        const t = msg.type as string;

        // helpful general log
        this.logMessage(msg, "RECEIVED");

        // Remember every conversation item id so resetConversation() can delete them.
        if (msg.item?.id) this.conversationItemIds.add(msg.item.id);

        switch (t) {
            /* ---------- Session & rate-limits ---------- */

            case "session.created":
                // Don't race the constructor's fire-and-forget instruction load —
                // a session configured before it finishes would run on an empty
                // system prompt (ensureLoaded also retries a failed load once).
                await this.instructionState.ensureLoaded(this.instructionParams());
                this.sendSessionUpdate();
                break;

            case "session.updated":
                this.emit("session.updated", msg);
                this.emit("open");
                break;

            case "rate_limits.updated":
                this.checkRateLimits(msg);
                this.emit("rate_limits.updated", msg);
                break;

            /* ---------- Input audio / VAD ---------- */
            case "input_audio_buffer.speech_started":
                // Server VAD detected the user starting to speak.
                this.emit("speech", "server");
                break;

            case "input_audio_buffer.speech_stopped":
                // Server VAD indicated end-of-utterance; useful to stop mic.
                this.emit("silence", "server");
                break;

            /* ---------- Model response: text ---------- */
            case "response.text.delta":
            case "response.output_text.delta":
                this.emit("text.delta", msg.delta);
                break;

            case "response.output_text.done":
            case "response.text.done": // (alias seen in some examples)
                this.emit("text.done", msg);
                break;

            /* ---------- Model response: audio ---------- */
            case "response.output_audio.delta":
            case "response.audio.delta": {
                // Base64-encoded audio chunk of the selected output format
                // (pcm16 by default).
                const buf = Buffer.from(msg.delta ?? msg.audio ?? "", "base64");
                this.emit("audio.delta", buf);
                break;
            }
            case "response.output_audio.done":
            case "response.audio.done":
                this.emit("audio.done");
                break;

            case "response.output_audio_transcript.delta":
                this.emit("transcript.delta", msg.delta);
                break;

            case "conversation.item.input_audio_transcription.delta":
                // User's own speech being transcribed — keep this separate from the
                // assistant's output transcript. Routing it through "transcript.delta"
                // made the device treat the user's question (which ends in "?") as the
                // assistant asking a follow-up, so it re-opened the mic after every query.
                this.emit("input_transcript.delta", msg.delta);
                break;

            case "conversation.item.input_audio_transcription.failed":
                this.logger.error("Input transcription failed", msg.error);
                this.emit("response.error", msg);
                break;

            // A function_call item shows up in the response stream:
            case "response.output_item.added": {
                const { item, output_index } = msg;

                if (item?.type === "function_call") {
                    this.seedToolCallFromItem(item, output_index);
                }

                this.emit("response.output_item.added");
                break;
            }

            case "conversation.item.input_audio_transcription.completed": {
                this.emit("transcript.done", msg.transcript);
                // Skip when the STT heard nothing: an empty transcript (or a known
                // silence-hallucination string) would otherwise make the model
                // respond to nothing. Mirrors the empty-transcript guard in the device.
                const transcript = (msg.transcript ?? "").trim();
                if (isBlankOrHallucinatedTranscript(transcript)) {
                    break;
                }
                // Anchor the reply on the TRANSCRIPT, not the audio. The realtime model's
                // own hearing of Norwegian is markedly worse than the sidecar STT
                // (gpt-4o-transcribe): "Fortell meg en vits" transcribed perfectly while
                // the model answered the audio with the local time. So: replace the
                // committed audio item with a user text item carrying the transcript,
                // then ask for the reply. The delete also stops the model re-hearing old
                // audio on later turns. Near-zero latency cost — we already waited for
                // transcription.completed before creating the response. Do NOT reuse the
                // audio item's id for the text item (item_create_duplicate_item_id).
                if (msg.item_id) {
                    this.send({ type: "conversation.item.delete", item_id: msg.item_id });
                }
                this.sendUserText(transcript);
                this.createResponse();
                break;
            }

            // The same function_call item also appears as a conversation item:
            case "conversation.item.created": {
                const { item } = msg;
                if (item?.type === "function_call") {
                    this.seedToolCallFromItem(item);
                }
                this.emit("conversation.item.created");
                break;
            }


            /* ---------- Tool calling (function calling) ---------- */
            // Streamed function call arguments:
            // Some SDKs/docs still mention "response.function_call.arguments.delta" – support both:
            case "response.function_call_arguments.delta":
            case "response.function_call.arguments.delta": {
                const callId: string = msg.call_id;
                const delta: string = msg.delta ?? "";
                const rec = this.pendingToolCalls.get(callId) ?? { callId, argsText: "" };
                rec.argsText = (rec.argsText || "") + delta;
                // name is not present in delta (by design) – don't expect it here
                this.pendingToolCalls.set(callId, rec);
                this.emit("tool.arguments.delta", { callId, delta });
                break;
            }

            // End of streamed arguments; time to maybe execute the tool:
            case "response.function_call_arguments.done":
            case "response.function_call.arguments.done": {
                const callId: string = msg.call_id;
                // done often includes the name & the full arguments string:
                const hint = { name: msg.name as (string | undefined), args: msg.arguments as (string | undefined) };
                // Ensure a record exists (in case we never saw output_item.added for some reason)
                const rec = this.pendingToolCalls.get(callId) ?? { callId, argsText: "" };
                if (hint.args && !rec.argsText) rec.argsText = hint.args;
                if (hint.name && !rec.name) rec.name = hint.name;
                this.pendingToolCalls.set(callId, rec);

                this.emit("tool.arguments.done", { callId, name: rec.name, args: rec.argsText });
                break;
            }

            case "response.output_item.done": {
                const { item } = msg;
                if (item?.type === "function_call") {
                    // Safety net: if we somehow didn't run on args.done, do it now.
                    const hint = { name: item.name as string | undefined, args: item.arguments as string | undefined };
                    await this.maybeExecuteTool(item.call_id, hint);
                }
                this.emit("response.output_item.done");
                break;
            }

            /* ---------- Response lifecycle + errors ---------- */
            case "response.created":
            case "response.in_progress":
                this.emit("response.progress");
                break;

            //case "response.completed":
            case "response.done": {
                // A response that ended in a function_call is NOT the end of the turn:
                // maybeExecuteTool feeds the tool result back and issues createResponse(),
                // so a continuation response with the spoken answer is coming. Emitting
                // response.done here made the device flush/close its reply pipeline
                // mid-turn (bare tts_end + run_end), which on an in-band conversation
                // turn re-routed the real reply to the announce path — and the PE drops
                // announces mid-conversation, so tool-call answers played as silence.
                // Only the final (non-tool) response ends the turn.
                const output = msg.response?.output;
                if (Array.isArray(output) && output.some((item: any) => item?.type === "function_call")) {
                    this.logger.info("response.done for a tool-call response — awaiting continuation", 'TOOL');
                    break;
                }
                this.emit("response.done");
                break;
            }

            case "error":
            case "response.error":
                this.emit("response.error", msg);
                break;

            default:
                // Bubble anything else to consumers
                this.emit("event", msg);
                break;
        }
    }


    private seedToolCallFromItem(item: any, output_index?: number) {
        if (!item || item.type !== "function_call") return;
        const callId = item.call_id;
        if (!callId) return;

        const prev = this.pendingToolCalls.get(callId);
        const rec: PendingToolCall = {
            callId,
            itemId: item.id,
            outputIndex: output_index,
            name: item.name ?? prev?.name,
            argsText: prev?.argsText ?? (item.arguments ?? ""),
            executed: prev?.executed ?? false,
        };
        this.pendingToolCalls.set(callId, rec);

        this.emit("tool.call.started", {
            callId,
            name: rec.name,
            itemId: rec.itemId,
        });
    }


    private async maybeExecuteTool(callId: string, hint?: { name?: string; args?: string }) {
        const rec = this.pendingToolCalls.get(callId);
        if (!rec) return;

        // fill any missing pieces from the hint (e.g., from *.done or output_item.done)
        if (!rec.name && hint?.name) rec.name = hint.name;
        if ((!rec.argsText || rec.argsText.trim() === "") && hint?.args) rec.argsText = hint.args;

        if (rec.executed) return;                // already handled
        if (!rec.name) return;                   // still don't know the tool
        if (rec.argsText == null) return;        // still missing args (unlikely)

        let args: any = {};
        try {
            args = rec.argsText ? JSON.parse(rec.argsText) : {};
        } catch (e) {
            this.logger.error("Tool args JSON parse error", e);
        }

        this.emit("tool.called", { callId, name: rec.name, args });

        try {
            // Phase 1: run the tool locally (execute never throws — an unknown
            // tool or a throwing handler comes back as a structured { error }).
            const { output, failed: toolFailed } = await this.toolManager.execute(rec.name, args);
            this.emit("tool.completed", { callId, name: rec.name, result: output });

            // Phase 2: inject the result into the conversation (even a tool error is
            // fed back structured so the model can explain it) and ask the model to
            // continue. If the socket dropped mid-execution these sends throw — the
            // turn is lost either way and assertOpen has already kicked the
            // reconnect campaign, so log instead of rejecting out of the ws
            // message handler.
            try {
                this.sendFunctionResult(callId, output, rec.itemId);
                this.createResponse(toolFailed ? {
                    instructions: this.instructionState.module?.getErrorResponseInstructions?.() || "Explain what failed in plain language.",
                } : {});
            } catch (sendErr: any) {
                this.logger.error(`Could not send result of tool '${rec.name}' back to the model (socket closed?)`, sendErr);
            }
        } finally {
            rec.executed = true;
            this.pendingToolCalls.set(callId, rec);
        }
    }


    private sendFunctionResult(callId: string, output: any, previousItemId?: string) {

        let json: string;
        if (typeof output === "string") {
            json = JSON.stringify({ text: output }); // <-- key change for "pong"
        } else {
            json = JSON.stringify(output ?? null);
        }

        const evt: any = {
            type: "conversation.item.create",
            item: {
                type: "function_call_output",
                call_id: callId,
                output: json,
            },
        };
        if (previousItemId) evt.previous_item_id = previousItemId; // optional but nice for ordering
        this.send(evt);
    }

    /**
     * Domain-vocabulary prompt for the sidecar transcriber: device and zone
     * names from DeviceManager so commands like "slå på Taklampe stue"
     * transcribe correctly. Capped so an unusually large home can't blow the
     * transcription prompt budget. Undefined while the catalog is still empty
     * (the next session.update after a reconnect picks it up).
     */
    private sttVocabularyPrompt(): string | undefined {
        const names = this.toolManager.getSttVocabulary();
        if (names.length === 0) return undefined;

        const MAX_CHARS = 800;
        const parts: string[] = [];
        let length = 0;
        for (const name of names) {
            if (length + name.length + 2 > MAX_CHARS) break;
            parts.push(name);
            length += name.length + 2;
        }
        return `Smart home voice commands. Device and room names: ${parts.join(', ')}.`;
    }

    private sendSessionUpdate() {
        // tools schema
        const tools = this.sessionToolsArray();
        const sttPrompt = this.sttVocabularyPrompt();

        // Configure session: model, voice, audio formats, STT language, VAD, instructions.
        const payload = {
            type: "session.update",
            session: {
                type: "realtime",
                output_modalities: ["audio"],
                audio: {
                    input: {
                        format: {
                            type: "audio/pcm",
                            rate: 24000
                        },
                        // Sidecar STT: the realtime model answers the audio directly; this
                        // transcript drives the CONVO log, the empty-transcript gate and the
                        // response.create timing. gpt-4o-transcribe is OpenAI's most accurate
                        // STT and clearly better than the whisper family on Norwegian.
                        // NOTE: `delay` is only supported with gpt-realtime-whisper — do not
                        // add it back here. The `prompt` carries domain vocabulary
                        // (device/zone names) so commands transcribe correctly.
                        transcription: {
                            model: "gpt-4o-transcribe",
                            language: this.options.languageCode,
                            ...(sttPrompt ? { prompt: sttPrompt } : {}),
                        },
                        noise_reduction: {
                            type: "far_field"  // "near_field" for close-mic, "far_field" for room/speakerphone setups
                        },
                        turn_detection: {
                            type: "server_vad",
                            threshold: 0.6,
                            prefix_padding_ms: 400,
                            silence_duration_ms: 600,
                            idle_timeout_ms: 30000,  // Auto-close idle sessions after 30s to reduce costs
                            create_response: false,
                            interrupt_response: false
                        }
                    },
                    output: {
                        format: {
                            type: "audio/pcm",
                            rate: 24000
                        },
                        voice: this.options.voice,
                        speed: 1.0
                    }
                },
                instructions: this.instructionState.text,
                tools,
            },
        };
        this.send(payload);
    }

    private sessionToolsArray() {
        // Get tool definitions from the tool manager
        return this.toolManager.getToolDefinitions();
    }


    private send(obj: any) {
        this.assertOpen();
        const str = JSON.stringify(obj);

        this.logMessage(obj, "SENDING");

        this.ws!.send(str);
    }

    private assertOpen() {
        if (!this.isSocketOpen()) {
            this.requestReconnect();
            throw new Error("WebSocket is not open - reconnection initiated");
        }
    }

    private isSocketOpen(): boolean {
        return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    /** Kick the reconnect campaign unless we're closing on purpose or one is already running. */
    private requestReconnect() {
        if (!this.isManuallyClosing && !this.reconnect.isActive) {
            this.reconnect.schedule();
        }
    }

    private logMessage(msg: any, direction: string) {

        if (msg.type.includes("delta") && msg.type.includes("transcript")) {
            const delta = msg.delta ?? '-null-';
            this.logger.info(`${msg.type} = ${delta}`, direction);
            return;
        }

        if (msg.type.includes("delta") && msg.type.includes("audio")) {
            const length = msg.delta ? msg.delta.length : -1;
            this.logger.info(`${msg.type} = ${length} bytes`, direction);
            return;
        }

        if (msg.type.includes("delta") && msg.type.includes("function")) {
            const delta = msg.delta ?? '-null-';
            this.logger.info(`${msg.type} = ${delta}`, direction);
            return;
        }

        if (msg.type === 'input_audio_buffer.append') {
            const length = msg.audio ? msg.audio.length : -1;
            this.logger.info(`${msg.type} = ${length} bytes`, direction);
            return;
        }


        this.logger.info(msg.type, direction, msg);
    }



    /**
     * Start monitoring connection health with periodic pings
     */
    private startConnectionHealthCheck() {
        this.stopConnectionHealthCheck(); // Clear any existing interval

        this.pingIntervalId = this.homey.setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                // Check if we received a pong recently
                const timeSinceLastPong = Date.now() - this.lastPongTime;

                if (timeSinceLastPong > this.connectionHealthCheckInterval * 2) {
                    // No pong received for too long - connection might be unhealthy
                    this.logger.info("Connection appears unhealthy - no pong received", 'HEALTH');
                    this.emit("Unhealthy");

                    // Force reconnection. Code 1006 is reserved and makes ws throw,
                    // so use an application-defined code (4000-4999) and never let a
                    // close() throw escape this interval callback (it would crash the app).
                    this.safeCloseSocket(4000, "connection-health-check-failed");
                } else {
                    // Send ping to check connection
                    try {
                        this.logger.info("Sending ping", 'HEALTH');
                        this.ws.ping();
                    } catch (error) {
                        this.logger.info("Failed to send ping:", 'HEALTH', error);
                        this.safeCloseSocket(4000, "ping-failed");
                    }
                }
            }
        }, this.connectionHealthCheckInterval);
    }

    /**
     * Close the socket without ever throwing out of the caller. Used from the
     * health-check interval, where an uncaught throw would take down the app.
     */
    private safeCloseSocket(code: number, reason: string) {
        try {
            this.ws?.close(code, reason);
        } catch (error) {
            this.logger.info("Failed to close socket:", 'HEALTH', error);
        }
    }

    /**
     * Stop the connection health check
     */
    private stopConnectionHealthCheck() {
        if (this.pingIntervalId) {
            this.homey.clearInterval(this.pingIntervalId);
            this.pingIntervalId = undefined;
        }
    }

    public isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    public hasApiKey(): boolean {

        if (this.options.apiKey) {
            return true;
        }
        return false;
    }

    /**
     * Completely destroy the agent and clean up all resources
     */
    public destroy() {
        this.logger.info("Destroying OpenAI Realtime Agent");
        this.isManuallyClosing = true;

        // Clear all timers
        this.stopConnectionHealthCheck();
        this.reconnect.reset();

        // Close WebSocket
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close(1000, "agent-destroyed");
            }
            this.ws = undefined;
        }

        // Clear pending tool calls
        this.pendingToolCalls.clear();

        // Remove all event listeners
        this.removeAllListeners();
    }

}

// Back-compat: the class was historically named OpenAIRealtimeAgent. Keep a value
// alias so existing imports and `instanceof` checks (in tests) keep working.
export { OpenAIRealtimeProvider as OpenAIRealtimeAgent };

