/**
 * Known strings the STT engine hallucinates on silence/noise (Whisper-family
 * models emit subtitle credits and similar boilerplate when they hear nothing).
 * One shared list so the device and the providers filter identically — add new
 * entries here (lowercase) as other languages surface their own artifacts.
 */
const HALLUCINATED_TRANSCRIPTS = new Set<string>([
    'undertekster av ai-media', // Norwegian: subtitle credit emitted for silence
]);

/**
 * True when a final transcript should be treated as "the user said nothing":
 * empty/whitespace, or a known silence-hallucination string.
 */
export function isBlankOrHallucinatedTranscript(transcript: string | null | undefined): boolean {
    const t = (transcript ?? '').trim();
    return t === '' || HALLUCINATED_TRANSCRIPTS.has(t.toLowerCase());
}
