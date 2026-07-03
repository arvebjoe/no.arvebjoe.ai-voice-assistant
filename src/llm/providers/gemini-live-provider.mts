import { EventEmitter } from "events";
import { TypedEmitter } from "tiny-typed-emitter";
import { GoogleGenAI, Modality } from "@google/genai";
import { createLogger } from "../../helpers/logger.mjs";
import { ToolManager } from "../tool-manager.mjs";
import { IVoiceProvider, VoiceProviderEvents, VoiceProviderOptions } from "../voice-provider.mjs";
import { loadInstructionModule, InstructionModule } from "../agent-instructions.mjs";
import { pcmToFlacBuffer } from "../../helpers/audio-encoders.mjs";

// Models are constants for now (no per-provider model setting yet). Swap here if
// Google renames/retires a preview model.
const GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview"; // realtime audio session
const GEMINI_TEXT_MODEL = "gemini-2.5-flash";              // one-shot text Q&A (ask-as-text)
const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";   // direct TTS (speak-text)

// Gemini's native-audio voice if none is configured (or the stored OpenAI voice
// doesn't map to a Gemini one). Kore is a clear, neutral prebuilt voice.
const GEMINI_DEFAULT_VOICE = "Kore";

/**
 * The app stores a single `selected_voice` setting using OpenAI's voice names
 * (see SettingsManager.getAvailableVoices). Gemini uses its own prebuilt voice
 * names, so translate from one to the other. Anything already a Gemini voice
 * name (or unknown) falls through to GEMINI_DEFAULT_VOICE via geminiVoiceName().
 */
const OPENAI_TO_GEMINI_VOICE: Record<string, string> = {
    alloy: "Aoede",
    ash: "Charon",
    ballad: "Enceladus",
    coral: "Leda",
    echo: "Puck",
    fable: "Fenrir",
    nova: "Kore",
    onyx: "Orus",
    sage: "Zephyr",
    shimmer: "Aoede",
    verse: "Algieba",
    cedar: "Iapetus",
    marin: "Autonoe",
};

// Gemini prebuilt voices offered in the settings UI (also the set accepted as-is
// when the shared `selected_voice` setting already holds a Gemini name). Every
// OPENAI_TO_GEMINI_VOICE target must appear here so mapped values pass validation.
const GEMINI_VOICES_LIST: { value: string; name: string }[] = [
    { value: "Kore", name: "Kore" },
    { value: "Puck", name: "Puck" },
    { value: "Charon", name: "Charon" },
    { value: "Aoede", name: "Aoede" },
    { value: "Fenrir", name: "Fenrir" },
    { value: "Leda", name: "Leda" },
    { value: "Orus", name: "Orus" },
    { value: "Zephyr", name: "Zephyr" },
    { value: "Enceladus", name: "Enceladus" },
    { value: "Iapetus", name: "Iapetus" },
    { value: "Algieba", name: "Algieba" },
    { value: "Autonoe", name: "Autonoe" },
];

// Valid Gemini prebuilt voices — accepted as-is if the setting already holds one.
const GEMINI_VOICES = new Set(GEMINI_VOICES_LIST.map((v) => v.value));

/** Resolve the configured voice to a Gemini prebuilt voice name. */
function geminiVoiceName(voice: string | undefined | null): string {
    if (!voice) return GEMINI_DEFAULT_VOICE;
    if (OPENAI_TO_GEMINI_VOICE[voice]) return OPENAI_TO_GEMINI_VOICE[voice];
    if (GEMINI_VOICES.has(voice)) return voice; // already a Gemini voice name
    return GEMINI_DEFAULT_VOICE;
}

/**
 * Strip JSON-Schema fields Gemini's function declarations reject (notably
 * `additionalProperties`). ToolManager emits OpenAI's function-parameter shape;
 * Gemini wants the OpenAPI subset.
 */
function sanitizeSchema(schema: any): any {
    if (Array.isArray(schema)) return schema.map(sanitizeSchema);
    if (schema && typeof schema === "object") {
        const out: any = {};
        for (const [k, v] of Object.entries(schema)) {
            if (k === "additionalProperties") continue;
            out[k] = sanitizeSchema(v);
        }
        return out;
    }
    return schema;
}

/**
 * Google Gemini Live API provider.
 *
 * Realtime path: a WebSocket "live" session (`ai.live.connect`) carries mic PCM
 * in (16 kHz) and audio out (24 kHz) plus streaming tool calls — mapped onto the
 * IVoiceProvider event contract. The text-output path (`sendTextForTextResponse`,
 * used by the ask-as-text flow card and the emulator `ask` command) runs as a
 * one-shot `generateContent` with a function-calling loop, since a live session
 * is fixed to a single response modality (AUDIO here).
 */
