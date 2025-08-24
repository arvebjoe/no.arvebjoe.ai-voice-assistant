import WebSocket from "ws";
import { EventEmitter } from "events";
import { TypedEmitter } from "tiny-typed-emitter";
import { createLogger } from '../helpers/logger.mjs';
import { ToolManager } from './tool-manager.mjs';
import { getDefaultInstructions, getResponseInstructions, getErrorResponseInstructions } from '../helpers/agent-instructions.mjs';

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
    connectionHealthy: () => void;
    connectionUnhealthy: () => void;

    "input_audio_buffer.committed": () => void;

    "session.updated": (msg: any) => void;

    "audio.delta": (chunk: Buffer) => void;
    "audio.done": () => void;

    "text.delta": (delta: string) => void;
    "text.done": (msg: any) => void;

    "transcript.delta": (delta: string) => void;

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
    /** Your OpenAI API key */
    apiKey: string;

    /** Realtime model id, e.g. 'gpt-4o-realtime-preview' */
    model?: string;

    /** Optional: pass a fully custom WebSocket URL */
    url?: string;

    /** Choose the server voice, e.g. 'alloy', 'ash', 'verse'... */
    voice?: string;

    /** Output audio format. 'pcm16' by default. */
    outputAudioFormat?: "pcm16" | "g711_ulaw" | "g711_alaw" | "wav";

    /**
     * Configure server-side VAD / turn detection.
     * Set to { type: 'server_vad' } to let the server auto-commit the input turn.
     * Set to null to disable server VAD (you can still use local VAD below).
     */
    turnDetection?: { type: "server_vad";[k: string]: any } | null;

    /**
     * Hint STT language using ISO-639-1 code. Norwegian = 'no'.
     * This improves ASR accuracy & latency.
     */
    languageCode?: string; // e.g., 'no'

    // Used in the agent instructions to refer to the language to communicate in
    languageName?: string; // e.g., 'Norwegian'

    additionalInstructions?: string;

    /** Custom system instructions . */
    instructions?: string;

    /** Enable a simple local energy-based VAD to detect silences client-side. */
    enableLocalVAD?: boolean;

    /** RMS threshold for local VAD (0..1-ish); tweak to your mic. */
    localVADSilenceThreshold?: number;

    /** How long silence must persist (ms) before we emit 'silence' locally. */
    localVADSilenceMs?: number;

    /** Emit extra debug logs */
    verbose?: boolean;

    /* ----------------- Reconnection options ----------------- */

    /** Maximum number of reconnection attempts (default: Infinity) */
    maxReconnectAttempts?: number;

    /** Initial reconnection delay in milliseconds (default: 1000) */
    reconnectDelay?: number;

    /** Maximum reconnection delay in milliseconds (default: 30000) */
    maxReconnectDelay?: number;

    /** Connection health check interval in milliseconds (default: 30000) */
    connectionHealthCheckInterval?: number;

    /** Enable automatic reconnection on connection loss (default: true) */
    enableAutoReconnect?: boolean;
};

type PendingToolCall = {
    callId: string;
    itemId?: string;
    outputIndex?: number;
    name?: string;
    argsText: string;          // streamed JSON
    executed?: boolean;        // to avoid double-runs
};

export class OpenAIRealtimeAgent extends (EventEmitter as new () => TypedEmitter<RealtimeEvents>) {
    private ws?: WebSocket;
    private logger = createLogger("AGENT", false);
    private resample_prev: number | null = null; // last input sample from previous chunk
    private resample_frac: number = 0;           // fractional read position into the source for next call
    private toolManager: ToolManager;

    private options: Required<
        Pick<
            RealtimeOptions,
            | "model"
            | "voice"
            | "outputAudioFormat"
            | "turnDetection"
            | "languageCode"
            | "languageName"
            | "additionalInstructions"
            | "instructions"
            | "enableLocalVAD"
            | "localVADSilenceThreshold"
            | "localVADSilenceMs"
            | "verbose"
            | "maxReconnectAttempts"
            | "reconnectDelay"
            | "maxReconnectDelay"
            | "connectionHealthCheckInterval"
            | "enableAutoReconnect"
        >
    > & {
        apiKey: string;
        url: string;
    };

