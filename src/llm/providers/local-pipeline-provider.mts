import { EventEmitter } from "events";
import { TypedEmitter } from "tiny-typed-emitter";
import { createLogger } from "../../helpers/logger.mjs";
import { ToolManager } from "../tool-manager.mjs";
import { IVoiceProvider, VoiceProviderEvents, VoiceProviderOptions } from "../voice-provider.mjs";
import { InstructionState } from "../instruction-state.mjs";
import { ReconnectPolicy } from "../reconnect-policy.mjs";
import { pcmToFlacBuffer } from "../../helpers/audio-encoders.mjs";
import { resamplePcm16Mono } from "../../helpers/wav.mjs";
import { settingsManager, GlobalSettings } from "../../settings/settings-manager.mjs";
import { isBlankOrHallucinatedTranscript } from "../transcript-hallucinations.mjs";
import { SimpleVad } from "./local/simple-vad.mjs";
import { ISttClient } from "./local/stt-client.mjs";
import { ITtsClient } from "./local/tts-client.mjs";
import { WhisperClient, LocalSttConfig } from "./local/whisper-client.mjs";
import { ChatMessage, ILlmClient } from "./local/llm-client.mjs";
import { OllamaClient, LocalLlmConfig } from "./local/ollama-client.mjs";
import { MistralClient, MistralConfig } from "./local/mistral-client.mjs";
import { MistralSttClient } from "./local/mistral-stt-client.mjs";
import { MistralTtsClient, VOXTRAL_TTS_VOICES } from "./local/mistral-tts-client.mjs";
import { PiperClient, LocalTtsConfig } from "./local/piper-client.mjs";
import { OpenAiLlmClient, OpenAiLlmConfig } from "./local/openai-llm-client.mjs";
import { OpenAiSttClient, OpenAiSttConfig } from "./local/openai-stt-client.mjs";
import { OpenAiTtsClient, OpenAiTtsConfig } from "./local/openai-tts-client.mjs";
import { OPENAI_TTS_VOICES } from "./local/openai-compat.mjs";
import { WyomingSttClient, WyomingSttConfig } from "./local/wyoming-stt-client.mjs";

// The app-wide reply-audio contract: audio.delta emits PCM16 mono 24 kHz
// (see voice-provider.mts). Piper voices speak 16/22.05 kHz — resampled up.
const OUTPUT_SAMPLE_RATE = 24000;
// Quiet gap appended after each synthesized sentence so the device's
// PcmSegmenter (cuts on >=300 ms below -45 dBFS) can emit early segments.
const SENTENCE_PAD_MS = 350;
// A model that keeps calling tools forever gets cut off.
const MAX_TOOL_ROUNDS = 5;
// Re-probe the three services while idle so availability stays truthful
// (there is no persistent socket whose close would tell us).
const HEALTH_INTERVAL_MS = 60_000;

/** Default ports of the supported services. */
export const LOCAL_DEFAULT_PORTS = { stt: 9000, llm: 11434, tts: 5000, wyomingStt: 10300 } as const;

/** Selectable backends per pipeline stage (settings: local_stt/llm/tts_provider). */
export type LocalSttProviderId = 'whisper' | 'wyoming' | 'mistral' | 'openai';
export type LocalLlmProviderId = 'ollama' | 'mistral' | 'openai';
export type LocalTtsProviderId = 'piper' | 'mistral' | 'openai';

type LocalConfigs = {
    sttProvider: LocalSttProviderId;
    whisper: LocalSttConfig;
    wyomingStt: WyomingSttConfig;
    llmProvider: LocalLlmProviderId;
    ollama: LocalLlmConfig;
    mistral: MistralConfig;
    ttsProvider: LocalTtsProviderId;
    piper: LocalTtsConfig;
    mistralSttModel: string;
    mistralTtsModel: string;
    openaiStt: OpenAiSttConfig;
    openaiLlm: OpenAiLlmConfig;
    openaiTts: Omit<OpenAiTtsConfig, 'voice'>;
};

