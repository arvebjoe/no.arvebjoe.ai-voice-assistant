import { createLogger } from '../../../helpers/logger.mjs';
import { ChatMessage, ChatToolCall, ILlmClient, LlmChatResult, LlmToolDef, generateToolCallId } from './llm-client.mjs';
import { normalizeOpenAiBaseUrl, openAiAuthHeaders, checkOpenAiCompatServer } from './openai-compat.mjs';

/**
 * ILlmClient for any OpenAI-compatible chat-completions server.
 *
 * This is the generic backend: point it at OpenAI itself, Groq
 * (https://api.groq.com/openai/v1), OpenRouter, DeepSeek, or a LAN server
 * (LM Studio localhost:1234, llama.cpp, vLLM, LocalAI, Ollama's /v1 shim).
 * Wire format: SSE streaming (`data: {...}` / `data: [DONE]`), tools as
 * { type:'function', function:{...} }, tool calls with string-encoded
 * arguments keyed by tool_call_id. The API key is OPTIONAL — most LAN
 * servers need none.
 *
 * MistralClient subclasses this (Mistral speaks the same dialect but pins
 * the endpoint, defaults the model, and enforces its 9-char tool-call ids).
 */

export interface OpenAiLlmConfig {
    /** Server base URL, e.g. 'https://api.groq.com/openai/v1' or '192.168.1.50:1234'. */
    baseUrl: string;
    /** Optional — LAN servers usually need none. */
    apiKey: string;
    /** Model id — required by (almost) every server. */
    model: string;
}

const CHAT_TIMEOUT_MS = 120_000; // first token can wait on a cold local model
const PROBE_TIMEOUT_MS = 5_000;

export class OpenAiLlmClient implements ILlmClient {
    protected config: OpenAiLlmConfig;
    protected logger = createLogger('OPENAI_LLM', true);

    constructor(config: OpenAiLlmConfig) {
        this.config = { ...config };
    }

    configure(config: OpenAiLlmConfig): void {
        this.config = { ...config };
    }

    protected get baseUrl(): string {
        return normalizeOpenAiBaseUrl(this.config.baseUrl);
    }

    /** The model id sent on the wire. Subclasses may supply a default. */
    protected get model(): string {
        return this.config.model;
    }

    /** Hook: coerce tool-call ids to what this server accepts (Mistral: 9 chars). */
    protected normalizeToolCallId(id: string): string {
        return id;
    }

    describe(): string {
        return `openai-llm=${this.model || '?'}@${this.baseUrl}`;
    }

    isConfigured(): boolean {
        return !!this.config.baseUrl && !!this.model;
    }

    /** The key is optional here — a keyed server rejecting us surfaces via check(). */
    hasCredentials(): boolean {
        return true;
    }

    async check(): Promise<void> {
        await checkOpenAiCompatServer(this.baseUrl, this.config.apiKey, PROBE_TIMEOUT_MS);
    }

    /** Neutral seam message -> chat-completions wire format. */
    protected toWire(m: ChatMessage): any {
        switch (m.role) {
            case 'assistant':
                return m.toolCalls?.length
                    ? {
                        role: 'assistant',
                        content: m.content,
                        tool_calls: m.toolCalls.map((c) => ({
                            id: this.normalizeToolCallId(c.id),
                            type: 'function',
                            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
                        })),
                    }
                    : { role: 'assistant', content: m.content };
            case 'tool':
                return {
                    role: 'tool',
                    name: m.toolName,
                    tool_call_id: this.normalizeToolCallId(m.toolCallId ?? ''),
                    content: m.content,
                };
            default:
                return { role: m.role, content: m.content };
        }
    }

    async chat(
        messages: ChatMessage[],
        tools: LlmToolDef[],
        onDelta?: (delta: string) => void,
        signal?: AbortSignal,
    ): Promise<LlmChatResult> {
        const body: any = {
            model: this.model,
            messages: messages.map((m) => this.toWire(m)),
            stream: true,
        };
        if (tools.length) {
            body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
            body.tool_choice = 'auto';
        }

        const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
                ...openAiAuthHeaders(this.config.apiKey),
            },
            body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!res.ok || !res.body) {
            const detail = await res.text().catch(() => '');
            throw new Error(`${this.baseUrl}/chat/completions returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }

        let content = '';
        // Streaming tool calls arrive fragmented by index: id/name in the first
        // chunk, argument JSON possibly split across several. Accumulate, then
        // parse the argument strings once the stream ends.
        const pending = new Map<number, { id: string; name: string; args: string }>();
        let lineBuf = '';
        const decoder = new TextDecoder();

        const handleLine = (line: string) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) return; // SSE comments/blank lines
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') return;
            let msg: any;
            try {
                msg = JSON.parse(payload);
            } catch {
                return; // tolerate a torn event at stream end
            }
            const delta = msg?.choices?.[0]?.delta;
            if (!delta) return;
            if (typeof delta.content === 'string' && delta.content) {
                content += delta.content;
                onDelta?.(delta.content);
            }
            if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                    const index = tc?.index ?? 0;
                    const slot = pending.get(index) ?? { id: '', name: '', args: '' };
                    if (tc?.id) slot.id = tc.id;
                    if (tc?.function?.name) slot.name += tc.function.name;
                    if (tc?.function?.arguments) slot.args += tc.function.arguments;
                    pending.set(index, slot);
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

        const toolCalls: ChatToolCall[] = [];
        for (const [, slot] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
            if (!slot.name) continue;
            let args: any = {};
            try {
                args = slot.args ? JSON.parse(slot.args) : {};
            } catch (e) {
                this.logger.error(`Un-parseable tool arguments for ${slot.name}: ${slot.args}`);
            }
            toolCalls.push({ id: this.normalizeToolCallId(slot.id || generateToolCallId()), name: slot.name, args });
        }

        return { content, toolCalls };
    }
}
