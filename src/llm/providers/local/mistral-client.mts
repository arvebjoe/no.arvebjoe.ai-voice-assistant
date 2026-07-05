import { createLogger } from '../../../helpers/logger.mjs';
import { ChatMessage, ChatToolCall, ILlmClient, LlmChatResult, LlmToolDef, sanitizeToolCallId } from './llm-client.mjs';

/**
 * ILlmClient for Mistral's chat-completions API (https://api.mistral.ai).
 *
 * Mistral has no unified realtime speech-to-speech API — their own docs
 * compose voice agents as STT -> LLM -> TTS — so it slots into the pipeline
 * as an alternative LLM stage next to Ollama. OpenAI-style wire format:
 * SSE streaming (`data: {...}` / `data: [DONE]`), tools as
 * { type:'function', function:{...} }, tool calls with string-encoded
 * arguments, and results keyed by tool_call_id (which Mistral validates as
 * EXACTLY 9 chars of [a-zA-Z0-9] — hence sanitizeToolCallId on the way out).
 */

export interface MistralConfig {
    apiKey: string;
    /** Model id (e.g. 'mistral-small-latest'). Empty = DEFAULT_MISTRAL_MODEL. */
    model: string;
}

export const DEFAULT_MISTRAL_MODEL = 'mistral-small-latest';
const MISTRAL_BASE_URL = 'https://api.mistral.ai';
const CHAT_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

export class MistralClient implements ILlmClient {
    private config: MistralConfig;
    private logger = createLogger('MISTRAL', true);

    constructor(config: MistralConfig) {
        this.config = { ...config };
    }

    configure(config: MistralConfig): void {
        this.config = { ...config };
    }

    private get model(): string {
        return this.config.model || DEFAULT_MISTRAL_MODEL;
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
        const res = await fetch(`${MISTRAL_BASE_URL}/v1/models`, {
            headers: { Authorization: `Bearer ${this.config.apiKey}` },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401) throw new Error('Mistral API key was rejected (401) — check it in the app settings');
        if (!res.ok) throw new Error(`Mistral /v1/models returned HTTP ${res.status}`);
    }

    /** Neutral seam message -> Mistral chat-completions wire format. */
    private toWire(m: ChatMessage): any {
        switch (m.role) {
            case 'assistant':
                return m.toolCalls?.length
                    ? {
                        role: 'assistant',
                        content: m.content,
                        tool_calls: m.toolCalls.map((c) => ({
                            id: sanitizeToolCallId(c.id),
                            type: 'function',
                            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
                        })),
                    }
                    : { role: 'assistant', content: m.content };
            case 'tool':
                return {
                    role: 'tool',
                    name: m.toolName,
                    tool_call_id: sanitizeToolCallId(m.toolCallId ?? ''),
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
        const res = await fetch(`${MISTRAL_BASE_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
                Authorization: `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!res.ok || !res.body) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Mistral /v1/chat/completions returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
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
            toolCalls.push({ id: sanitizeToolCallId(slot.id || slot.name), name: slot.name, args });
        }

        return { content, toolCalls };
    }
}