/** Read the local-pipeline endpoint settings from the global settings store. */
function readLocalConfigs(): LocalConfigs {
    const g = <T,>(key: string, fallback: T): T => settingsManager.getGlobal<T>(key, fallback);
    const s = (key: string): string => String(g(key, '') ?? '').trim();
    // Backend selector: anything not in the stage's valid list (including
    // empty) falls back to the stage's LAN default.
    const stage = (key: string, valid: string[], fallback: string): string => {
        const v = s(key);
        return valid.includes(v) ? v : fallback;
    };
    return {
        sttProvider: stage('local_stt_provider', ['whisper', 'wyoming', 'mistral', 'openai'], 'whisper') as LocalSttProviderId,
        whisper: {
            host: s('local_stt_host'),
            port: Number(g('local_stt_port', LOCAL_DEFAULT_PORTS.stt)) || LOCAL_DEFAULT_PORTS.stt,
        },
        wyomingStt: {
            host: s('wyoming_stt_host'),
            port: Number(g('wyoming_stt_port', LOCAL_DEFAULT_PORTS.wyomingStt)) || LOCAL_DEFAULT_PORTS.wyomingStt,
        },
        llmProvider: stage('local_llm_provider', ['ollama', 'mistral', 'openai'], 'ollama') as LocalLlmProviderId,
        ollama: {
            host: s('local_llm_host'),
            port: Number(g('local_llm_port', LOCAL_DEFAULT_PORTS.llm)) || LOCAL_DEFAULT_PORTS.llm,
            model: s('local_llm_model'),
        },
        mistral: {
            apiKey: s('mistral_api_key'),
            model: s('mistral_model'),
        },
        ttsProvider: stage('local_tts_provider', ['piper', 'mistral', 'openai'], 'piper') as LocalTtsProviderId,
        piper: {
            host: s('local_tts_host'),
            port: Number(g('local_tts_port', LOCAL_DEFAULT_PORTS.tts)) || LOCAL_DEFAULT_PORTS.tts,
        },
        mistralSttModel: s('mistral_stt_model'),
        mistralTtsModel: s('mistral_tts_model'),
        // Generic OpenAI-compatible backends: each stage may point at a
        // different server (Groq STT + LM Studio LLM + OpenAI TTS, etc.).
        openaiStt: { baseUrl: s('openai_stt_url'), apiKey: s('openai_stt_key'), model: s('openai_stt_model') },
        openaiLlm: { baseUrl: s('openai_llm_url'), apiKey: s('openai_llm_key'), model: s('openai_llm_model') },
        openaiTts: { baseUrl: s('openai_tts_url'), apiKey: s('openai_tts_key'), model: s('openai_tts_model'), voiceOverride: s('openai_tts_voice') },
    };
}

/** Build the STT stage for the selected backend. */
function buildSttClient(configs: LocalConfigs): ISttClient {
    switch (configs.sttProvider) {
        case 'wyoming': return new WyomingSttClient(configs.wyomingStt);
        case 'mistral': return new MistralSttClient({ apiKey: configs.mistral.apiKey, model: configs.mistralSttModel });
        case 'openai': return new OpenAiSttClient(configs.openaiStt);
        default: return new WhisperClient(configs.whisper);
    }
}

/** Build the LLM stage for the selected backend. */
function buildLlmClient(configs: LocalConfigs): ILlmClient {
    switch (configs.llmProvider) {
        case 'mistral': return new MistralClient(configs.mistral);
        case 'openai': return new OpenAiLlmClient(configs.openaiLlm);
        default: return new OllamaClient(configs.ollama);
    }
}

/** Build the TTS stage for the selected backend. */
function buildTtsClient(configs: LocalConfigs, voice: string): ITtsClient {
    switch (configs.ttsProvider) {
        case 'mistral': return new MistralTtsClient({ apiKey: configs.mistral.apiKey, model: configs.mistralTtsModel, voice });
        case 'openai': return new OpenAiTtsClient({ ...configs.openaiTts, voice });
        default: return new PiperClient(configs.piper);
    }
}

