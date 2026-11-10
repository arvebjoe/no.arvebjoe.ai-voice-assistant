/**
 * Steering for OpenAI's generative direct-TTS model (gpt-4o-mini-tts). It
 * PREDICTS audio rather than reading text, so on short or exclamatory input it
 * sometimes adds words ("Hei din Bolle! Ja bolle"), laughter or breaths - and
 * with no language field on the API it guesses the language from the text, so
 * two Norwegian words ("Flink du!") come out with an English accent.
 *
 * Both are fixed by naming the language explicitly and asking for a verbatim
 * read. The wording stays in English on purpose: the model follows English
 * steering most reliably, and naming the target language is what fixes the
 * accent - not the language the instruction is written in.
 *
 * There is deliberately NO Gemini counterpart. Gemini 3.8 TTS treats its text
 * input as a strictly verbatim transcript: a steering preamble in the prompt
 * is spoken, word for word (tried Nov 2026 - a Flow played back these very
 * instructions). Google's way to direct delivery is a separate
 * `speech_metadata.style` annotation on the Interactions API, which the
 * generateContent call the provider uses does not carry; the model detects the
 * language from the text. So GeminiLiveProvider.textToSpeech() sends bare text.
 */

/** OpenAI `/v1/audio/speech` `instructions` (gpt-4o-*-tts family only). */
export function openAiTtsInstructions(languageName: string): string {
    const language = languageName.trim() || "English";
    return `Speak ${language}, with a native ${language} pronunciation. `
        + "Read the text exactly as written, word for word. "
        + "Do not add, repeat or leave out any words, and do not add laughter, sighs or other sounds. "
        + "Use a natural, friendly tone suitable for a smart home assistant.";
}