export class GeminiLiveProvider extends (EventEmitter as new () => TypedEmitter<VoiceProviderEvents>) implements IVoiceProvider {
    // Seam contract: Gemini Live wants 16 kHz PCM input (the PE mic's native rate).
    readonly inputSampleRate = 16000;
    readonly apiKeySettingKey = "gemini_api_key";

    /** Voices offered for this provider in the settings UI. */
    static getAvailableVoices(): { value: string; name: string }[] {
        return GEMINI_VOICES_LIST;
    }

    private homey: any;
    private toolManager: ToolManager;
    private logger = createLogger("GEMINI", true);

    private options: VoiceProviderOptions;
    private ai: GoogleGenAI | null = null;
    private session: any = null;
    private instructionModule: InstructionModule | null = null;
    private instructions = "";

    private connected = false;
    private manuallyClosing = false;
    private reconnectTimer: any = null;
    private reconnectAttempts = 0;

    // Per-turn state: set when the user starts streaming audio; the first model
    // output marks the user's turn as over (-> 'silence' + final 'transcript.done').
    private awaitingResponse = false;
    private currentInputTranscript = "";

    constructor(homey: any, toolManager: ToolManager, opts: VoiceProviderOptions) {
        super();
        this.homey = homey;
        this.toolManager = toolManager;
        this.options = { ...opts };
        void this.refreshInstructions();
    }

    private async refreshInstructions(): Promise<void> {
        try {
            this.instructionModule = await loadInstructionModule(this.options.languageCode);
            this.instructions = this.instructionModule.getDefaultInstructions(
                this.options.languageName,
                this.options.additionalInstructions,
                this.options.supportsTimers,
            );
        } catch (e) {
            this.logger.error("Failed to load instruction module:", e);
            this.instructions = "";
        }
    }

    private client(): GoogleGenAI {
        if (!this.ai) this.ai = new GoogleGenAI({ apiKey: this.options.apiKey ?? "" });
        return this.ai;
    }

    private toolsForGemini(): any[] {
        const defs = this.toolManager.getToolDefinitions();
        return [{
            functionDeclarations: defs.map((d: any) => ({
                name: d.name,
                description: d.description,
                parameters: sanitizeSchema(d.parameters),
            })),
        }];
    }

    // --- lifecycle -----------------------------------------------------------