/**
 * Streaming filter that removes <think>…</think> spans from LLM output.
 * Reasoning models on Ollama (qwen3, deepseek-r1, …) may emit their chain of
 * thought inline; speaking it aloud would be absurd. Stateful across deltas —
 * a tag can be torn across chunk boundaries, so a suspicious tail is held
 * back until the next delta decides.
 */
export class ThinkTagFilter {
    private inThink = false;
    private carry = '';

    feed(delta: string): string {
        let text = this.carry + delta;
        this.carry = '';
        let out = '';

        for (; ;) {
            if (this.inThink) {
                const end = text.indexOf('</think>');
                if (end < 0) {
                    // Everything is thought; keep a tail in case '</think>' is torn.
                    this.carry = text.slice(Math.max(0, text.length - 8));
                    return out;
                }
                text = text.slice(end + 8);
                this.inThink = false;
            }
            const start = text.indexOf('<think>');
            if (start < 0) {
                // Hold back a potentially-torn '<think>' prefix at the very end.
                const safe = this.safeLength(text);
                out += text.slice(0, safe);
                this.carry = text.slice(safe);
                return out;
            }
            out += text.slice(0, start);
            text = text.slice(start + 7);
            this.inThink = true;
        }
    }

    flush(): string {
        const rest = this.inThink ? '' : this.carry;
        this.carry = '';
        return rest;
    }

    /** Length of the prefix that cannot be the start of a torn '<think>' tag. */
    private safeLength(text: string): number {
        const max = Math.min(7, text.length);
        for (let n = max; n > 0; n--) {
            if (text.endsWith('<think>'.slice(0, n))) return text.length - n;
        }
        return text.length;
    }
}

/**
 * Split streamed LLM text into speakable sentences and synthesize them with
 * Piper one by one, in order, while the LLM is still generating — the poor
 * man's streaming TTS. Each clip is resampled to 24 kHz and followed by a
 * silence pad so the device's segmenter can cut and play it early.
 */
class SentenceSpeaker {
    private buffer = '';
    private chain: Promise<void> = Promise.resolve();
    private failed: Error | null = null;

    constructor(
        private synthesize: (sentence: string) => Promise<{ pcm: Buffer; sampleRate: number }>,
        private emitAudio: (pcm24k: Buffer) => void,
        private minChars = 24,
    ) { }