    // buffer local-VAD state
    private lastNonSilentTs = 0;

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

    constructor(toolManager: ToolManager, opts: RealtimeOptions) {
        super();

        this.toolManager = toolManager;

        this.options = {
            apiKey: opts.apiKey,
            model: opts.model ?? "gpt-4o-realtime-preview",
            url:
                opts.url ??
                `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
                    opts.model ?? "gpt-4o-realtime-preview"
                )}`,
            voice: opts.voice ?? "alloy",
            outputAudioFormat: opts.outputAudioFormat ?? "pcm16",
            turnDetection:
                typeof opts.turnDetection === "undefined"
                    ? { type: "server_vad" }
                    : opts.turnDetection,
            languageCode: opts.languageCode ?? "en", // English
            languageName: opts.languageName ?? "English",
            additionalInstructions: opts.additionalInstructions ?? "",
            instructions: getDefaultInstructions(opts.languageName ?? "English", opts.additionalInstructions),
            enableLocalVAD: opts.enableLocalVAD ?? true,
            localVADSilenceThreshold: opts.localVADSilenceThreshold ?? 0.01,
            localVADSilenceMs: opts.localVADSilenceMs ?? 800,
            verbose: !!opts.verbose,
            // Reconnection options
            maxReconnectAttempts: opts.maxReconnectAttempts ?? Infinity,
            reconnectDelay: opts.reconnectDelay ?? 1000,
            maxReconnectDelay: opts.maxReconnectDelay ?? 30000,
            connectionHealthCheckInterval: opts.connectionHealthCheckInterval ?? 30000,
            enableAutoReconnect: opts.enableAutoReconnect ?? true,
        };

        // Initialize reconnection properties from options
        this.maxReconnectAttempts = this.options.maxReconnectAttempts;
        this.reconnectDelay = this.options.reconnectDelay;
        this.maxReconnectDelay = this.options.maxReconnectDelay;
        this.connectionHealthCheckInterval = this.options.connectionHealthCheckInterval;
    }

    /* ----------------- Public API ----------------- */

    /**
     * Connect to OpenAI Realtime WebSocket and configure the session
     * (voice, output format, STT language, server VAD, tools, instructions).
     */
    async start(): Promise<void> {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

        // Clear any existing reconnect timeout
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = undefined;
        }

        this.logger.info("Connecting WS:", 'START', this.options.url);

