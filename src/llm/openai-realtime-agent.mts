import WebSocket from "ws";
import { EventEmitter } from "events";
import { TypedEmitter } from "tiny-typed-emitter";
import { createLogger } from '../helpers/logger.mjs';
import { ToolManager } from './tool-manager.mjs';

/**
 * Dynamically load instruction functions based on language code
 */
async function loadInstructionModule(languageCode: string) {
    try {
        // Try to load language-specific instructions (e.g., 'no' -> agent-instructions.no.mjs)
        if (languageCode === 'no') {
            return await import('./agent-instructions.no.mjs');
        }
        // Default to English instructions
        return await import('./agent-instructions.en.mjs');
    } catch (error) {
        // Fallback to English if language-specific file doesn't exist
        return await import('./agent-instructions.en.mjs');
    }
}

/**
 * Minimal shape of Realtime events we care about.
 * We keep them loose to stay forward-compatible with the evolving Realtime API.
 */
type RealtimeEvents = {
    connected: () => void;
    open: () => void;
    close: (code: number, reason: string) => void;
    event: (message: any) => void;
    silence: (source: string) => void;
    error: (err: Error) => void;

    // Reconnection events
    reconnecting: (attempt: number, delay: number) => void;
    reconnected: () => void;
    reconnectFailed: (attempt: number, error: Error) => void;
    Healthy: () => void;
    Unhealthy: () => void;
    missing_api_key: () => void;

    "input_audio_buffer.committed": () => void;

    "session.updated": (msg: any) => void;

    "audio.delta": (chunk: Buffer) => void;
    "audio.done": () => void;

    "text.delta": (delta: string) => void;
    "text.done": (msg: any) => void;

    "transcript.delta": (delta: string) => void;
    "transcript.done": (transcript: string) => void;

    "response.output_item.added": () => void;
    "response.progress": () => void;
    "response.output_item.done": () => void;
    "response.done": () => void;
    "response.error": (msg: any) => void;

    "conversation.item.created": () => void;


    "tool.arguments.delta": (d: { callId: string; name?: string; delta: string }) => void;
    "tool.arguments.done": (d: { callId: string; name?: string; args: any }) => void;
    "tool.called": (d: { callId: string; name: string; args: any }) => void;
    "tool.call.started": (d: { callId: string; name?: string; itemId?: string }) => void;

    "rate_limits.updated": (msg: any) => void;
};



type RealtimeEvent = {
    type: string;
    [k: string]: any;
};


