import { describe, it, expect } from 'vitest';
import { isBlankOrHallucinatedTranscript, isVocabularyEchoTranscript } from '../src/llm/transcript-hallucinations.mjs';

describe('isBlankOrHallucinatedTranscript', () => {
    it('treats empty/whitespace/null as blank', () => {
        expect(isBlankOrHallucinatedTranscript('')).toBe(true);
        expect(isBlankOrHallucinatedTranscript('   ')).toBe(true);
        expect(isBlankOrHallucinatedTranscript(null)).toBe(true);
        expect(isBlankOrHallucinatedTranscript(undefined)).toBe(true);
    });

    it('matches known silence-hallucination strings case-insensitively', () => {
        expect(isBlankOrHallucinatedTranscript('Undertekster av Ai-Media')).toBe(true);
    });

    it('passes real speech through', () => {
        expect(isBlankOrHallucinatedTranscript('Slå på lyset')).toBe(false);
    });
});

describe('isVocabularyEchoTranscript', () => {
    // Prompt order matters: echoes regurgitate the comma-joined list verbatim.
    const VOCAB = [
        'Bad 5%',
        'Shelly Wall Display [192.168.0.45]',
        'Taklampe stue',
        'Kontoret',
        'Kjøkken',
    ];

    it('detects the observed real-world echo (two adjacent names + trailing period)', () => {
        expect(isVocabularyEchoTranscript('Bad 5%, Shelly Wall Display [192.168.0.45].', VOCAB)).toBe(true);
    });

    it('detects longer runs and is case-insensitive', () => {
        expect(isVocabularyEchoTranscript('bad 5%, shelly wall display [192.168.0.45], taklampe stue', VOCAB)).toBe(true);
    });

    it('detects non-adjacent names as long as they are in prompt order', () => {
        expect(isVocabularyEchoTranscript('Bad 5%, Kontoret.', VOCAB)).toBe(true);
    });

    it('never filters a single name — could be a legitimate answer', () => {
        expect(isVocabularyEchoTranscript('Kontoret', VOCAB)).toBe(false);
        expect(isVocabularyEchoTranscript('Bad 5%.', VOCAB)).toBe(false);
    });

    it('passes real commands that mention device names', () => {
        expect(isVocabularyEchoTranscript('Slå på Taklampe stue', VOCAB)).toBe(false);
        expect(isVocabularyEchoTranscript('Slå på Taklampe stue, og dimm Kjøkken', VOCAB)).toBe(false);
    });

    it('rejects names out of prompt order', () => {
        expect(isVocabularyEchoTranscript('Kjøkken, Bad 5%', VOCAB)).toBe(false);
    });

    it('rejects segments that are not vocabulary names', () => {
        expect(isVocabularyEchoTranscript('Bad 5%, noe helt annet', VOCAB)).toBe(false);
    });

    it('rejects a repeated name (indices must strictly increase)', () => {
        expect(isVocabularyEchoTranscript('Bad 5%, Bad 5%', VOCAB)).toBe(false);
    });

    it('is inert with an empty vocabulary or blank transcript', () => {
        expect(isVocabularyEchoTranscript('Bad 5%, Kjøkken', [])).toBe(false);
        expect(isVocabularyEchoTranscript('', VOCAB)).toBe(false);
        expect(isVocabularyEchoTranscript(null, VOCAB)).toBe(false);
        expect(isVocabularyEchoTranscript(undefined, VOCAB)).toBe(false);
    });
});
