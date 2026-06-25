// Shared loader for the language-specific agent instruction modules
// (agent-instructions.{en,no}.mts). Used by every provider so the system prompt
// is identical regardless of which backend is active.

export interface InstructionModule {
    getDefaultInstructions(languageName: string, additionalInstructions?: string | null, supportsTimers?: boolean): string;
    getResponseInstructions?(): string;
    getErrorResponseInstructions?(): string;
}

/**
 * Dynamically load the instruction module for a language code, falling back to
 * English if a language-specific module is missing.
 */
export async function loadInstructionModule(languageCode: string): Promise<InstructionModule> {
    try {
        // Language-specific instructions (e.g. 'no' -> agent-instructions.no.mjs)
        if (languageCode === 'no') {
            return await import('./agent-instructions.no.mjs');
        }
        // Default to English instructions
        return await import('./agent-instructions.en.mjs');
    } catch (error) {
        // Fallback to English if a language-specific file doesn't exist
        return await import('./agent-instructions.en.mjs');
    }
}