export type RealtimeOptions = {
    url?: string;
    apiKey?: string | null;
    voice: string;
    languageCode: string; // e.g., 'no'
    languageName: string; // e.g., 'Norwegian'
    additionalInstructions: string | null;
    deviceZone: string;
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
 * - Audio -> Text: Use setAudioToTextMode() then sendAudioChunk() (output mode set to "text")
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

export class OpenAIRealtimeAgent extends (EventEmitter as new () => TypedEmitter<RealtimeEvents>) {
    private ws?: WebSocket;
    private homey: any;
    private logger = createLogger('AGENT', false);
    private toolManager: ToolManager;
    private instructions: string = '';
    private instructionModule: any = null;

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
        >
    >;
    // keep your existing maps, but store full records keyed by callId
    private pendingToolCalls: Map<string, PendingToolCall> = new Map();

    // Reconnection logic properties
    private reconnectAttempts = 0;
    private maxReconnectAttempts = Infinity; // Keep trying indefinitely
    private reconnectDelay = 1000; // Start with 1 second
    private maxReconnectDelay = 30000; // Max 30 seconds between attempts
    private reconnectTimeoutId?: NodeJS.Timeout;
    private isManuallyClosing = false;
    private isReconnecting = false;
    private pingIntervalId?: NodeJS.Timeout;
    private lastPongTime = 0;
    private connectionHealthCheckInterval = 30000; // Check every 30 seconds

    // Output mode configuration
    private outputMode: "audio" | "text" = "audio"; // Default to audio output
    private transcript_id: string | null = null;

    constructor(homey: any, toolManager: ToolManager, opts: RealtimeOptions) {
        super();

        this.homey = homey;
        this.toolManager = toolManager;

        this.options = {
            apiKey: opts.apiKey ?? '',
            url: opts.url ?? `wss://api.openai.com/v1/realtime?model=gpt-realtime`,
            voice: opts.voice ?? "ash",
            languageCode: opts.languageCode ?? "en",
            languageName: opts.languageName ?? "English",
            additionalInstructions: opts.additionalInstructions ?? "",
            deviceZone: opts.deviceZone ?? "<Unknown Zone>"
        };

        // Initialize instructions asynchronously
        this.loadInstructionModule();
    }

    /**
     * Load the appropriate instruction module based on language
     */
    private async loadInstructionModule() {
        try {
            this.instructionModule = await loadInstructionModule(this.options.languageCode);
            this.instructions = this.instructionModule.getDefaultInstructions(this.options.languageName, this.options.additionalInstructions);
        } catch (error) {
            this.logger.error('Failed to load instruction module:', error);
            // Fallback to empty instructions
            this.instructions = '';
        }
    }


    /**
     * Connect to OpenAI Realtime WebSocket and configure the session
     * (voice, output format, STT language, server VAD, tools, instructions).
     */
    async start(): Promise<void> {

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return;
        }

        if (!this.options.apiKey) {
            this.emit("missing_api_key");
            return;
        }

        // Clear any existing reconnect timeout
        if (this.reconnectTimeoutId) {
            this.homey.clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = undefined;
        }

        this.logger.info("Connecting WS:", 'START', this.options.url);

        try {

            this.ws = new WebSocket(this.options.url, {
                headers: {
                    Authorization: `Bearer ${this.options.apiKey}`
                },
            });

            this.ws.on("open", () => {
                this.logger.info("WebSocket open");
                this.reconnectAttempts = 0; // Reset reconnect attempts on successful connection
                this.isReconnecting = false;
                this.lastPongTime = Date.now();

                this.startConnectionHealthCheck();

                if (this.reconnectAttempts > 0) {
                    this.emit("reconnected");
                }
            });

            this.ws.on("message", (data) => this.onMessage(data));

            this.ws.on("error", (err) => {
                this.logger.error("WebSocket error", err);
                this.emit("error", err);
            });

            this.ws.on("close", (code, reason) => {
                this.logger.info("WebSocket closed", undefined, { code, reason: reason.toString() });
                this.stopConnectionHealthCheck();
                this.emit("close", code, reason.toString());

                // Only attempt reconnection if not manually closing
                if (!this.isManuallyClosing && !this.isReconnecting) {
                    this.scheduleReconnect();
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
                this.scheduleReconnect();
            }
        }
    }

    /**
     * Gracefully close the socket.
     */
    close(code = 1000, reason = "client-close") {
        this.isManuallyClosing = true;
        this.stopConnectionHealthCheck();

        // Clear any pending reconnect attempts
        if (this.reconnectTimeoutId) {
            this.homey.clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = undefined;
        }

        this.ws?.close(code, reason);
    }


    sendSomeText() {
        this.logger.info("Sending text to agent");
        // Send "Hvordan går det med deg i dag?" to the agent.
        // Default to audio output for this test method
        this.sendTextForAudioResponse("Hvordan går det med deg i dag?");
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
     * Get the current output mode.
     */
    getOutputMode(): "audio" | "text" {
        return this.outputMode;
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
     * Send audio chunk and expect text response (Audio -> Text).
     * Call this method first to set text mode, then use sendAudioChunk() normally.
     */
    setAudioToTextMode() {
        this.setOutputMode("text");
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
                model: "gpt-4o-mini-tts",
                voice: this.options.voice,
                input: text,
                response_format: "flac" // mp3 | wav | opus | aac | flac | pcm
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

        this.assertOpen();

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
        this.instructions = instructions;
        this.sendSessionUpdate();
    }

    async updateVoice(newVoice: string): Promise<void> {
        this.options.voice = newVoice;
    }

    async updateAdditionalInstructions(newAdditionalInstructions: string | null): Promise<void> {
        this.options.additionalInstructions = newAdditionalInstructions;
        await this.loadInstructionModule();
    }

    async updateLanguage(newLanguageCode: string, newLanguageName: string): Promise<void> {
        this.options.languageCode = newLanguageCode;
        this.options.languageName = newLanguageName;
        await this.loadInstructionModule();
    }

    async updateZone(newDeviceZone: string): Promise<void> {
        this.options.deviceZone = newDeviceZone;
        await this.loadInstructionModule();
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

        switch (t) {
            /* ---------- Session & rate-limits ---------- */

            case "session.created":
                //this.emit("session.created", msg);                
                this.sendSessionUpdate();
                break;

            case "session.updated":
                this.emit("session.updated", msg);
                this.emit("open");
                break;

            case "rate_limits.updated":
                this.emit("rate_limits.updated", msg);
                break;

            /* ---------- Input audio / VAD ---------- */
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
            case "response.audio.done":
                this.emit("audio.done");
                break;

            /* ---------- Transcription of input audio ---------- */
            // See: conversation.item.input_audio_transcription.delta
            case "conversation.item.input_audio_transcription.delta":
            case "item.input_audio_transcription.delta":
            case "input_audio_transcription.delta":
            case "response.output_audio_transcript.delta":
                this.emit("transcript.delta", msg.delta);
                break;

            //case "response.output_audio_transcript.done":
            //    this.emit("transcript.done", msg.transcript);
            //    break;

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
                this.transcript_id = msg.item_id;
                this.sendTranscript(msg);
            }

            case "conversation.item.done": {

                var id = msg.item?.id;

                if (id == this.transcript_id) {
                    this.send({
                        "type": "response.create",
                        "response": {
                            //"instructions": "Execute the request directly for light devices in the standard zone when <=10 targets and no security devices.",
                        }
                    });
                    this.transcript_id = null;
                }



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
            case "response.done":
                this.emit("response.done");
                break;

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
            const output = await this.handleTool(callId, rec.name, args);

            // Inject the function result into the conversation:
            this.sendFunctionResult(callId, output, rec.itemId);

            // Tell the model to continue and produce audio/text based on that result:
            this.createResponse({
                //instructions: getResponseInstructions(),
            });

        } catch (err: any) {
            // Even on error, feed a structured output back so the model can handle it gracefully:
            this.sendFunctionResult(callId, { error: String(err?.message ?? err) }, rec.itemId);
            this.createResponse({
                instructions: this.instructionModule?.getErrorResponseInstructions?.() || "Explain what failed in plain language.",
            });
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

    private async handleTool(callId: string, name: string, args: any) {
        const toolHandlers = this.toolManager.getToolHandlers();
        const fn = toolHandlers[name];
        if (!fn) {
            return { error: `Unknown tool: ${name}` };
        }
        return await fn(args);
    }

    private sendSessionUpdate() {
        // tools schema
        const tools = this.sessionToolsArray();

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
                        transcription: {
                            model: "whisper-1",                                                        // pick one: "gpt-4o-mini-transcribe" (fast) | "gpt-4o-transcribe" (quality) | "whisper-1"                                                        
                            language: this.options.languageCode,
                            //prompt: "Homey, ESPHome, "                                                            // optional biasing for names/terms. Need to look into this
                        },
                        noise_reduction: null,
                        turn_detection: {
                            type: "server_vad",
                            threshold: 0.6,
                            prefix_padding_ms: 400,
                            silence_duration_ms: 600,
                            idle_timeout_ms: null,
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
                instructions: this.instructions,
                tools,
            },
        };
        this.send(payload);
    }

    private sessionToolsArray() {
        // Get tool definitions from the tool manager
        return this.toolManager.getToolDefinitions();
    }


    private sendTranscript(msg: any) {

        this.send({
            "type": "conversation.item.create",
            "item": {
                "id": msg.item_id,
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": msg.transcript
                    }
                ]
            }
        });


    }


    private send(obj: any) {
        this.assertOpen();
        const str = JSON.stringify(obj);

        this.logMessage(obj, "SENDING");

        this.ws!.send(str);
    }

    private assertOpen() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            // If we're not manually closing and not already reconnecting, start reconnection
            if (!this.isManuallyClosing && !this.isReconnecting) {
                this.scheduleReconnect();
            }
            throw new Error("WebSocket is not open - reconnection initiated");
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



    /* ----------------- Reconnection logic ----------------- */

    /**
     * Schedule a reconnection attempt with exponential backoff
     */
    private scheduleReconnect() {
        if (this.isManuallyClosing || this.reconnectTimeoutId) {
            return; // Don't reconnect if manually closing, already scheduled, or auto-reconnect disabled
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        // Calculate delay with exponential backoff and jitter
        const baseDelay = Math.min(
            this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
            this.maxReconnectDelay
        );

        // Add jitter (±25%) to prevent thundering herd
        const jitter = baseDelay * 0.25 * (Math.random() - 0.5);
        const delay = Math.max(1000, baseDelay + jitter);

        this.logger.info(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`, 'RECONNECT');
        this.emit("reconnecting", this.reconnectAttempts, delay);

        this.reconnectTimeoutId = this.homey.setTimeout(async () => {
            this.reconnectTimeoutId = undefined;

            try {
                await this.start();
            } catch (error) {
                this.logger.info(`Reconnect attempt ${this.reconnectAttempts} failed:`, 'RECONNECT', error);
                this.emit("reconnectFailed", this.reconnectAttempts, error as Error);

                // If we haven't exceeded max attempts, schedule another reconnect
                if (this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.scheduleReconnect();
                } else {
                    this.logger.info("Max reconnect attempts reached", 'RECONNECT');
                    this.isReconnecting = false;
                }
            }
        }, delay);
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

                    // Force reconnection
                    this.ws.close(1006, "connection-health-check-failed");
                } else {
                    // Send ping to check connection
                    try {
                        this.logger.info("Sending ping", 'HEALTH');
                        this.ws.ping();
                    } catch (error) {
                        this.logger.info("Failed to send ping:", 'HEALTH', error);
                        this.ws.close(1006, "ping-failed");
                    }
                }
            }
        }, this.connectionHealthCheckInterval);
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

    /**
     * Get current connection status and statistics
     */
    public getConnectionStatus() {
        return {
            connected: this.ws?.readyState === WebSocket.OPEN,
            reconnectAttempts: this.reconnectAttempts,
            isReconnecting: this.isReconnecting,
            isManuallyClosing: this.isManuallyClosing,
            lastPongTime: this.lastPongTime,
            timeSinceLastPong: this.lastPongTime > 0 ? Date.now() - this.lastPongTime : -1,
        };
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
     * Force a reconnection (useful for testing or manual recovery)
     */
    public async forceReconnect() {
        if (this.isManuallyClosing) {
            throw new Error("Cannot force reconnect while manually closing");
        }

        this.logger.info("Forcing reconnection");
        this.reconnectAttempts = 0; // Reset attempts for forced reconnect

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close(1000, "force-reconnect");
        } else {
            await this.start();
        }
    }

    /**
     * Completely destroy the agent and clean up all resources
     */
    public destroy() {
        this.logger.info("Destroying OpenAI Realtime Agent");
        this.isManuallyClosing = true;

        // Clear all timers
        this.stopConnectionHealthCheck();
        if (this.reconnectTimeoutId) {
            this.homey.clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = undefined;
        }

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

