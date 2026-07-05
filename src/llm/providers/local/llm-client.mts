/**
 * Backend-neutral LLM chat seam inside the local pipeline.
 *
 * The pipeline's LLM stage is pluggable (`local_llm_provider` global setting):
 * Ollama on the LAN or Mistral's cloud chat-completions API — and each speaks
 * a different wire format for tool calls (Ollama: arguments as objects, no
 * ids; Mistral/OpenAI-style: arguments as JSON strings keyed by tool_call_id).
 * The provider builds conversations in THESE neutral types; each client maps
 * them to its wire format on the way out and normalizes responses on the way
 * back in, so the tool loop in local-pipeline-provider.mts is backend-blind.
 */

export interface ChatToolCall {
    /** Backend call id (Mistral issues its own; Ollama calls get a generated one). */
    id: string;
    name: string;
    /** Parsed arguments object (never a JSON string at this seam). */
    args: any;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** Assistant messages only: the tool calls the model made that round. */
    toolCalls?: ChatToolCall[];
    /** Tool messages only: which call this result answers. */
    toolCallId?: string;
    toolName?: string;
}

/** Tool definition as ToolManager provides it ({ name, description, parameters }). */
export interface LlmToolDef {
    name: string;
    description: string;
    parameters: any;
}

export interface LlmChatResult {
    content: string;
    toolCalls: ChatToolCall[];
}

export interface ILlmClient {
    /** Enough settings present to even try (host set / API key set). */
    isConfigured(): boolean;
    /**
     * False only when the backend needs an API key and none is set — drives
     * the device's "missing API key" notification path (vs "not connected").
     */
    hasCredentials(): boolean;
    /** Health probe. Throws when the backend is unreachable/unauthorized. */
    check(): Promise<void>;
    /** Human-readable target for log lines (URL or model id). */
    describe(): string;
    /**
     * One chat round, streamed. `onDelta` fires per assistant content token;
     * tool calls are collected and returned alongside the final content. The
     * tool-call follow-up round (feeding results back) is the caller's loop.
     */
    chat(
        messages: ChatMessage[],
        tools: LlmToolDef[],
        onDelta?: (delta: string) => void,
        signal?: AbortSignal,
    ): Promise<LlmChatResult>;
}

/**
 * Generate a tool-call id that satisfies the strictest backend in play:
 * Mistral validates tool_call_id as EXACTLY 9 characters of [a-zA-Z0-9].
 * Used for Ollama-originated calls (no ids on the wire) so a conversation
 * can survive a mid-session backend switch without re-keying history.
 */
export function generateToolCallId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 9; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

/** Coerce any foreign id to Mistral's 9-char [a-zA-Z0-9] format, deterministically. */
export function sanitizeToolCallId(id: string): string {
    if (/^[a-zA-Z0-9]{9}$/.test(id)) return id;
    // Simple stable hash -> base36, padded/truncated to 9.
    let h1 = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
        h1 ^= id.charCodeAt(i);
        h1 = Math.imul(h1, 0x01000193) >>> 0;
    }
    return (h1.toString(36) + id.replace(/[^a-zA-Z0-9]/g, '') + '000000000').slice(0, 9);
}
