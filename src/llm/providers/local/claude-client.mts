import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../../helpers/logger.mjs';
import { ChatMessage, ChatToolCall, ILlmClient, LlmChatResult, LlmToolDef } from './llm-client.mjs';

/**
 * ILlmClient for Anthropic's Claude (Messages API, https://api.anthropic.com).
 *
 * Like Mistral, Claude has no speech-to-speech realtime API, so it slots into
 * the custom pipeline as the LLM stage: STT -> Claude -> TTS. Unlike every
 * other cloud backend here it does NOT speak the OpenAI chat-completions
 * dialect, so this is a standalone client on the official SDK
 * (@anthropic-ai/sdk) rather than an OpenAiLlmClient subclass:
 *
 *  - system prompts are a top-level `system` parameter, not a message role;
 *  - tool calls are `tool_use` content blocks with parsed object inputs
 *    (no JSON-string arguments to re-parse) and results go back as
 *    `tool_result` blocks inside a USER message, several per message when the
 *    model called several tools in one round;
 *  - tools are `{ name, description, input_schema }`.
 *
 * The mapping from the neutral seam lives in `toAnthropicMessages()` below so
 * the pipeline's tool loop stays backend-blind.
 */

export interface ClaudeConfig {
    apiKey: string;
    /** Model id (e.g. 'claude-haiku-4-5'). Empty = DEFAULT_CLAUDE_MODEL. */
    model: string;
}

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

// A cap, not a target: spoken replies are a couple of sentences, but on models
// with adaptive thinking the reasoning tokens count against this too, so a
// tight cap would truncate the answer mid-thought. 8k leaves ample room while
// still bounding a runaway reply that would otherwise be read out loud.
const MAX_TOKENS = 8192;
const CHAT_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Models that accept `output_config.effort`. Anything else (Sonnet 4.5,
 * Haiku 4.5 and older) rejects the field with a 400, and the model id is a
 * free-text setting — so the request only carries it for the families that
 * support it, matched by prefix so dated snapshots (…-20260101) still count.
 */
const EFFORT_CAPABLE_MODELS = [
    'claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5',
    'claude-sonnet-4-6', 'claude-sonnet-5',
    'claude-fable-5', 'claude-mythos-5',
];

function supportsEffort(model: string): boolean {
    return EFFORT_CAPABLE_MODELS.some((m) => model.startsWith(m));
}

/**
 * Neutral seam conversation -> Anthropic request shape.
 *
 * Four rules the Messages API enforces and the seam doesn't:
 *  1. `system` is a top-level parameter — system messages are hoisted out.
 *  2. The first message must be `user`; history trimmed to a fixed message
 *     count can start on an assistant reply, so leading ones are dropped.
 *  3. Tool results are `tool_result` blocks in a user message, and the
 *     consecutive per-call tool messages the pipeline emits for one round
 *     belong in a SINGLE message (one per tool_use of that round).
 *  4. Content blocks may not be empty — an assistant turn that only called
 *     tools carries no text block at all.
 */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: Anthropic.MessageParam[] } {
    const systemParts: string[] = [];
    const out: Anthropic.MessageParam[] = [];

    for (const m of messages) {
        if (m.role === 'system') {
            if (m.content) systemParts.push(m.content);
            continue;
        }

        if (m.role === 'tool') {
            const block: Anthropic.ToolResultBlockParam = {
                type: 'tool_result',
                tool_use_id: m.toolCallId ?? '',
                content: m.content || '(no output)',
            };
            // Fold into the tool-result message of the same round when there is
            // one; a user text message never has array content, so this only
            // ever merges results with results.
            const last = out[out.length - 1];
            if (last?.role === 'user' && Array.isArray(last.content)) {
                last.content.push(block);
            } else {
                out.push({ role: 'user', content: [block] });
            }
            continue;
        }

        if (m.role === 'assistant') {
            const blocks: Anthropic.ContentBlockParam[] = [];
            if (m.content) blocks.push({ type: 'text', text: m.content });
            for (const call of m.toolCalls ?? []) {
                blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
            }
            if (!blocks.length) continue; // said nothing, called nothing
            out.push({ role: 'assistant', content: blocks });
            continue;
        }

        if (!m.content) continue;
        out.push({ role: 'user', content: m.content });
    }

    while (out.length && out[0].role !== 'user') out.shift();

    return { system: systemParts.join('\n\n'), messages: out };
}

/** One entry of the model dropdown in settings. */
export interface ClaudeModelOption {
    value: string;
    name: string;
}

// The model list is small and changes rarely, but the settings page asks for
// it on every keystroke-settled edit of the key — cache per key, like the
// Voxtral voice library does.
const MODELS_CACHE_TTL_MS = 5 * 60_000;
const modelsCache = new Map<string, { at: number; models: ClaudeModelOption[] }>();
// Safety stop for the auto-paginating iterator; Anthropic lists ~20 models.
const MAX_MODELS = 200;

/**
 * The models this key can use, newest first (GET /v1/models, auto-paginated).
 * Throws on a bad key / unreachable API — `claudeModelOptions()` is the
 * never-throwing wrapper the settings page uses.
 */
export async function listClaudeModels(apiKey: string): Promise<ClaudeModelOption[]> {
    const cached = modelsCache.get(apiKey);
    if (cached && Date.now() - cached.at < MODELS_CACHE_TTL_MS) return cached.models;

    const client = new Anthropic({ apiKey, maxRetries: 1 });
    const models: ClaudeModelOption[] = [];
    try {
        for await (const model of client.models.list({ limit: 100 }, { timeout: PROBE_TIMEOUT_MS })) {
            models.push({ value: model.id, name: model.display_name || model.id });
            if (models.length >= MAX_MODELS) break;
        }
    } catch (err) {
        throw describeClaudeError(err);
    }

    modelsCache.set(apiKey, { at: Date.now(), models });
    return models;
}

