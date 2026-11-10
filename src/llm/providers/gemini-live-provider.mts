import { EventEmitter } from "events";
import { TypedEmitter } from "tiny-typed-emitter";
import { GoogleGenAI, Modality } from "@google/genai";
import { createLogger } from "../../helpers/logger.mjs";
import { ToolManager } from "../tool-manager.mjs";
import { IVoiceProvider, VoiceProviderEvents, VoiceProviderOptions } from "../voice-provider.mjs";
import { InstructionState } from "../instruction-state.mjs";
import { ReconnectPolicy } from "../reconnect-policy.mjs";
import { pcmToFlacBuffer } from "../../helpers/audio-encoders.mjs";
import { settingsManager } from "../../settings/settings-manager.mjs";
import {
    GeminiModelRole, GEMINI_DEFAULT_MODELS, GEMINI_MODEL_SETTINGS,
    isGeminiModelGone, isGeminiOverloaded, isGeminiSpeechLanguageRejected, pickGeminiFallback,
} from "./gemini-models.mjs";

// Which model serves each role (live session / text asks / direct TTS) is a
// user setting with built-in defaults, and a model Google retires is replaced
// automatically - see gemini-models.mts for why.

/** How many replacement models one call may try before giving up. */
const MAX_MODEL_FALLBACKS = 2;
/** How many other models one call may try while the chosen one is overloaded. */
const MAX_OVERLOAD_STANDINS = 3;
/** How long a stand-in that answered keeps serving its role before the chosen model is tried again. */
const OVERLOAD_STANDIN_HOLD_MS = 60_000;


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
    private instructionState = new InstructionState(this.logger);

    private connected = false;
    private manuallyClosing = false;
    // Reconnection campaign (shared backoff machinery — see ReconnectPolicy).
    private reconnect: ReconnectPolicy;

    // Per-turn state: set when the user starts streaming audio; the first model
    // output marks the user's turn as over (-> 'silence' + final 'transcript.done').
    private awaitingResponse = false;
    private currentInputTranscript = "";
    // Gemini Live sends no explicit speech-start with automatic VAD, so the
    // first input-transcription delta of a listening window doubles as the
    // 'speech' signal (drives the satellite's listening LED via stt_vad_start;
    // without it the PE's ring sat on the "waiting" pattern for whole turns).
    private speechSignaled = false;

    // A turn that issued tool calls is NOT the end of the conversation turn:
    // sendToolResponse feeds the result back and the model continues with the
    // spoken answer (its own turnComplete) — mirror of the OpenAI provider's
    // response.done suppression on function_call turns (M8).
    private pendingToolTurn = false;
    private toolResponseSent = false;

    constructor(homey: any, toolManager: ToolManager, opts: VoiceProviderOptions) {
        super();
        this.homey = homey;
        this.toolManager = toolManager;
        this.options = { ...opts };
        this.reconnect = new ReconnectPolicy(homey, {
            connect: () => this.start(),
            onScheduled: (attempt, delay) => this.emit("reconnecting", attempt, delay),
            onAttemptFailed: (attempt, error) => this.emit("reconnectFailed", attempt, error),
        }, this.logger);
        // Kick off the instruction load; start() awaits it before connecting.
        void this.instructionState.reload(this.instructionParams());
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
            supportsJev: this.options.supportsJev,
        };
    }

    private client(): GoogleGenAI {
        if (!this.ai) this.ai = new GoogleGenAI({ apiKey: this.options.apiKey ?? "" });
        return this.ai;
    }

    // --- model selection ------------------------------------------------------

    /**
     * Replacements chosen after Google reported a model gone, per role. Keyed
     * by the CONFIGURED model they replace, so picking a different model in
     * settings drops the replacement instead of overriding the user's choice.
     */
    private modelFallbacks: Partial<Record<GeminiModelRole, { from: string; to: string }>> = {};
    /** Live models that failed as gone since the last successful setup (stops loops). */
    private liveModelsTried = new Set<string>();
    /** Live models that refused speechConfig.languageCode; connected without it from then on. */
    private speechLanguageRejected = new Set<string>();

    /** The model the user configured for a role (setting), or the built-in default. */
    private configuredModel(role: GeminiModelRole): string {
        const saved = settingsManager.getGlobal<string>(GEMINI_MODEL_SETTINGS[role], "");
        return (typeof saved === "string" ? saved.trim() : "") || GEMINI_DEFAULT_MODELS[role];
    }

    /** The model to use for a role right now: the configured one, or its replacement. */
    modelFor(role: GeminiModelRole): string {
        const configured = this.configuredModel(role);
        const fallback = this.modelFallbacks[role];
        return fallback && fallback.from === configured ? fallback.to : configured;
    }

    /**
     * `model` was reported gone: pick the best listed replacement not yet
     * tried, remember it for this role and tell the host (which notifies the
     * user once). Returns null when nothing else is available.
     */
    private async replaceGoneModel(role: GeminiModelRole, model: string, tried: ReadonlySet<string>): Promise<string | null> {
        const fallback = await pickGeminiFallback(this.options.apiKey ?? "", role, tried);
        if (fallback) {
            this.modelFallbacks[role] = { from: this.configuredModel(role), to: fallback };
        }
        this.logger.warn(`Gemini model ${model} (${role}) is no longer available - ${fallback ? `switching to ${fallback}` : "no replacement found"}`);
        this.emit("model_unavailable", {
            stage: role === "tts" ? "tts" : role === "live" ? "live" : "llm",
            model,
            fallback,
            reason: "retired",
        });
        return fallback;
    }

    /** The stand-in that last answered for a busy model, reused until `until`. */
    private overloadStandIn: Partial<Record<GeminiModelRole, { from: string; model: string; until: number }>> = {};

    /** Pause before retrying an overloaded model (static so tests can zero it). */
    static OVERLOAD_RETRY_MS = 1500;

    /**
     * Run one generateContent-style call for a role. Two kinds of failure are
     * recovered, everything else is rethrown:
     *
     *  - Model GONE (retired, 404): switch to the best listed replacement for
     *    good and tell the host - see replaceGoneModel().
     *  - Model OVERLOADED (503 "high demand" / 429): retry the same model once
     *    after a short pause, then walk up to MAX_OVERLOAD_STANDINS other
     *    listed models (lite tier first - it has the headroom) for THIS call
     *    only. Never notified, and held for just OVERLOAD_STANDIN_HOLD_MS -
     *    the model is fine, only busy, so the user's choice comes back by itself.
     */
    private async withModel<T>(role: GeminiModelRole, run: (model: string) => Promise<T>): Promise<T> {
        const gone = new Set<string>();
        const busy = new Set<string>();       // models that answered "overloaded" in this call
        let retriedSame = false;
        let standIn: string | null = null;    // this call's model while the chosen one is busy
        // The chosen model was busy moments ago: go straight to the stand-in
        // that answered. One ask is several calls (the tool loop), and bouncing
        // back to the busy model between them costs a retry each time and feeds
        // it a tool turn another model signed.
        const held = this.overloadStandIn[role];
        if (held && held.until > Date.now() && held.from === this.modelFor(role)) {
            standIn = held.model;
            busy.add(held.from);
        }
        for (;;) {
            const model = standIn ?? this.modelFor(role);
            try {
                const result = await run(model);
                if (standIn) {
                    this.overloadStandIn[role] = { from: this.modelFor(role), model: standIn, until: Date.now() + OVERLOAD_STANDIN_HOLD_MS };
                }
                return result;
            } catch (e) {
                if (!standIn && isGeminiModelGone(e) && gone.size < MAX_MODEL_FALLBACKS) {
                    gone.add(model);
                    if (await this.replaceGoneModel(role, model, gone)) continue;
                    throw e;
                }
                // A stand-in that is gone or busy just means "try the next one".
                if (!isGeminiOverloaded(e) && !(standIn && isGeminiModelGone(e))) throw e;
                if (!standIn && !retriedSame) {
                    retriedSame = true;
                    this.logger.warn(`Gemini model ${model} (${role}) is overloaded - retrying in ${GeminiLiveProvider.OVERLOAD_RETRY_MS} ms`);
                    await new Promise((resolve) => this.homey.setTimeout(resolve, GeminiLiveProvider.OVERLOAD_RETRY_MS));
                    continue;
                }
                busy.add(model);
                // busy holds the chosen model plus every stand-in tried so far.
                if (busy.size > MAX_OVERLOAD_STANDINS) throw e;
                standIn = await pickGeminiFallback(this.options.apiKey ?? "", role, new Set([...busy, ...gone]), { preferLite: true });
                if (!standIn) throw e;
                this.logger.warn(`Gemini model ${model} (${role}) is overloaded - trying ${standIn} for this call`);
            }
        }
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

    /**
     * Input-transcription config. Sent empty until now, which left the sidecar
     * transcriber detecting the language per utterance with nothing to go on: a
     * one-second Dutch command lands in German often enough to notice ("Open het
     * keukenraam" → "Ohne das Küchenfenster"), because the languages are
     * phonetically close and there is little signal in a short utterance. The
     * reply stays correct — Live is audio-to-audio and the model hears the real
     * language — so only the transcript is wrong, which is what the CONVO log,
     * the `assistant-heard` Flow trigger and the empty-transcript gate read.
     *
     * `adaptationPhrases` is the same device/zone vocabulary the OpenAI provider
     * sends as a prompt (`ToolManager.getSttVocabulary`), and takes a real list
     * here instead of a sentence. Capped like the OpenAI prompt: an unusually
     * large home must not push an unbounded list into every session.
     */
    private transcriptionConfig(): Record<string, unknown> {
        const config: Record<string, unknown> = {};

        const code = (this.options.languageCode || '').trim();
        if (code) {
            config.languageHints = { languageCodes: [code] };
        }

        const phrases: string[] = [];
        let length = 0;
        for (const name of this.toolManager.getSttVocabulary()) {
            if (phrases.length >= GeminiLiveProvider.MAX_ADAPTATION_PHRASES) break;
            if (length + name.length > GeminiLiveProvider.MAX_ADAPTATION_CHARS) break;
            phrases.push(name);
            length += name.length;
        }
        if (phrases.length > 0) {
            config.adaptationPhrases = phrases;
        }

        return config;
    }

    private static readonly MAX_ADAPTATION_PHRASES = 100;
    private static readonly MAX_ADAPTATION_CHARS = 800;

    // --- lifecycle -----------------------------------------------------------

    async start(): Promise<void> {
        if (this.connected) return;
        if (!this.options.apiKey) {
            this.emit("missing_api_key");
            return;
        }
        this.manuallyClosing = false;
        // A manual start() supersedes any scheduled reconnect attempt.
        this.reconnect.clearTimer();
        // Never configure the session with an empty prompt — await the
        // constructor's load and retry once if it failed.
        await this.instructionState.ensureLoaded(this.instructionParams());

        const voiceName = geminiVoiceName(this.options.voice);
        const model = this.modelFor("live");
        this.logger.info("Connecting Gemini Live session", "START", { voice: voiceName, model });
        try {
            this.session = await this.client().live.connect({
                model,
                callbacks: {
                    onopen: () => {
                        // Socket up only - the server has not accepted the setup
                        // yet and can still close at once (bad model, rejected
                        // language code). The reconnect backoff is therefore reset
                        // on setupComplete (onMessage), NOT here: resetting on open
                        // pinned every retry at "attempt 1 in 1000ms" forever.
                        this.logger.info("Live session opened");
                        this.connected = true;
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
                        // The Live API rejects a retired/unknown model by closing
                        // the socket with the reason, not by failing connect().
                        void this.reconnectAfterFailure(model, e);
                    },
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName } },
                        // The spoken reply's language. The model picks it from the
                        // conversation on its own, but saying it removes the same
                        // guess the transcriber was getting wrong. Native-audio
                        // models refuse an explicit code (they choose the language
                        // themselves) - those are remembered and sent none.
                        ...(this.options.languageCode && !this.speechLanguageRejected.has(model)
                            ? { languageCode: this.options.languageCode } : {}),
                    },
                    inputAudioTranscription: this.transcriptionConfig(),
                    outputAudioTranscription: {},
                    systemInstruction: this.instructionState.text,
                    tools: this.toolsForGemini(),
                },
            });
        } catch (e) {
            this.logger.error("Failed to connect Gemini Live", e);
            this.emit("error", e instanceof Error ? e : new Error(String(e)));
            await this.reconnectAfterFailure(model, e);
        }
    }

    /**
     * Schedule the reconnect after a failed connect or an unexpected close. When
     * the failure says the live model is gone, switch to a replacement FIRST so
     * the reconnect uses it - otherwise every attempt would hit the same 404.
     * Each gone model is tried once per campaign (cleared on a successful open),
     * so a list of dead models can't loop.
     */
    private async reconnectAfterFailure(model: string, failure: any): Promise<void> {
        if (this.manuallyClosing) return;
        // "Unsupported language code 'no' for model ...": the model works, it
        // just won't take a spoken-language code. Drop it for this model and
        // reconnect - the model then picks the language from the conversation.
        if (isGeminiSpeechLanguageRejected(failure) && !this.speechLanguageRejected.has(model)) {
            this.speechLanguageRejected.add(model);
            this.logger.warn(`Gemini model ${model} does not accept language code '${this.options.languageCode}' - reconnecting without it`);
        }
        if (isGeminiModelGone(failure) && !this.liveModelsTried.has(model)) {
            this.liveModelsTried.add(model);
            await this.replaceGoneModel("live", model, this.liveModelsTried);
            if (this.manuallyClosing) return;
        }
        this.reconnect.schedule();
    }

    close(code = 1000, reason = "client-close"): void {
        this.manuallyClosing = true;
        this.reconnect.reset();
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
        this.speechSignaled = false;
    }

    private onMessage(message: any): void {
        try {
            // The server accepted the session config: only now is the
            // connection really good, so this is where the campaign ends.
            if (message?.setupComplete) {
                this.liveModelsTried.clear();
                const wasReconnect = this.reconnect.attemptCount > 0;
                this.reconnect.reset();
                if (wasReconnect) {
                    this.emit("reconnected");
                }
            }

            // Tool calls (function calling)
            const functionCalls = message?.toolCall?.functionCalls;
            if (Array.isArray(functionCalls) && functionCalls.length) {
                // Set synchronously so a turnComplete in this same (or the next)
                // message is suppressed even while the handlers are still running.
                this.pendingToolTurn = true;
                this.toolResponseSent = false;
                void this.handleToolCalls(functionCalls);
            }

            const sc = message?.serverContent;

            // Audio output (base64 PCM16 @ 24 kHz) via the convenience accessor.
            const audioB64: string | undefined = message?.data;
            if (audioB64) {
                this.markResponding();
                this.markToolContinuation();
                this.emit("audio.delta", Buffer.from(audioB64, "base64"));
            }

            // Assistant spoken-output transcript -> transcript.delta
            const outText = sc?.outputTranscription?.text;
            if (outText) {
                this.markResponding();
                this.markToolContinuation();
                this.emit("transcript.delta", outText);
            }

            // User input transcript accumulates until the turn flips to responding.
            const inText = sc?.inputTranscription?.text;
            if (inText) {
                if (!this.speechSignaled) {
                    this.speechSignaled = true;
                    this.emit("speech", "server");
                }
                this.currentInputTranscript += inText;
                this.emit("input_transcript.delta", inText);
            }

            if (sc?.turnComplete) {
                if (this.pendingToolTurn) {
                    // Tool-call turn: the continuation with the spoken answer is
                    // still coming, so suppress response.done — emitting it here
                    // closes the device's reply pipeline mid-turn (M8).
                    this.pendingToolTurn = false;
                } else {
                    this.emit("response.done");
                }
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
        this.speechSignaled = false;
        this.emit("silence", "server");
        this.emit("transcript.done", this.currentInputTranscript.trim());
        this.currentInputTranscript = "";
    }

    /**
     * First model output after the tool response went back: the continuation is
     * streaming, so the next turnComplete really ends the turn. (Covers a server
     * that does not send a turnComplete for the tool-call turn itself; output
     * arriving before our tool response is pre-tool speech and doesn't count.)
     */
    private markToolContinuation(): void {
        if (this.pendingToolTurn && this.toolResponseSent) {
            this.pendingToolTurn = false;
        }
    }

    private endTurn(): void {
        this.awaitingResponse = false;
        this.speechSignaled = false;
        this.currentInputTranscript = "";
        // A barge-in (interrupted) aborts any pending tool continuation too.
        this.pendingToolTurn = false;
    }

    private async handleToolCalls(functionCalls: any[]): Promise<void> {
        const functionResponses: any[] = [];

        for (const fc of functionCalls) {
            const name: string = fc?.name;
            const args = fc?.args ?? {};
            this.emit("tool.called", { callId: fc?.id ?? name, name, args });

            const { output } = await this.toolManager.execute(name, args);

            functionResponses.push({
                id: fc?.id,
                name,
                response: typeof output === "string" ? { text: output } : (output ?? {}),
            });
        }

        try {
            this.session?.sendToolResponse({ functionResponses });
            this.toolResponseSent = true;
        } catch (e) {
            this.logger.error("sendToolResponse failed", e);
            this.pendingToolTurn = false; // no continuation is coming
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
            await this.instructionState.ensureLoaded(this.instructionParams());
            const ai = this.client();
            const tools = this.toolsForGemini();
            const contents: any[] = [{ role: "user", parts: [{ text: question }] }];

            let finalText = "";
            for (let i = 0; i < 5; i++) {
                const resp: any = await this.withModel("text", (model) => ai.models.generateContent({
                    model,
                    contents,
                    config: { systemInstruction: this.instructionState.text, tools },
                }));

                const fcs: any[] = resp?.functionCalls ?? [];
                if (fcs.length) {
                    // Echo the model's turn back VERBATIM. Gemini 3 attaches a
                    // thoughtSignature to its functionCall parts and rejects the
                    // follow-up (400 "missing a thought_signature") when the turn
                    // is rebuilt from name+args alone. The rebuild is only the
                    // fallback for a response without candidate content.
                    const modelTurn = resp?.candidates?.[0]?.content;
                    contents.push(modelTurn?.parts?.length
                        ? modelTurn
                        : { role: "model", parts: fcs.map((fc) => ({ functionCall: { name: fc.name, args: fc.args } })) });
                    const respParts: any[] = [];
                    for (const fc of fcs) {
                        this.emit("tool.called", { callId: fc?.id ?? fc?.name, name: fc?.name, args: fc?.args ?? {} });
                        const { output } = await this.toolManager.execute(fc.name, fc.args ?? {});
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
            // error: true lets a consumer that would SPEAK the answer (the Flow
            // assistant) fail instead of reading an error body aloud.
            this.emit("text.done", { text: `Error: ${e?.message ?? e}`, error: true });
        }
    }

    /** Direct TTS -> FLAC (honors the seam's FLAC contract via pcmToFlacBuffer). */
    async textToSpeech(text: string): Promise<Buffer> {
        const ai = this.client();
        const resp: any = await this.withModel("tts", (model) => ai.models.generateContent({
            model,
            // The bare text and nothing else: Gemini 3.8 TTS treats the text
            // field as a strictly verbatim transcript, so any steering preamble
            // is READ ALOUD (it was - see tts-steering.mts). The model detects
            // the language from the text itself.
            contents: [{ role: "user", parts: [{ text }] }],
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: geminiVoiceName(this.options.voice) } } },
            },
        }));

        // The audio is not always the first part, and a refused or filtered
        // request comes back 200 with no audio at all - say so instead of
        // encoding zero samples into a silent clip.
        const parts: any[] = resp?.candidates?.[0]?.content?.parts ?? [];
        const b64: string | undefined = parts.find((p) => p?.inlineData?.data)?.inlineData?.data;
        if (!b64) {
            const why = resp?.candidates?.[0]?.finishReason ?? resp?.promptFeedback?.blockReason ?? "no audio in the response";
            throw new Error(`Gemini text-to-speech returned no audio (${why})`);
        }
        const pcm = Buffer.from(b64, "base64"); // 24 kHz PCM16 mono
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
        await this.instructionState.reload(this.instructionParams());
    }

    async updateAdditionalInstructions(newAdditionalInstructions: string | null): Promise<void> {
        this.options.additionalInstructions = newAdditionalInstructions;
        await this.instructionState.reload(this.instructionParams());
    }

    async updateZone(newDeviceZone: string): Promise<void> {
        this.options.deviceZone = newDeviceZone;
        // Keep the tool manager's standard zone in sync (see OpenAI provider).
        this.toolManager.setStandardZone(newDeviceZone);
        await this.instructionState.reload(this.instructionParams());
    }

    async updateTimerSupport(supportsTimers: boolean): Promise<void> {
        if (this.options.supportsTimers === supportsTimers) return;
        this.options.supportsTimers = supportsTimers;
        await this.instructionState.reload(this.instructionParams());
    }

    async updateShoppingListSupport(supportsShoppingList: boolean): Promise<void> {
        if (this.options.supportsShoppingList === supportsShoppingList) return;
        this.options.supportsShoppingList = supportsShoppingList;
        await this.instructionState.reload(this.instructionParams());
    }

    async updateMusicSupport(supportsMusic: boolean): Promise<void> {
        if (this.options.supportsMusic === supportsMusic) return;
        this.options.supportsMusic = supportsMusic;
        await this.instructionState.reload(this.instructionParams());
    }

    async updateJevSupport(supportsJev: boolean): Promise<void> {
        if (this.options.supportsJev === supportsJev) return;
        this.options.supportsJev = supportsJev;
        await this.instructionState.reload(this.instructionParams());
    }
}
