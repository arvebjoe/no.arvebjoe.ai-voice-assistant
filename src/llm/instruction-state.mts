import { loadInstructionModule, InstructionModule } from './agent-instructions.mjs';
import { getShoppingListInstructions } from './instructions/shopping-list-instructions.mjs';
import { getMusicInstructions } from './instructions/music-instructions.mjs';

/** The option fields the system prompt is built from. */
export type InstructionParams = {
    languageCode: string;
    languageName: string;
    additionalInstructions?: string | null;
    supportsTimers?: boolean;
    supportsShoppingList?: boolean;
    supportsMusic?: boolean;
    /**
     * The reply text is fed verbatim to a TTS engine (local pipeline / Mistral
     * chat) — chat LLMs decorate with markdown unless told not to, and it
     * pollutes transcripts and non-Voxtral TTS output. Speech-to-speech
     * providers don't need this.
     */
    plainTextOutput?: boolean;
};

// Exported so feature-costs can include it in the local-pipeline base cost.
export const PLAIN_TEXT_BLOCK = `

Output format
- Your reply is spoken aloud by a text-to-speech engine. Write plain conversational text only.
- Never use markdown or other formatting: no **bold**, bullet points, headers, backticks or emoji.`;

/**
 * Shared holder for the language-specific system prompt (Org 2).
 *
 * Both providers used to kick off a fire-and-forget instruction load in their
 * constructor and hope it finished before the session was configured — and each
 * carried its own copy of the load/rebuild logic. This class owns the async
 * load and exposes it as an awaitable, so a provider configures its session
 * with `await ensureLoaded(...)` instead of racing the constructor.
 *
 * Never rejects: a failed load logs and leaves the text empty, which
 * ensureLoaded() treats as "retry once before connecting".
 */
export class InstructionState {
    private instructionModule: InstructionModule | null = null;
    private instructionText = '';
    private inFlight: Promise<void> = Promise.resolve();

    constructor(
        private logger?: { error: (...args: any[]) => void },
        // Injectable for tests; defaults to the real dynamic-import loader.
        private loader: (languageCode: string) => Promise<InstructionModule> = loadInstructionModule,
    ) { }

    /** The current system prompt ('' until the first load completes). */
    get text(): string {
        return this.instructionText;
    }

    /** The loaded language module (for getErrorResponseInstructions etc.). */
    get module(): InstructionModule | null {
        return this.instructionModule;
    }

    /** Rebuild the prompt for the given params. Never rejects. */
    reload(params: InstructionParams): Promise<void> {
        this.inFlight = this.doReload(params);
        return this.inFlight;
    }

    private async doReload(params: InstructionParams): Promise<void> {
        try {
            this.instructionModule = await this.loader(params.languageCode);
            let text = this.instructionModule.getDefaultInstructions(
                params.languageName,
                params.additionalInstructions,
                params.supportsTimers,
            );
            // The Bring! shopping-list block lives in one shared file (not the
            // per-language modules) and is only added when the feature is on.
            if (params.supportsShoppingList) {
                text += getShoppingListInstructions(params.languageCode);
            }
            // Same for the Music Assistant block.
            if (params.supportsMusic) {
                text += getMusicInstructions(params.languageCode);
            }
            if (params.plainTextOutput) {
                text += PLAIN_TEXT_BLOCK;
            }
            this.instructionText = text;
        } catch (error) {
            this.logger?.error('Failed to load instruction module:', error);
            this.instructionText = '';
        }
    }

    /** Await any in-flight load (resolves immediately if none is running). */
    ready(): Promise<void> {
        return this.inFlight;
    }

    /**
     * Await the in-flight load and retry once if it produced nothing. This is
     * the pre-connect guard: a session must never be configured with an empty
     * prompt just because a transient load failure happened earlier.
     */
    async ensureLoaded(params: InstructionParams): Promise<void> {
        await this.inFlight;
        if (!this.instructionText) {
            await this.reload(params);
        }
    }

    /** Directly override the prompt text (the updateAllInstructions seam). */
    overrideText(text: string): void {
        this.instructionText = text;
    }
}