/**
 * The model dropdown's options. Never throws and never comes back empty: the
 * first entry is always the "" sentinel that means DEFAULT_CLAUDE_MODEL, so a
 * missing or rejected key still leaves the user something valid to save.
 */
export async function claudeModelOptions(apiKey: string): Promise<{ options: ClaudeModelOption[]; message: string }> {
    const key = (apiKey ?? '').trim();
    const fallback = { value: '', name: `Default (${DEFAULT_CLAUDE_MODEL})` };
    if (!key) {
        return { options: [fallback], message: 'Enter your Anthropic API key above to list the models your account can use.' };
    }
    try {
        const models = await listClaudeModels(key);
        if (!models.length) return { options: [fallback], message: 'This key has access to no models.' };
        return { options: [fallback, ...models], message: '' };
    } catch (err: any) {
        return { options: [fallback], message: String(err?.message ?? err) };
    }
}

/** Turn the SDK's typed errors into something a settings page can show. */
function describeClaudeError(err: unknown, model?: string): Error {
    if (err instanceof Anthropic.AuthenticationError) {
        return new Error('Claude API key was rejected (401) — check it in the app settings');
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
        return new Error('Claude rejected the request (403) — the key has no access to this model');
    }
    if (err instanceof Anthropic.NotFoundError) {
        return new Error(`Claude does not know the model '${model ?? ''}' (404) — check the model id`);
    }
    if (err instanceof Anthropic.RateLimitError) {
        return new Error('Claude rate limit reached (429) — try again in a moment');
    }
    if (err instanceof Anthropic.APIError) {
        return new Error(`Claude API error ${err.status ?? ''}: ${err.message}`.trim());
    }
    return err instanceof Error ? err : new Error(String(err));
}

export class ClaudeClient implements ILlmClient {
    private config: ClaudeConfig;
    private sdk: Anthropic | null = null;
    private logger = createLogger('CLAUDE', true);

    constructor(config: ClaudeConfig) {
        this.config = { ...config };
    }

    configure(config: ClaudeConfig): void {
        if (config.apiKey !== this.config.apiKey) this.sdk = null;
        this.config = { ...config };
    }

    private get model(): string {
        return this.config.model || DEFAULT_CLAUDE_MODEL;
    }

    /** Built lazily so a keyless install never constructs a doomed client. */
    private get client(): Anthropic {
        if (!this.config.apiKey) throw new Error('Claude API key is not set');
        if (!this.sdk) this.sdk = new Anthropic({ apiKey: this.config.apiKey, maxRetries: 1 });
        return this.sdk;
    }

    describe(): string {
        return `claude=${this.model}`;
    }

    isConfigured(): boolean {
        return !!this.config.apiKey;
    }

    hasCredentials(): boolean {
        return !!this.config.apiKey;
    }

    /** Health probe that also validates the key (401 on a bad one). */
    async check(): Promise<void> {
        try {
            await this.client.models.list({ limit: 1 }, { timeout: PROBE_TIMEOUT_MS });
        } catch (err) {
            throw this.describeError(err);
        }
    }

    async chat(
        messages: ChatMessage[],
        tools: LlmToolDef[],
        onDelta?: (delta: string) => void,
        signal?: AbortSignal,
    ): Promise<LlmChatResult> {
        const { system, messages: wire } = toAnthropicMessages(messages);
        if (!wire.length) throw new Error('Nothing to send to Claude — the conversation is empty');

        const params: Anthropic.MessageStreamParams = {
            model: this.model,
            max_tokens: MAX_TOKENS,
            messages: wire,
        };
        if (system) params.system = system;
        if (tools.length) {
            params.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
        }
        // Spoken answers want the terse, few-tool-calls end of the scale, and
        // on models where thinking is on by default this keeps it brief rather
        // than switching it off (disabled thinking makes Claude Opus 5 write
        // tool calls into its visible text — which would be read out loud).
        if (supportsEffort(this.model)) params.output_config = { effort: 'low' };

        let content = '';
        let final: Anthropic.Message;
        try {
            const stream = this.client.messages.stream(params, { signal, timeout: CHAT_TIMEOUT_MS });
            for await (const event of stream) {
                if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                    content += event.delta.text;
                    onDelta?.(event.delta.text);
                }
            }
            // The SDK accumulates the streamed blocks, so tool inputs arrive as
            // parsed objects — no re-assembling fragmented argument JSON.
            final = await stream.finalMessage();
        } catch (err) {
            throw this.describeError(err);
        }

        if (final.stop_reason === 'refusal') {
            const category = final.stop_details?.category;
            throw new Error(`Claude declined to answer${category ? ` (${category})` : ''}`);
        }
        if (final.stop_reason === 'max_tokens') {
            this.logger.warn(`Reply hit the ${MAX_TOKENS}-token cap and was cut short`);
        }

        const toolCalls: ChatToolCall[] = [];
        for (const block of final.content) {
            if (block.type === 'tool_use') {
                toolCalls.push({ id: block.id, name: block.name, args: (block.input ?? {}) as any });
            }
        }

        return { content, toolCalls };
    }

    private describeError(err: unknown): Error {
        return describeClaudeError(err, this.model);
    }
}
