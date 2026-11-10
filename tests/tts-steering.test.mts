import { describe, it, expect } from 'vitest';
import { openAiTtsInstructions } from '../src/llm/providers/tts-steering.mjs';

describe('tts-steering', () => {
    it('OpenAI instructions name the language and forbid ad-libs', () => {
        const s = openAiTtsInstructions('Norwegian');
        expect(s).toMatch(/Speak Norwegian/);
        expect(s).toMatch(/word for word/);
        expect(s).toMatch(/laughter/);
    });

    it('falls back to English for a blank language name', () => {
        expect(openAiTtsInstructions('  ')).toMatch(/Speak English/);
    });
});
