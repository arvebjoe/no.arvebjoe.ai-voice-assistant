import { sanitizeToolCallId } from './llm-client.mjs';
import { OpenAiLlmClient } from './openai-llm-client.mjs';

/**
 * ILlmClient for Mistral's chat-completions API (https://api.mistral.ai).
 *
 * Mistral has no unified realtime speech-to-speech API — their own docs
 * compose voice agents as STT -> LLM -> TTS — so it slots into the pipeline
 * as an alternative LLM stage next to Ollama. Mistral speaks the OpenAI
 * chat-completions dialect, so this is a thin OpenAiLlmClient subclass that
 * pins the endpoint, defaults the model, requires the API key, and enforces
 * Mistral's strict tool_call_id format (EXACTLY 9 chars of [a-zA-Z0-9] —
 * hence sanitizeToolCallId on every id that goes out on the wire).
 */

export interface MistralConfig {
    apiKey: string;
    /** Model id (e.g. 'mistral-small-latest'). Empty = DEFAULT_MISTRAL_MODEL. */
    model: string;
}

export const DEFAULT_MISTRAL_MODEL = 'mistral-small-latest';
const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';
const PROBE_TIMEOUT_MS = 5_000;

export class MistralClient extends OpenAiLlmClient {
    constructor(config: MistralConfig) {
        super({ baseUrl: MISTRAL_BASE_URL, apiKey: config.apiKey, model: config.model });
    }

    configure(config: MistralConfig): void {
        super.configure({ baseUrl: MISTRAL_BASE_URL, apiKey: config.apiKey, model: config.model });
    }

    protected get model(): string {
        return this.config.model || DEFAULT_MISTRAL_MODEL;
    }

    protected normalizeToolCallId(id: string): string {
        return sanitizeToolCallId(id);
    }

    describe(): string {
        return `mistral=${this.model}`;
    }

    isConfigured(): boolean {
        return !!this.config.apiKey;
    }

    hasCredentials(): boolean {
        return !!this.config.apiKey;
    }

    /** Health probe that also validates the key (401 on a bad one). */
    async check(): Promise<void> {
        const res = await fetch(`${MISTRAL_BASE_URL}/models`, {
            headers: { Authorization: `Bearer ${this.config.apiKey}` },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401) throw new Error('Mistral API key was rejected (401) — check it in the app settings');
        if (!res.ok) throw new Error(`Mistral /v1/models returned HTTP ${res.status}`);
    }
}
