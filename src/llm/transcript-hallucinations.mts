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

/**
 * True when a final transcript is an echo of the STT vocabulary prompt rather
 * than real speech. Prompt-primed transcribers (gpt-4o-transcribe) hallucinate
 * slices of their prompt on silence/noise, regurgitating the comma-joined
 * device list verbatim (e.g. "Bad 5%, Shelly Wall Display [192.168.0.45].").
 * The fingerprint: every comma-separated segment is exactly a vocabulary name
 * and the segments appear in prompt order — no real utterance reads like that.
 * Requires >= 2 segments so a legitimate lone device/room name ("Kontoret")
 * is never filtered.
 *
 * `vocabularyNames` must be the names actually sent in the prompt, in order.
 */
export function isVocabularyEchoTranscript(
    transcript: string | null | undefined,
    vocabularyNames: readonly string[],
): boolean {
    if (vocabularyNames.length === 0) return false;
    const t = (transcript ?? '').trim().replace(/[.!?]+$/u, '');
    if (t === '') return false;

    const segments = t.split(',').map(s => s.trim().toLowerCase()).filter(s => s !== '');
    if (segments.length < 2) return false;

    const indexByName = new Map<string, number>();
    vocabularyNames.forEach((name, i) => {
        const key = name.trim().toLowerCase();
        if (!indexByName.has(key)) indexByName.set(key, i);
    });

    let prev = -1;
    for (const segment of segments) {
        const idx = indexByName.get(segment);
        if (idx === undefined || idx <= prev) return false;
        prev = idx;
    }
    return true;
}
