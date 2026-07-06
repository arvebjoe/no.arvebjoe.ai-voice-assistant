import { ChatMessage, LlmChatResult, LlmToolDef } from './llm-client.mjs';
import { OpenAiLlmClient } from './openai-llm-client.mjs';

/**
 * ILlmClient for LM Studio's local server (desktop app, default port 1234).
 *
 * LM Studio speaks the OpenAI chat-completions dialect, so this is a thin
 * OpenAiLlmClient subclass tuned for the desktop-app experience — simple
 * host/port settings instead of a base URL, no API key, and the model is
 * OPTIONAL: left empty, the first model from GET /v1/models is used (the
 * loaded/downloaded model), mirroring what the Ollama client does. The
 * resolved pick is cached until the settings change.
 */

export interface LmStudioConfig {
    host: string;
    port: number;
    /** Model id (as shown in LM Studio). Empty = auto-pick the first available model. */
    model: string;
}

const PROBE_TIMEOUT_MS = 5_000;

export class LmStudioClient extends OpenAiLlmClient {
    private resolvedModel: string | null = null;

    constructor(config: LmStudioConfig) {
        // The provider rebuilds clients on settings changes (no reconfigure
        // path), so mapping host/port to a base URL here is enough.
        super({ baseUrl: `${config.host}:${config.port}`, apiKey: '', model: config.model });
    }

    /** Configured model wins; else whatever resolveModel() picked. */
    protected get model(): string {
        return this.config.model || this.resolvedModel || '';
    }

    describe(): string {
        return `lmstudio=${this.model || 'auto'}@${this.baseUrl}`;
    }

    /** Only the host is required — the model can be auto-picked. */
    isConfigured(): boolean {
        return !!this.config.baseUrl;
    }

    /**
     * The configured model, or the first one LM Studio offers (cached once
     * resolved). Public and named like OllamaClient.resolveModel so the
     * provider's start() health flow invokes it automatically.
     */
    async resolveModel(): Promise<string> {
        if (this.config.model) return this.config.model;
        if (this.resolvedModel) return this.resolvedModel;

        const res = await fetch(`${this.baseUrl}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`LM Studio /v1/models returned HTTP ${res.status}`);
        const data: any = await res.json();
        const id = data?.data?.[0]?.id;
        if (!id) {
            throw new Error('LM Studio has no models available — load one in the LM Studio app or set a model name in the settings');
        }
        this.logger.info(`No model configured — using first available LM Studio model '${id}'`);
        this.resolvedModel = id;
        return id;
    }

    async chat(
        messages: ChatMessage[],
        tools: LlmToolDef[],
        onDelta?: (delta: string) => void,
        signal?: AbortSignal,
    ): Promise<LlmChatResult> {
        await this.resolveModel(); // ensure this.model is non-empty on the wire
        return super.chat(messages, tools, onDelta, signal);
    }
}
