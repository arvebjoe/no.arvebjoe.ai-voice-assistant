import { createLogger } from '../../../helpers/logger.mjs';

/**
 * HTTP client for a local Ollama instance (desktop app or docker, port 11434).
 *
 * Uses the native /api/chat endpoint with streaming NDJSON and function-call
 * tools. When no model is configured the first locally installed model
 * (GET /api/tags) is used, so "install Ollama, pull one model" just works.
 */

export interface LocalLlmConfig {
    host: string;
    port: number;
    /** Model name (e.g. 'qwen3:8b'). Empty = auto-pick the first installed model. */
    model: string;
}

export interface OllamaMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: OllamaToolCall[];
    tool_name?: string;
}

export interface OllamaToolCall {
    function: { name: string; arguments: any };
}

export interface OllamaChatResult {
    content: string;
    toolCalls: OllamaToolCall[];
}

const CHAT_TIMEOUT_MS = 120_000; // first token can wait on a cold model load
const PROBE_TIMEOUT_MS = 3_000;

export class OllamaClient {
    private config: LocalLlmConfig;
    private resolvedModel: string | null = null;
    private logger = createLogger('OLLAMA', true);

    constructor(config: LocalLlmConfig) {
        this.config = { ...config };
    }

    configure(config: LocalLlmConfig): void {
        if (config.host !== this.config.host || config.port !== this.config.port || config.model !== this.config.model) {
            this.resolvedModel = null;
        }
        this.config = { ...config };
    }

    get baseUrl(): string {
        return `http://${this.config.host}:${this.config.port}`;
    }

    isConfigured(): boolean {
        return !!this.config.host && !!this.config.port;
    }

    /** Health probe: the server answers /api/version when it's up. */
    async check(): Promise<void> {
        const res = await fetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`Ollama /api/version returned HTTP ${res.status}`);
    }

    /** The configured model, or the first installed one (cached once resolved). */
    async resolveModel(): Promise<string> {
        if (this.config.model) return this.config.model;
        if (this.resolvedModel) return this.resolvedModel;

        const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`Ollama /api/tags returned HTTP ${res.status}`);
        const data: any = await res.json();
        const name = data?.models?.[0]?.name;
        if (!name) {
            throw new Error('Ollama has no models installed — pull one (e.g. `ollama pull qwen3`) or set a model name in the app settings');
        }
        this.logger.info(`No model configured — using first installed Ollama model '${name}'`);
        this.resolvedModel = name;
        return name;
    }

    /**
     * One /api/chat round, streamed. `onDelta` fires per content token; tool
     * calls are collected and returned with the final content. The tool-call
     * follow-up round (feeding results back) is the caller's loop.
     */
    async chat(
        messages: OllamaMessage[],
        tools: any[],
        onDelta?: (delta: string) => void,
        signal?: AbortSignal,
    ): Promise<OllamaChatResult> {
        const model = await this.resolveModel();
        const body: any = { model, messages, stream: true };
        if (tools.length) body.tools = tools;

        const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);
        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!res.ok || !res.body) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Ollama /api/chat returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }

        let content = '';
        const toolCalls: OllamaToolCall[] = [];
        let lineBuf = '';
        const decoder = new TextDecoder();

        const handleLine = (line: string) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            let msg: any;
            try {
                msg = JSON.parse(trimmed);
            } catch {
                return; // tolerate a torn line at stream end
            }
            if (msg?.error) throw new Error(`Ollama error: ${msg.error}`);
            const delta: string = msg?.message?.content ?? '';
            if (delta) {
                content += delta;
                onDelta?.(delta);
            }
            const calls = msg?.message?.tool_calls;
            if (Array.isArray(calls)) {
                for (const c of calls) {
                    if (c?.function?.name) toolCalls.push(c);
                }
            }
        };

        for await (const chunk of res.body as any) {
            lineBuf += decoder.decode(chunk, { stream: true });
            let nl: number;
            while ((nl = lineBuf.indexOf('\n')) >= 0) {
                handleLine(lineBuf.slice(0, nl));
                lineBuf = lineBuf.slice(nl + 1);
            }
        }
        handleLine(lineBuf);

        return { content, toolCalls };
    }
}
