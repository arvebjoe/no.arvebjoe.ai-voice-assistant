// Shared loader for the language-specific agent instruction modules
// (instructions/agent-instructions.<code>.mts). Used by every provider so the
// system prompt is identical regardless of which backend is active.

export interface InstructionModule {
    getDefaultInstructions(languageName: string, additionalInstructions?: string | null, supportsTimers?: boolean): string;
    getResponseInstructions?(): string;
    getErrorResponseInstructions?(): string;
}

/**
 * Dynamically load the instruction module for a language code (e.g. 'de' ->
 * instructions/agent-instructions.de.mjs), falling back to English if a
 * language-specific module is missing. Codes match the options in
 * settings/index.html.
 */
/**
 * Sanitize a language code destined for the dynamic import below (S6): only a
 * two-letter lowercase code may pass — a crafted settings value must not steer
 * the import specifier. Anything else resolves to 'en'.
 */
export function sanitizeInstructionLanguageCode(languageCode: string | null | undefined): string {
    const code = (languageCode || 'en').toLowerCase();
    return /^[a-z]{2}$/.test(code) ? code : 'en';
}

export async function loadInstructionModule(languageCode: string): Promise<InstructionModule> {
    const code = sanitizeInstructionLanguageCode(languageCode);
    try {
        return await import(`./instructions/agent-instructions.${code}.mjs`);
    } catch (error) {
        // Fallback to English if a language-specific file doesn't exist.
        return await import('./instructions/agent-instructions.en.mjs');
    }
}
