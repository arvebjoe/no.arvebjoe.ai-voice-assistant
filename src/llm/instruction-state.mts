import { loadInstructionModule, InstructionModule } from './agent-instructions.mjs';

/** The option fields the system prompt is built from. */
export type InstructionParams = {
    languageCode: string;
    languageName: string;
    additionalInstructions?: string | null;
    supportsTimers?: boolean;
};

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
            this.instructionText = this.instructionModule.getDefaultInstructions(
                params.languageName,
                params.additionalInstructions,
                params.supportsTimers,
            );
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