    async start(): Promise<void> {
        if (this.connected) return;
        if (!this.options.apiKey) {
            this.emit("missing_api_key");
            return;
        }
        this.manuallyClosing = false;
        if (this.reconnectTimer) {
            this.homey.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (!this.instructions) await this.refreshInstructions();

        const voiceName = geminiVoiceName(this.options.voice);
        this.logger.info("Connecting Gemini Live session", "START", { voice: voiceName });
        try {
            this.session = await this.client().live.connect({
                model: GEMINI_LIVE_MODEL,
                callbacks: {
                    onopen: () => {
                        this.logger.info("Live session opened");
                        this.connected = true;
                        this.reconnectAttempts = 0;
                        this.emit("open");
                        this.emit("Healthy");
                    },
                    onmessage: (message: any) => this.onMessage(message),
                    onerror: (e: any) => {
                        this.logger.error("Live session error", e);
                        this.emit("error", e instanceof Error ? e : new Error(String(e?.message ?? e)));
                        this.emit("Unhealthy");
                    },
                    onclose: (e: any) => {
                        this.logger.info("Live session closed", undefined, { reason: e?.reason });
                        this.connected = false;
                        this.emit("close", e?.code ?? 1000, String(e?.reason ?? ""));
                        if (!this.manuallyClosing) this.scheduleReconnect();
                    },
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    systemInstruction: this.instructions,
                    tools: this.toolsForGemini(),
                },
            });
        } catch (e) {
            this.logger.error("Failed to connect Gemini Live", e);
            this.emit("error", e instanceof Error ? e : new Error(String(e)));
            if (!this.manuallyClosing) this.scheduleReconnect();
        }
    }

    close(code = 1000, reason = "client-close"): void {
        this.manuallyClosing = true;
        if (this.reconnectTimer) {
            this.homey.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        try {
            this.session?.close?.();
        } catch { /* ignore */ }
        this.session = null;
        this.connected = false;
        this.emit("close", code, reason);
    }

    async restart(): Promise<void> {
        this.close();
        await new Promise((resolve) => this.homey.setTimeout(resolve, 100));
        this.manuallyClosing = false;
        await this.start();
    }

    private scheduleReconnect(): void {
        if (this.manuallyClosing || this.reconnectTimer) return;
        this.reconnectAttempts++;
        const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts - 1));
        this.logger.info(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`, "RECONNECT");
        this.emit("reconnecting", this.reconnectAttempts, delay);
        this.reconnectTimer = this.homey.setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.start();
            } catch (e) {
                this.emit("reconnectFailed", this.reconnectAttempts, e as Error);
                this.scheduleReconnect();
            }
        }, delay);
    }

    isConnected(): boolean {
        return this.connected;
    }

    hasApiKey(): boolean {
        return !!this.options.apiKey;
    }

    // --- audio in / conversation --------------------------------------------

    sendAudioChunk(pcm16Mono16k: Buffer): void {
        if (!this.connected || !this.session || pcm16Mono16k.length === 0) return;
        this.awaitingResponse = true; // user is speaking this turn
        try {
            this.session.sendRealtimeInput({
                audio: {
                    data: pcm16Mono16k.toString("base64"),
                    mimeType: "audio/pcm;rate=16000",
                },
            });
        } catch (e) {
            this.logger.error("sendAudioChunk failed", e);
        }
    }

    resetConversation(): void {
        // Gemini Live has no per-item delete; context is turn-scoped. No-op for now
        // (a full reset would require reconnecting the session).
        this.currentInputTranscript = "";
        this.awaitingResponse = false;
    }

    private onMessage(message: any): void {
        try {
            // Tool calls (function calling)
            const functionCalls = message?.toolCall?.functionCalls;
            if (Array.isArray(functionCalls) && functionCalls.length) {
                void this.handleToolCalls(functionCalls);
            }

            const sc = message?.serverContent;

            // Audio output (base64 PCM16 @ 24 kHz) via the convenience accessor.
            const audioB64: string | undefined = message?.data;
            if (audioB64) {
                this.markResponding();
                this.emit("audio.delta", Buffer.from(audioB64, "base64"));
            }

            // Assistant spoken-output transcript -> transcript.delta
            const outText = sc?.outputTranscription?.text;
            if (outText) {
                this.markResponding();
                this.emit("transcript.delta", outText);
            }

            // User input transcript accumulates until the turn flips to responding.
            const inText = sc?.inputTranscription?.text;
            if (inText) {
                this.currentInputTranscript += inText;
                this.emit("input_transcript.delta", inText);
            }

            if (sc?.turnComplete) {
                this.emit("response.done");
                this.endTurn();
            }
            if (sc?.interrupted) {
                this.endTurn();
            }
        } catch (e) {
            this.logger.error("onMessage error", e);
        }
    }

    /**
     * Fire once per user turn when the model starts producing output: the user
     * has stopped speaking (server VAD), so emit `silence` (device closes the
     * mic) plus the final user `transcript.done`.
     */
    private markResponding(): void {
        if (!this.awaitingResponse) return;
        this.awaitingResponse = false;
        this.emit("silence", "server");
        this.emit("transcript.done", this.currentInputTranscript.trim());
        this.currentInputTranscript = "";
    }

    private endTurn(): void {
        this.awaitingResponse = false;
        this.currentInputTranscript = "";
    }

    private async handleToolCalls(functionCalls: any[]): Promise<void> {
        const handlers = this.toolManager.getToolHandlers();
        const functionResponses: any[] = [];

        for (const fc of functionCalls) {
            const name: string = fc?.name;
            const args = fc?.args ?? {};
            this.emit("tool.called", { callId: fc?.id ?? name, name, args });

            let output: any;
            try {
                const fn = handlers[name];
                output = fn ? await fn(args) : { error: `Unknown tool: ${name}` };
            } catch (e: any) {
                output = { error: String(e?.message ?? e) };
            }

            functionResponses.push({
                id: fc?.id,
                name,
                response: typeof output === "string" ? { text: output } : (output ?? {}),
            });
        }

        try {
            this.session?.sendToolResponse({ functionResponses });
        } catch (e) {
            this.logger.error("sendToolResponse failed", e);
        }
    }

    // --- text in / out -------------------------------------------------------

    /** Text in -> audio out: inject a user turn into the live (AUDIO) session. */
    sendTextForAudioResponse(text: string): void {
        if (!this.connected || !this.session) return;
        try {
            this.session.sendClientContent({
                turns: [{ role: "user", parts: [{ text }] }],
                turnComplete: true,
            });
        } catch (e) {
            this.logger.error("sendTextForAudioResponse failed", e);
        }
    }

    /**
     * Text in -> text out. The live session is AUDIO-only, so this runs as a
     * one-shot generateContent with a function-calling loop and emits `text.done`
     * with the final answer (matches what the device's ask-as-text path awaits).
     */
    async sendTextForTextResponse(question: string): Promise<void> {
        try {
            if (!this.instructions) await this.refreshInstructions();
            const ai = this.client();
            const handlers = this.toolManager.getToolHandlers();
            const tools = this.toolsForGemini();
            const contents: any[] = [{ role: "user", parts: [{ text: question }] }];

            let finalText = "";
            for (let i = 0; i < 5; i++) {
                const resp: any = await ai.models.generateContent({
                    model: GEMINI_TEXT_MODEL,
                    contents,
                    config: { systemInstruction: this.instructions, tools },
                });

                const fcs: any[] = resp?.functionCalls ?? [];
                if (fcs.length) {
                    contents.push({ role: "model", parts: fcs.map((fc) => ({ functionCall: { name: fc.name, args: fc.args } })) });
                    const respParts: any[] = [];
                    for (const fc of fcs) {
                        this.emit("tool.called", { callId: fc?.id ?? fc?.name, name: fc?.name, args: fc?.args ?? {} });
                        let output: any;
                        try {
                            const fn = handlers[fc.name];
                            output = fn ? await fn(fc.args ?? {}) : { error: `Unknown tool: ${fc.name}` };
                        } catch (e: any) {
                            output = { error: String(e?.message ?? e) };
                        }
                        respParts.push({ functionResponse: { name: fc.name, response: typeof output === "string" ? { text: output } : (output ?? {}) } });
                    }
                    contents.push({ role: "user", parts: respParts });
                    continue; // re-ask with tool results
                }

                finalText = resp?.text ?? "";
                break;
            }

            this.emit("text.done", { text: finalText, type: "gemini.text.done" });
        } catch (e: any) {
            this.logger.error("sendTextForTextResponse failed", e);
            this.emit("text.done", { text: `Error: ${e?.message ?? e}` });
        }
    }

    /** Direct TTS -> FLAC (honors the seam's FLAC contract via pcmToFlacBuffer). */
    async textToSpeech(text: string): Promise<Buffer> {
        const ai = this.client();
        const resp: any = await ai.models.generateContent({
            model: GEMINI_TTS_MODEL,
            contents: [{ role: "user", parts: [{ text }] }],
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: geminiVoiceName(this.options.voice) } } },
            },
        });

        const b64: string | undefined = resp?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        const pcm = Buffer.from(b64 ?? "", "base64"); // 24 kHz PCM16 mono
        return pcmToFlacBuffer(pcm, { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
    }

    // --- on-the-fly settings updates ----------------------------------------
    // Instruction-affecting changes need a reconnect to apply to a live session;
    // the device calls restart() after these in handleSettingsChange.

    async updateApiKey(newApiKey: string): Promise<void> {
        this.options.apiKey = newApiKey;
        this.ai = null; // force a fresh client with the new key on next use
    }

    async updateVoice(newVoice: string): Promise<void> {
        // The app stores OpenAI voice names; geminiVoiceName() maps them to Gemini's
        // own voices when the session connects. A live session's voice is fixed at
        // connect time, so the device calls restart() after this to apply it.
        this.options.voice = newVoice;
    }

    async updateLanguage(newLanguageCode: string, newLanguageName: string): Promise<void> {
        this.options.languageCode = newLanguageCode;
        this.options.languageName = newLanguageName;
        await this.refreshInstructions();
    }

    async updateAdditionalInstructions(newAdditionalInstructions: string | null): Promise<void> {
        this.options.additionalInstructions = newAdditionalInstructions;
        await this.refreshInstructions();
    }

    async updateZone(newDeviceZone: string): Promise<void> {
        this.options.deviceZone = newDeviceZone;
        // Keep the tool manager's standard zone in sync (see OpenAI provider).
        this.toolManager.setStandardZone(newDeviceZone);
        await this.refreshInstructions();
    }

    async updateTimerSupport(supportsTimers: boolean): Promise<void> {
        if (this.options.supportsTimers === supportsTimers) return;
        this.options.supportsTimers = supportsTimers;
        await this.refreshInstructions();
    }
}
