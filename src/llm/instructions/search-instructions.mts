// Spoken on the device while a slow web_search is still working. A real search
// (several sources, sometimes a deeper retry) routinely runs far longer than a
// smart-home command, and without this the satellite is simply silent for
// 20-40 s and looks dead. Mirrors getPlayAcknowledgement in music-instructions.
const SEARCH_ACK: Record<string, string> = {
    en: 'Let me look that up.',
    no: 'La meg sjekke det.',
    sv: 'Låt mig kolla upp det.',
    da: 'Lad mig lige tjekke det.',
    nl: 'Ik zoek het even op.',
    de: 'Ich schaue das kurz nach.',
    fr: 'Je vais chercher ça.',
    it: 'Faccio una ricerca.',
    es: 'Voy a buscarlo.',
    pl: 'Zaraz to sprawdzę.',
    ru: 'Сейчас поищу.',
    ko: '지금 찾아볼게요.',
};

/** "Let me look that up." in the given language, English fallback. */
export function getSearchAcknowledgement(languageCode: string | null | undefined): string {
    const code = (languageCode || 'en').toLowerCase();
    return SEARCH_ACK[code] ?? SEARCH_ACK.en;
}