    feed(delta: string): void {
        this.buffer += delta;
        // Cut after sentence punctuation followed by whitespace, or a newline.
        for (; ;) {
            const m = this.buffer.match(/[.!?…]+[)"'»]?\s+|\n+/);
            if (!m || m.index === undefined) return;
            const cut = m.index + m[0].length;
            if (cut < this.minChars && this.buffer.length < 400) return; // avoid choppy "1." fragments
            const sentence = this.buffer.slice(0, cut);
            this.buffer = this.buffer.slice(cut);
            this.enqueue(sentence);
        }
    }

    /** Flush the tail and wait for every queued synthesis to finish. */
    async finish(): Promise<void> {
        this.enqueue(this.buffer);
        this.buffer = '';
        await this.chain;
        if (this.failed) throw this.failed;
    }

    private enqueue(raw: string): void {
        const text = this.cleanForSpeech(raw);
        if (!text) return;
        this.chain = this.chain.then(async () => {
            if (this.failed) return; // one failure poisons the turn; don't hammer the server
            try {
                const { pcm, sampleRate } = await this.synthesize(text);
                if (pcm.length === 0) return;
                const pcm24k = resamplePcm16Mono(pcm, sampleRate, OUTPUT_SAMPLE_RATE);
                const pad = Buffer.alloc(Math.round(OUTPUT_SAMPLE_RATE * SENTENCE_PAD_MS / 1000) * 2);
                this.emitAudio(Buffer.concat([pcm24k, pad]));
            } catch (err: any) {
                this.failed = err instanceof Error ? err : new Error(String(err));
            }
        });
    }

    /** Strip markdown decoration the model may emit despite the instructions. */
    private cleanForSpeech(text: string): string {
        return text
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/[*_`#]+/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }
}

/**
 * Local / self-hosted voice pipeline provider:
 *
 *   mic PCM 16 kHz -> SimpleVad -> Whisper (STT) -> Ollama (LLM + tools) -> Piper (TTS) -> 24 kHz PCM
 *
 * Unlike the cloud providers there is no persistent session — every stage is a
 * plain HTTP call to a LAN service, and end-of-speech detection (the cloud
 * providers' server VAD) runs here on-device. Conversation context is a local
 * message list, kept across turns until resetConversation().
 */
export class LocalPipelineProvider extends (EventEmitter as new () => TypedEmitter<VoiceProviderEvents>) implements IVoiceProvider {
    // The PE mic's native rate — no upsampling, and exactly what Whisper wants.
    readonly inputSampleRate = 16000;
    // No API key in this round. The setting never exists, so its value is
    // always undefined/'' and the device's key-change check stays inert.
    readonly apiKeySettingKey = "local_api_key";

    /**
     * Voices depend on the selected TTS backend: Piper's voice is fixed
     * server-side (single placeholder entry), Voxtral offers preset voices.
     * `ttsBackend` lets the settings page preview an unsaved dropdown choice;
     * omitted, the saved setting decides.
     */
    static getAvailableVoices(ttsBackend?: string): { value: string; name: string }[] {
        const backend = ttsBackend ?? settingsManager.getGlobal<string>('local_tts_provider', 'piper');
        if (backend === 'mistral') return VOXTRAL_TTS_VOICES;
        // Standard OpenAI voices; custom servers (Kokoro etc.) use the
        // free-text voice override in the TTS section instead.
        if (backend === 'openai') return OPENAI_TTS_VOICES;
        return [{ value: "server-default", name: "Piper server voice" }];
    }

    private homey: any;
    private toolManager: ToolManager;
    private logger = createLogger("LOCAL", true);
    private options: VoiceProviderOptions;
    private instructionState = new InstructionState(this.logger);
    private reconnect: ReconnectPolicy;

    private stt: ISttClient;
    private llm: ILlmClient;
    private tts: ITtsClient;
    private settingsUnsubscribe?: () => void;

    private connected = false;
    private manuallyClosing = false;
    private healthInterval: any = null;

    // Turn state: 'idle' (nothing happening) -> 'listening' (mic PCM feeding the
    // VAD) -> 'processing' (STT/LLM/TTS running; further mic frames are dropped).
    private phase: 'idle' | 'listening' | 'processing' = 'idle';
    private vad = new SimpleVad();
    // Conversation context (user/assistant/tool messages, no system — that is
    // prepended fresh each round so instruction reloads apply immediately).
    // Backend-neutral (see llm-client.mts), so it survives an LLM backend switch.
    private messages: ChatMessage[] = [];
    private turnAbort: AbortController | null = null;
    // Snapshot of the endpoint settings the clients were last configured with,
    // so a settings save that touches something else doesn't re-probe health.
    private lastConfigJson = '';

    constructor(homey: any, toolManager: ToolManager, opts: VoiceProviderOptions) {
        super();
        this.homey = homey;
        this.toolManager = toolManager;
        this.options = { ...opts };

        const configs = readLocalConfigs();
        this.lastConfigJson = JSON.stringify(configs);
        this.stt = buildSttClient(configs);
        this.llm = buildLlmClient(configs);
        this.tts = buildTtsClient(configs, this.options.voice);

        this.reconnect = new ReconnectPolicy(homey, {
            connect: () => this.start(),
            onScheduled: (attempt, delay) => this.emit("reconnecting", attempt, delay),
            onAttemptFailed: (attempt, error) => this.emit("reconnectFailed", attempt, error),
        }, this.logger);

        // Endpoint settings can change at any time from the settings page; the
        // clients pick the new targets up immediately and health is re-probed.
        // (Provider/voice/language changes are the device's job, not ours.)
        this.settingsUnsubscribe = settingsManager.onGlobals((globals) => this.onGlobalSettings(globals));

        void this.instructionState.reload(this.instructionParams());
    }

    private instructionParams() {
        return {
            languageCode: this.options.languageCode,
            languageName: this.options.languageName,
            additionalInstructions: this.options.additionalInstructions,
            supportsTimers: this.options.supportsTimers,
        };
    }

    private onGlobalSettings(_globals: GlobalSettings): void {
        const configs = readLocalConfigs();
        const json = JSON.stringify(configs);
        if (json === this.lastConfigJson) return;
        this.lastConfigJson = json;
        // All three stages are rebuilt on change (any of them may switch
        // backend entirely); clients are stateless besides caches, so this is
        // cheap and avoids per-backend configure() plumbing.
        this.stt = buildSttClient(configs);
        this.llm = buildLlmClient(configs);
        this.tts = buildTtsClient(configs, this.options.voice);
        if (!this.manuallyClosing) {
            this.logger.info('Local endpoint settings changed — re-checking service health');
            void this.start();
        }
    }

    // --- lifecycle -----------------------------------------------------------

    async start(): Promise<void> {
        this.manuallyClosing = false;
        this.reconnect.clearTimer();
        await this.instructionState.ensureLoaded(this.instructionParams());

        if (!this.stt.hasCredentials() || !this.llm.hasCredentials() || !this.tts.hasCredentials()) {
            // Only Mistral-backed stages can land here: key-driven, so the device's
            // "set API key in app settings" notification is the right message.
            this.logger.warn('A pipeline stage needs an API key — set the Mistral key in the app settings');
            this.setConnected(false);
            this.emit("missing_api_key");
            return; // no reconnect campaign: nothing changes until the settings do
        }
        if (!this.stt.isConfigured() || !this.llm.isConfigured() || !this.tts.isConfigured()) {
            this.logger.warn('Local pipeline not configured — set the STT/LLM/TTS endpoints in the app settings');
            this.setConnected(false);
            return; // no reconnect campaign: nothing changes until the settings do
        }

        try {
            await Promise.all([
                this.stt.check(),
                // resolveModel is Ollama's auto-pick; other backends don't have it.
                this.llm.check().then(() => (this.llm as any).resolveModel?.()),
                this.tts.check(),
            ]);
            const wasReconnect = this.reconnect.attemptCount > 0;
            this.reconnect.reset();
            this.setConnected(true);
            this.emit("open");
            this.emit("Healthy");
            if (wasReconnect) this.emit("reconnected");
            this.logger.info(`Local pipeline healthy (${this.stt.describe()}, ${this.llm.describe()}, ${this.tts.describe()})`);
        } catch (e: any) {
            this.logger.error('Local pipeline health check failed', e);
            this.setConnected(false);
            this.emit("error", e instanceof Error ? e : new Error(String(e?.message ?? e)));
            this.emit("Unhealthy");
            if (!this.manuallyClosing) this.reconnect.schedule();
        }
    }

    close(code = 1000, reason = "client-close"): void {
        this.manuallyClosing = true;
        this.reconnect.reset();
        this.turnAbort?.abort();
        this.turnAbort = null;
        this.phase = 'idle';
        this.setConnected(false);
        this.emit("close", code, reason);
    }

    /** Full teardown for a runtime provider switch / device deletion. */
    destroy(): void {
        this.close();
        this.settingsUnsubscribe?.();
        this.settingsUnsubscribe = undefined;
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

    /**
     * True unless a selected backend needs an API key and none is set (any
     * Mistral-backed stage). The LAN stages are keyless, so this drives the
     * device's missing-key vs not-connected error sound correctly.
     */
    hasApiKey(): boolean {
        return this.stt.hasCredentials() && this.llm.hasCredentials() && this.tts.hasCredentials();
    }

    private setConnected(value: boolean): void {
        this.connected = value;
        if (value) {
            if (!this.healthInterval) {
                this.healthInterval = this.homey.setInterval(() => void this.idleHealthCheck(), HEALTH_INTERVAL_MS);
            }
        } else if (this.healthInterval) {
            this.homey.clearInterval(this.healthInterval);
            this.healthInterval = null;
        }
    }

    /** Periodic idle probe: a stopped Ollama/Whisper/Piper flips us unavailable. */
    private async idleHealthCheck(): Promise<void> {
        if (!this.connected || this.phase !== 'idle') return;
        try {
            await Promise.all([this.stt.check(), this.llm.check(), this.tts.check()]);
        } catch (e: any) {
            this.logger.error('Local service went away', e);
            this.setConnected(false);
            this.emit("Unhealthy");
            if (!this.manuallyClosing) this.reconnect.schedule();
        }
    }

    // --- audio in / conversation ---------------------------------------------

    sendAudioChunk(pcm16Mono16k: Buffer): void {
        if (!this.connected || pcm16Mono16k.length === 0) return;
        if (this.phase === 'processing') return; // turn already closed; drop stragglers

        if (this.phase === 'idle') {
            this.phase = 'listening';
            this.vad.reset();
        }

        try {
            const result = this.vad.feed(pcm16Mono16k);
            if (result.speechStart) {
                this.emit("speech", "local");
            }
            if (result.utterance) {
                this.phase = 'processing';
                this.emit("silence", "local");
                void this.runAudioTurn(result.utterance);
            } else if (result.timeout) {
                this.phase = 'idle';
                this.emit("silence", "local");
                this.emit("transcript.done", "");
            }
        } catch (e) {
            // Contract: sendAudioChunk must never throw into the ESP chunk handler.
            this.logger.error('sendAudioChunk failed', e);
        }
    }

    resetConversation(): void {
        this.messages = [];
    }

    /** One spoken turn: STT the utterance, then answer it with audio. */
    private async runAudioTurn(utterance: Buffer): Promise<void> {
        try {
            const started = Date.now();
            const raw = await this.stt.transcribe(utterance, this.options.languageCode);
            const transcript = isBlankOrHallucinatedTranscript(raw) ? '' : raw.trim();
            this.logger.info(`STT ${(Date.now() - started)}ms: "${transcript}"`);
            if (transcript) this.emit("input_transcript.delta", transcript);
            this.emit("transcript.done", transcript);

            if (!transcript) {
                this.phase = 'idle';
                return; // the device decides: retry, end session, …
            }

            await this.respond(transcript, 'audio');
        } catch (e: any) {
            this.logger.error('Local turn failed', e);
            this.emit("error", e instanceof Error ? e : new Error(String(e?.message ?? e)));
        } finally {
            this.phase = 'idle';
        }
    }

    /**
     * The LLM round-trip shared by every input path: append the user message,
     * loop Ollama tool calls through the ToolManager, stream the reply out as
     * transcript/text deltas — and, in audio mode, speak it sentence-by-sentence
     * through Piper while it streams.
     */
    private async respond(userText: string, mode: 'audio' | 'text'): Promise<void> {
        await this.instructionState.ensureLoaded(this.instructionParams());

        const abort = new AbortController();
        this.turnAbort = abort;

        // Neutral tool defs — each ILlmClient wraps them in its own wire format.
        const tools = this.toolManager.getToolDefinitions().map((d: any) => ({
            name: d.name, description: d.description, parameters: d.parameters,
        }));

        const speaker = mode === 'audio'
            ? new SentenceSpeaker(
                (sentence) => this.tts.synthesize(sentence, abort.signal),
                (pcm24k) => this.emit("audio.delta", pcm24k),
            )
            : null;

        const thinkFilter = new ThinkTagFilter();
        let fullReply = '';
        const onDelta = (rawDelta: string) => {
            const delta = thinkFilter.feed(rawDelta);
            if (!delta) return;
            fullReply += delta;
            this.emit(mode === 'audio' ? "transcript.delta" : "text.delta", delta);
            speaker?.feed(delta);
        };

        this.messages.push({ role: 'user', content: userText });

        try {
            for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
                const system: ChatMessage = { role: 'system', content: this.instructionState.text };
                const { content, toolCalls } = await this.llm.chat(
                    [system, ...this.messages],
                    tools,
                    onDelta,
                    abort.signal,
                );

                if (!toolCalls.length || round === MAX_TOOL_ROUNDS) {
                    this.messages.push({ role: 'assistant', content });
                    break;
                }

                this.messages.push({ role: 'assistant', content, toolCalls });
                for (const call of toolCalls) {
                    this.emit("tool.called", { callId: call.id, name: call.name, args: call.args });
                    const { output } = await this.toolManager.execute(call.name, call.args);
                    this.emit("tool.completed", { callId: call.id, name: call.name, result: output });
                    this.messages.push({
                        role: 'tool',
                        toolCallId: call.id,
                        toolName: call.name,
                        content: typeof output === 'string' ? output : JSON.stringify(output ?? {}),
                    });
                }
            }

            const tail = thinkFilter.flush();
            if (tail) {
                fullReply += tail;
                this.emit(mode === 'audio' ? "transcript.delta" : "text.delta", tail);
                speaker?.feed(tail);
            }

            if (speaker) {
                await speaker.finish(); // every sentence synthesized and emitted, in order
                this.emit("audio.done");
                this.emit("response.done");
            } else {
                this.emit("text.done", { text: fullReply, type: "local.text.done" });
            }
        } finally {
            if (this.turnAbort === abort) this.turnAbort = null;
        }
    }

    // --- text in / out ---------------------------------------------------------

    /** Text in -> spoken reply out (flow card "ask with audio reply"). */
    sendTextForAudioResponse(text: string): void {
        if (!this.connected) return;
        this.phase = 'processing';
        void this.respond(text, 'audio')
            .catch((e) => {
                this.logger.error('sendTextForAudioResponse failed', e);
                this.emit("error", e instanceof Error ? e : new Error(String(e)));
            })
            .finally(() => { this.phase = 'idle'; });
    }

    /** Text in -> text out (flow card "ask with text reply", emulator `ask`). */
    sendTextForTextResponse(question: string): void {
        void this.respond(question, 'text')
            .catch((e: any) => {
                this.logger.error('sendTextForTextResponse failed', e);
                // Match the Gemini provider: resolve the waiting device promise
                // with an error text instead of leaving it to time out.
                this.emit("text.done", { text: `Error: ${e?.message ?? e}` });
            });
    }

    /** Direct TTS -> FLAC (the seam's contract for speakText). */
    async textToSpeech(text: string): Promise<Buffer> {
        const { pcm, sampleRate } = await this.tts.synthesize(text);
        const pcm24k = resamplePcm16Mono(pcm, sampleRate, OUTPUT_SAMPLE_RATE);
        return pcmToFlacBuffer(pcm24k, { sampleRate: OUTPUT_SAMPLE_RATE, channels: 1, bitsPerSample: 16 });
    }

    // --- on-the-fly settings updates -------------------------------------------

    updateApiKey(_newApiKey: string): void {
        // No API key in the local pipeline.
    }

    updateVoice(newVoice: string): void {
        this.options.voice = newVoice;
        // Piper's voice is fixed server-side (no setVoice); Voxtral picks a
        // preset voice per request, so the setting flows through here.
        this.tts.setVoice?.(newVoice);
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
        this.toolManager.setStandardZone(newDeviceZone);
        await this.instructionState.reload(this.instructionParams());
    }

    async updateTimerSupport(supportsTimers: boolean): Promise<void> {
        if (this.options.supportsTimers === supportsTimers) return;
        this.options.supportsTimers = supportsTimers;
        await this.instructionState.reload(this.instructionParams());
    }
}
