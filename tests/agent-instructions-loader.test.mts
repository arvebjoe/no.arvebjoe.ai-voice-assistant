import { describe, it, expect } from 'vitest';
import { loadInstructionModule, sanitizeInstructionLanguageCode } from '../src/llm/agent-instructions.mjs';
import * as en from '../src/llm/instructions/agent-instructions.en.mjs';

// S6 — the language code is interpolated into a dynamic import specifier, so
// only /^[a-z]{2}$/ may pass; anything else must resolve to 'en' before ever
// reaching the import interpolation.
//
// NOTE: under vitest the template-literal import can't resolve the .mjs->.mts
// source mapping, so loadInstructionModule always lands on the English fallback
// here regardless of code — the positive per-language load is exercised by the
// compiled app, not this harness. The sanitizer (the security boundary) is
// therefore tested directly; the loader tests assert the observable fallback.
describe('sanitizeInstructionLanguageCode (S6 whitelist)', () => {
    it('passes valid two-letter codes through, lowercased', () => {
        expect(sanitizeInstructionLanguageCode('no')).toBe('no');
        expect(sanitizeInstructionLanguageCode('NO')).toBe('no');
        expect(sanitizeInstructionLanguageCode('de')).toBe('de');
    });

    it('rejects path-traversal and other non-two-letter codes', () => {
        for (const evil of ['../../evil', 'en/../no', 'e', 'eng', 'e1', 'en.mjs?x=', '..', './', '  ']) {
            expect(sanitizeInstructionLanguageCode(evil), `code: ${JSON.stringify(evil)}`).toBe('en');
        }
    });

    it('defaults to en for empty/null/undefined', () => {
        expect(sanitizeInstructionLanguageCode('')).toBe('en');
        expect(sanitizeInstructionLanguageCode(null)).toBe('en');
        expect(sanitizeInstructionLanguageCode(undefined)).toBe('en');
    });
});

describe('loadInstructionModule', () => {
    it('returns a working English module for a rejected code (no throw, no path reach)', async () => {
        const mod = await loadInstructionModule('../../evil');
        expect(mod.getDefaultInstructions('X', null, false))
            .toBe(en.getDefaultInstructions('X', null, false));
    });

    it('returns a working module for a valid code', async () => {
        const mod = await loadInstructionModule('no');
        expect(typeof mod.getDefaultInstructions('X', null, false)).toBe('string');
    });
});