        try {
            this.ws = new WebSocket(this.options.url, {
                headers: {
                    Authorization: `Bearer ${this.options.apiKey}`,
                    "OpenAI-Beta": "realtime=v1", // required during beta
                },
            });

            this.ws.on("open", () => {
                this.logger.info("WebSocket open");
                this.reconnectAttempts = 0; // Reset reconnect attempts on successful connection
                this.isReconnecting = false;
                this.lastPongTime = Date.now();

                this.emit("open");
                this.sendSessionUpdate();
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
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = undefined;
        }

        this.ws?.close(code, reason);
    }

    /**
     * Push a PCM16 mono 24kHz chunk into the input buffer.
     * The API expects Base64-encoded audio bytes via input_audio_buffer.append.
     * NOTE: You can call commitInputAudio() to force the end of the turn.
     */
    sendAudioChunk(pcm16Mono24k: Buffer) {
        if (pcm16Mono24k.length === 0) {
            return;
        }

        this.assertOpen();

        const b64 = pcm16Mono24k.toString("base64");

        // local VAD (optional)
        if (this.options.enableLocalVAD) {
            const rms = getPCM16RMS(pcm16Mono24k);

            if (this.lastNonSilentTs === 0) {
                this.lastNonSilentTs = Date.now() + 1e9;
            } else if (rms > 0) {
                const silent = rms < this.options.localVADSilenceThreshold;
                const now = Date.now();
                if (!silent) this.lastNonSilentTs = now;
                const diff = now - this.lastNonSilentTs;
                if (silent && diff >= this.options.localVADSilenceMs) {
                    // We've been silent long enough
                    this.logger.info("Local silence detected, emitting 'silence' event", "VAD", { rms, diff });
                    this.emit("silence", "local");

                    // To avoid repeated emits during a long silence:
                    this.lastNonSilentTs = now + 1e9;
                }
            }
        }

        const evt = {
            type: "input_audio_buffer.append",
            audio: b64,
        };
        this.send(evt);
    }

    /**
     * Force-commit the user's audio turn.
     * (Useful when server VAD is disabled or you want to cut early.)
     */
    commitInputAudio() {
        this.assertOpen();
        this.send({ type: "input_audio_buffer.commit" });
    }

    /**
     * Clear any pending input audio on the server.
     */
    clearInputAudioBuffer() {
        this.assertOpen();
        this.send({ type: "input_audio_buffer.clear" });
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
                modalities: ["audio", "text"],           // audio is requested here
                // voice comes from the session (session.voice)
                instructions:
                    getResponseInstructions(),
                ...extra,
            },
        };
        this.send(evt);
    }


    /**
     * Send a plain text "user" message (no audio).
     * Often followed by createResponse() to trigger the model's reply.
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
        this.options.instructions = instructions;
        this.sendSessionUpdate();
    }

    async updateVoiceWithReconnect(newVoice: string): Promise<void> {
        this.options.voice = newVoice;

        await this.restart();
    }

    async updateAdditionalInstructions(newAdditionalInstructions: string): Promise<void> {
        this.assertOpen();
        this.options.additionalInstructions = newAdditionalInstructions;
        this.options.instructions = getDefaultInstructions(this.options.languageName, this.options.additionalInstructions);

        await this.restart();
    }

    async updateLanguage(newLanguageCode: string, newLanguageName: string): Promise<void> {
        this.assertOpen();
        this.options.languageCode = newLanguageCode;
        this.options.languageName = newLanguageName;
        this.options.instructions = getDefaultInstructions(this.options.languageName, this.options.additionalInstructions);

        await this.restart();
    }

    private async restart() {
        // Set flag to prevent automatic reconnection during manual restart
        const wasManuallyClosing = this.isManuallyClosing;
        this.isManuallyClosing = true;

        this.close();

        // Wait a bit for clean closure
        await new Promise(resolve => setTimeout(resolve, 100));

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
            case "session.updated":
                this.emit("session.updated", msg);
                break;

            case "rate_limits.updated":
                this.emit("rate_limits.updated", msg);
                break;

            /* ---------- Input audio / VAD ---------- */
            case "input_audio_buffer.committed":
                // Server VAD indicated end-of-utterance; useful to stop mic.
                this.emit("silence", "server");
                this.emit("input_audio_buffer.committed");
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
                this.emit("transcript.delta", msg.delta);
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

            case "response.completed":
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
                instructions: getResponseInstructions(),
            });

        } catch (err: any) {
            // Even on error, feed a structured output back so the model can handle it gracefully:
            this.sendFunctionResult(callId, { error: String(err?.message ?? err) }, rec.itemId);
            this.createResponse({
                instructions: getErrorResponseInstructions(),
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
                model: this.options.model,
                voice: this.options.voice,
                output_audio_format: this.options.outputAudioFormat, // default 'pcm16'
                input_audio_format: "pcm16", // we will send PCM16 mono 24kHz
                input_audio_transcription: {
                    language: this.options.languageCode, // 'no' for Norwegian
                    model: "whisper-1", // default STT model
                },
                turn_detection: this.options.turnDetection ?? null,
                instructions: this.options.instructions,
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

        if (obj.type !== "input_audio_buffer.append") {
            this.logMessage(obj, "SENDING");
        }

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


        if (msg.type === "input_audio_buffer.append" && msg.audio) {
            this.logger.info(msg.type, direction);
            return;
        }
        if (msg.type === "response.audio.delta" && msg.delta) {
            this.logger.info(msg.type, direction);
            return;
        }

        this.logger.info(msg.type, direction, msg);
    }



    /* ----------------- Reconnection logic ----------------- */

    /**
     * Schedule a reconnection attempt with exponential backoff
     */
    private scheduleReconnect() {
        if (this.isManuallyClosing || this.reconnectTimeoutId || !this.options.enableAutoReconnect) {
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

        this.reconnectTimeoutId = setTimeout(async () => {
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

        this.pingIntervalId = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                // Check if we received a pong recently
                const timeSinceLastPong = Date.now() - this.lastPongTime;

                if (timeSinceLastPong > this.connectionHealthCheckInterval * 2) {
                    // No pong received for too long - connection might be unhealthy
                    this.logger.info("Connection appears unhealthy - no pong received", 'HEALTH');
                    this.emit("connectionUnhealthy");

                    // Force reconnection
                    this.ws.close(1006, "connection-health-check-failed");
                } else {
                    // Send ping to check connection
                    try {
                        this.logger.info("Sending ping", 'HEALTH');
                        this.ws.ping();
                        this.emit("connectionHealthy");
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
            clearInterval(this.pingIntervalId);
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
            clearTimeout(this.reconnectTimeoutId);
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

    /* ----------------- Built-in tools ----------------- */

    /**
     * Upsample PCM16 mono 16 kHz -> 24 kHz (little-endian) using linear interpolation.
     * - Input: Buffer of Int16 LE samples @ 16 kHz
     * - Output: Buffer of Int16 LE samples @ 24 kHz
     * Streaming-safe: preserves phase + last sample across calls to avoid clicks at chunk boundaries.
     */
    upsample16kTo24k(pcm16_16k: Buffer): Buffer {
        if (!pcm16_16k || pcm16_16k.length === 0) return Buffer.alloc(0);

        // Ratio: 16k -> 24k (×1.5). Each 24k output sample advances 2/3 of a 16k input sample.
        const step = 16000 / 24000; // 2/3

        const inSamples = pcm16_16k.length >>> 1; // bytes -> int16 samples
        const needPrefix = this.resample_prev !== null ? 1 : 0;

        // Build a small working array that includes the previous edge sample (for cross-chunk interpolation).
        const src = new Int16Array(inSamples + needPrefix);
        let writeIdx = 0;
        if (needPrefix) {
            src[writeIdx++] = this.resample_prev as number;
        }
        for (let i = 0; i < inSamples; i++) {
            src[writeIdx++] = pcm16_16k.readInt16LE(i << 1);
        }

        // Output will be ~1.5x the input. Allocate a bit extra to avoid reallocation.
        const estimatedOut = Math.ceil(inSamples * 1.5) + 8;
        const out = new Int16Array(estimatedOut);

        let outIdx = 0;
        let pos = this.resample_frac;               // fractional index into 'src'
        const last = src.length - 1;          // we can only interpolate up to last-1

        while (pos < last) {
            const i = Math.floor(pos);
            const frac = pos - i;
            const s0 = src[i];
            const s1 = src[i + 1];
            const sample = s0 + (s1 - s0) * frac;  // linear interpolation

            // round & clamp to int16
            let v = Math.round(sample);
            if (v > 32767) v = 32767;
            else if (v < -32768) v = -32768;

            out[outIdx++] = v;
            pos += step; // advance by 2/3 source samples per 24kHz output sample
        }

        // Persist state for next chunk
        this.resample_prev = src[last];   // last actual input sample
        this.resample_frac = pos - last;        // carry fractional position into the next chunk

        // Return only the filled portion as a Buffer (Int16 LE)
        return Buffer.from(out.buffer, 0, outIdx * 2);
    }

}

/* ----------------- Tool definitions (JSON Schemas) ----------------- */

/* ----------------- Helpers ----------------- */

/**
 * Simple energy-based VAD on PCM16 mono.
 * Returns true if below threshold (i.e., likely silent).
 * threshold ~0.005..0.02 are typical; tune per mic/noise.
 */
function getPCM16RMS(buf: Buffer): number {

    if (buf.length < 2) {
        return -1;
    }

    const sampleCount = buf.length / 2;
    let sumSquares = 0;
    for (let i = 0; i < sampleCount; i++) {
        const s = buf.readInt16LE(i * 2);
        const norm = s / 32768; // -1..1
        sumSquares += norm * norm;
    }
    const rms = Math.sqrt(sumSquares / sampleCount);
    return rms;
}
