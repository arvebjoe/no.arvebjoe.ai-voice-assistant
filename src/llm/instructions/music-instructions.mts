// Localized system-prompt block for the Music Assistant tools.
//
// Kept in one file (like the Bring! shopping-list block) so the feature can be
// added/removed in a single place. InstructionState appends the block returned
// here only when the Music Assistant integration is enabled — the tool names
// stay in English everywhere because they are the literal function identifiers
// the model must emit.

const MUSIC_BLOCK: Record<string, string> = {
    en: `

Music tools (exact names)
- play_music(query?, media_type?, uri?, mode?, radio_mode?, player?)
- search_music(query, media_type?)
- music_control(action, player?)  — action: pause | resume | stop | next | previous | shuffle_on | shuffle_off
- get_music_state(player?)

MUSIC (Music Assistant)
- Music plays on THIS speaker by default. Only set player when the user names another room or speaker.
- "Play Abbey Road by the Beatles" → play_music(query="Abbey Road", media_type="album"). Always pass media_type when the user implies one (song/album/artist/playlist/radio).
- "Play some Queen" → play_music(query="Queen", media_type="artist"). "Play music like X" → add radio_mode=true.
- The tool returns what actually started — confirm briefly, e.g. "Playing Abbey Road by The Beatles."
- On NO_MATCH tell the user nothing was found; on PLAYER_AMBIGUOUS ask which speaker to use (the message lists them).
- To browse or disambiguate first: search_music(...), then play_music(uri=<chosen uri>).
- "Pause", "skip", "next song", "stop the music" → music_control(action=...).
- "What's playing?" → get_music_state(), answer with track and artist.`,

    no: `

Musikkverktøy (eksakte navn)
- play_music(query?, media_type?, uri?, mode?, radio_mode?, player?)
- search_music(query, media_type?)
- music_control(action, player?)  — action: pause | resume | stop | next | previous | shuffle_on | shuffle_off
- get_music_state(player?)

MUSIKK (Music Assistant)
- Musikk spilles på DENNE høyttaleren som standard. Sett player kun når brukeren nevner et annet rom eller en annen høyttaler.
- "Spill Abbey Road av Beatles" → play_music(query="Abbey Road", media_type="album"). Send alltid media_type når brukeren antyder en (låt/album/artist/spilleliste/radio).
- "Spill litt Queen" → play_music(query="Queen", media_type="artist"). "Spill musikk som ligner X" → radio_mode=true.
- Verktøyet returnerer hva som faktisk startet — bekreft kort, f.eks. "Spiller Abbey Road av The Beatles."
- Ved NO_MATCH: si at ingenting ble funnet; ved PLAYER_AMBIGUOUS: spør hvilken høyttaler (meldingen lister dem opp).
- For å bla eller avklare først: search_music(...), deretter play_music(uri=<valgt uri>).
- "Pause", "neste", "hopp over", "stopp musikken" → music_control(action=...).
- "Hva spilles?" → get_music_state(), svar med låt og artist.`,

    sv: `

Musikverktyg (exakta namn)
- play_music(query?, media_type?, uri?, mode?, radio_mode?, player?)
- search_music(query, media_type?)
- music_control(action, player?)  — action: pause | resume | stop | next | previous | shuffle_on | shuffle_off
- get_music_state(player?)

MUSIK (Music Assistant)
- Musik spelas på DEN HÄR högtalaren som standard. Ange player endast när användaren nämner ett annat rum eller en annan högtalare.
- "Spela Abbey Road med Beatles" → play_music(query="Abbey Road", media_type="album"). Skicka alltid media_type när användaren antyder en (låt/album/artist/spellista/radio).
- "Spela lite Queen" → play_music(query="Queen", media_type="artist"). "Spela musik som liknar X" → radio_mode=true.
- Verktyget returnerar vad som faktiskt startade — bekräfta kort, t.ex. "Spelar Abbey Road med The Beatles."
- Vid NO_MATCH: säg att inget hittades; vid PLAYER_AMBIGUOUS: fråga vilken högtalare (meddelandet listar dem).
- För att bläddra eller reda ut först: search_music(...), sedan play_music(uri=<vald uri>).
- "Pausa", "nästa", "hoppa över", "stoppa musiken" → music_control(action=...).
- "Vad spelas?" → get_music_state(), svara med låt och artist.`,

    da: `

Musikværktøjer (præcise navne)
- play_music(query?, media_type?, uri?, mode?, radio_mode?, player?)
- search_music(query, media_type?)
- music_control(action, player?)  — action: pause | resume | stop | next | previous | shuffle_on | shuffle_off
- get_music_state(player?)

MUSIK (Music Assistant)
- Musik afspilles på DENNE højttaler som standard. Angiv kun player, når brugeren nævner et andet rum eller en anden højttaler.
- "Spil Abbey Road med Beatles" → play_music(query="Abbey Road", media_type="album"). Send altid media_type, når brugeren antyder en (sang/album/kunstner/playliste/radio).
- "Spil noget Queen" → play_music(query="Queen", media_type="artist"). "Spil musik der ligner X" → radio_mode=true.
- Værktøjet returnerer, hvad der faktisk startede — bekræft kort, f.eks. "Spiller Abbey Road med The Beatles."
- Ved NO_MATCH: sig at intet blev fundet; ved PLAYER_AMBIGUOUS: spørg hvilken højttaler (beskeden lister dem).
- For at browse eller afklare først: search_music(...), derefter play_music(uri=<valgt uri>).
- "Pause", "næste", "spring over", "stop musikken" → music_control(action=...).
- "Hvad spiller?" → get_music_state(), svar med nummer og kunstner.`,

    nl: `

Muziektools (exacte namen)
- play_music(query?, media_type?, uri?, mode?, radio_mode?, player?)
- search_music(query, media_type?)
- music_control(action, player?)  — action: pause | resume | stop | next | previous | shuffle_on | shuffle_off
- get_music_state(player?)

MUZIEK (Music Assistant)
- Muziek speelt standaard op DEZE speaker. Zet player alleen als de gebruiker een andere kamer of speaker noemt.
- "Speel Abbey Road van de Beatles" → play_music(query="Abbey Road", media_type="album"). Geef altijd media_type mee als de gebruiker er een impliceert (nummer/album/artiest/afspeellijst/radio).
- "Speel wat Queen" → play_music(query="Queen", media_type="artist"). "Speel muziek zoals X" → radio_mode=true.
- De tool geeft terug wat er echt gestart is — bevestig kort, bijv. "Abbey Road van The Beatles speelt nu."
- Bij NO_MATCH: zeg dat er niets gevonden is; bij PLAYER_AMBIGUOUS: vraag welke speaker (het bericht somt ze op).
- Om eerst te bladeren of te verduidelijken: search_music(...), daarna play_music(uri=<gekozen uri>).
- "Pauze", "volgende", "sla over", "stop de muziek" → music_control(action=...).
- "Wat speelt er?" → get_music_state(), antwoord met nummer en artiest.`,

    de: `

Musik-Tools (genaue Namen)
- play_music(query?, media_type?, uri?, mode?, radio_mode?, player?)
- search_music(query, media_type?)
- music_control(action, player?)  — action: pause | resume | stop | next | previous | shuffle_on | shuffle_off
- get_music_state(player?)

MUSIK (Music Assistant)
- Musik läuft standardmäßig auf DIESEM Lautsprecher. player nur setzen, wenn der Nutzer einen anderen Raum oder Lautsprecher nennt.
- "Spiel Abbey Road von den Beatles" → play_music(query="Abbey Road", media_type="album"). media_type immer mitgeben, wenn der Nutzer eines andeutet (Lied/Album/Künstler/Playlist/Radio).
- "Spiel etwas Queen" → play_music(query="Queen", media_type="artist"). "Spiel Musik wie X" → radio_mode=true.
- Das Tool liefert zurück, was tatsächlich gestartet ist — kurz bestätigen, z. B. "Spiele Abbey Road von The Beatles."
- Bei NO_MATCH sagen, dass nichts gefunden wurde; bei PLAYER_AMBIGUOUS fragen, welcher Lautsprecher (die Meldung listet sie auf).
- Zum Stöbern oder Klären zuerst: search_music(...), dann play_music(uri=<gewählte uri>).
- "Pause", "weiter", "nächstes Lied", "Musik aus" → music_control(action=...).
- "Was läuft gerade?" → get_music_state(), mit Titel und Künstler antworten.`,

    fr: `

Outils musique (noms exacts)
- play_music(query?, media_type?, uri?, mode?, radio_mode?, player?)
- search_music(query, media_type?)
- music_control(action, player?)  — action : pause | resume | stop | next | previous | shuffle_on | shuffle_off
- get_music_state(player?)

MUSIQUE (Music Assistant)
- La musique joue sur CE haut-parleur par défaut. Ne renseigne player que si l'utilisateur nomme une autre pièce ou un autre haut-parleur.
- "Joue Abbey Road des Beatles" → play_music(query="Abbey Road", media_type="album"). Passe toujours media_type quand l'utilisateur l'implique (chanson/album/artiste/playlist/radio).
- "Joue du Queen" → play_music(query="Queen", media_type="artist"). "Joue de la musique comme X" → radio_mode=true.
- L'outil renvoie ce qui a réellement démarré — confirme brièvement, par ex. "Je lance Abbey Road des Beatles."
- Si NO_MATCH : dis que rien n'a été trouvé ; si PLAYER_AMBIGUOUS : demande quel haut-parleur (le message les liste).
- Pour parcourir ou lever un doute d'abord : search_music(...), puis play_music(uri=<uri choisie>).
- "Pause", "suivant", "passe", "arrête la musique" → music_control(action=...).
- "Qu'est-ce qui joue ?" → get_music_state(), réponds avec le titre et l'artiste.`,

    it: `

Strumenti musica (nomi esatti)
- play_music(query?, media_type?, uri?, mode?, radio_mode?, player?)
- search_music(query, media_type?)
- music_control(action, player?)  — action: pause | resume | stop | next | previous | shuffle_on | shuffle_off
- get_music_state(player?)

MUSICA (Music Assistant)
- La musica suona su QUESTO altoparlante per impostazione predefinita. Imposta player solo se l'utente nomina un'altra stanza o un altro altoparlante.
- "Metti Abbey Road dei Beatles" → play_music(query="Abbey Road", media_type="album"). Passa sempre media_type quando l'utente lo implica (brano/album/artista/playlist/radio).
- "Metti un po' di Queen" → play_music(query="Queen", media_type="artist"). "Metti musica simile a X" → radio_mode=true.
- Lo strumento restituisce cosa è partito davvero — conferma brevemente, es. "Sto riproducendo Abbey Road dei Beatles."
- Con NO_MATCH di' che non è stato trovato nulla; con PLAYER_AMBIGUOUS chiedi quale altoparlante (il messaggio li elenca).
- Per sfogliare o chiarire prima: search_music(...), poi play_music(uri=<uri scelta>).
- "Pausa", "avanti", "salta", "ferma la musica" → music_control(action=...).
- "Cosa sta suonando?" → get_music_state(), rispondi con brano e artista.`,

    es: `

Herramientas de música (nombres exactos)
- play_music(query?, media_type?, uri?, mode?, radio_mode?, player?)
- search_music(query, media_type?)
- music_control(action, player?)  — action: pause | resume | stop | next | previous | shuffle_on | shuffle_off
- get_music_state(player?)

MÚSICA (Music Assistant)
- La música suena en ESTE altavoz por defecto. Indica player solo si el usuario nombra otra habitación u otro altavoz.
- "Pon Abbey Road de los Beatles" → play_music(query="Abbey Road", media_type="album"). Pasa siempre media_type cuando el usuario lo implique (canción/álbum/artista/lista/radio).
- "Pon algo de Queen" → play_music(query="Queen", media_type="artist"). "Pon música parecida a X" → radio_mode=true.
- La herramienta devuelve lo que realmente empezó — confirma brevemente, p. ej. "Reproduciendo Abbey Road de The Beatles."
- Con NO_MATCH di que no se encontró nada; con PLAYER_AMBIGUOUS pregunta qué altavoz (el mensaje los lista).
- Para explorar o aclarar primero: search_music(...), luego play_music(uri=<uri elegida>).
- "Pausa", "siguiente", "salta", "para la música" → music_control(action=...).
- "¿Qué está sonando?" → get_music_state(), responde con canción y artista.`,

    pl: `

Narzędzia muzyczne (dokładne nazwy)
- play_music(query?, media_type?, uri?, mode?, radio_mode?, player?)
- search_music(query, media_type?)
- music_control(action, player?)  — action: pause | resume | stop | next | previous | shuffle_on | shuffle_off
- get_music_state(player?)

MUZYKA (Music Assistant)
- Muzyka gra domyślnie na TYM głośniku. Ustaw player tylko wtedy, gdy użytkownik wskaże inny pokój lub głośnik.
- "Zagraj Abbey Road Beatlesów" → play_music(query="Abbey Road", media_type="album"). Zawsze przekazuj media_type, gdy użytkownik go sugeruje (utwór/album/artysta/playlista/radio).
- "Zagraj trochę Queen" → play_music(query="Queen", media_type="artist"). "Zagraj muzykę podobną do X" → radio_mode=true.
- Narzędzie zwraca, co faktycznie się rozpoczęło — potwierdź krótko, np. "Gram Abbey Road zespołu The Beatles."
- Przy NO_MATCH powiedz, że nic nie znaleziono; przy PLAYER_AMBIGUOUS zapytaj, który głośnik (komunikat je wymienia).
- Aby najpierw przejrzeć lub doprecyzować: search_music(...), potem play_music(uri=<wybrane uri>).
- "Pauza", "następny", "pomiń", "zatrzymaj muzykę" → music_control(action=...).
- "Co gra?" → get_music_state(), odpowiedz utworem i artystą.`,

    ru: `

Музыкальные инструменты (точные имена)
- play_music(query?, media_type?, uri?, mode?, radio_mode?, player?)
- search_music(query, media_type?)
- music_control(action, player?)  — action: pause | resume | stop | next | previous | shuffle_on | shuffle_off
- get_music_state(player?)

МУЗЫКА (Music Assistant)
- Музыка по умолчанию играет на ЭТОЙ колонке. Указывай player только если пользователь назвал другую комнату или колонку.
- «Включи Abbey Road группы Beatles» → play_music(query="Abbey Road", media_type="album"). Всегда передавай media_type, когда пользователь его подразумевает (песня/альбом/исполнитель/плейлист/радио).
- «Включи что-нибудь из Queen» → play_music(query="Queen", media_type="artist"). «Включи музыку похожую на X» → radio_mode=true.
- Инструмент возвращает, что именно заиграло — кратко подтверди, например «Включаю Abbey Road группы The Beatles.»
- При NO_MATCH скажи, что ничего не найдено; при PLAYER_AMBIGUOUS спроси, какую колонку использовать (в сообщении есть список).
- Чтобы сначала посмотреть варианты: search_music(...), затем play_music(uri=<выбранный uri>).
- «Пауза», «дальше», «пропусти», «выключи музыку» → music_control(action=...).
- «Что играет?» → get_music_state(), ответь названием трека и исполнителем.`,

    ko: `

음악 도구 (정확한 이름)
- play_music(query?, media_type?, uri?, mode?, radio_mode?, player?)
- search_music(query, media_type?)
- music_control(action, player?)  — action: pause | resume | stop | next | previous | shuffle_on | shuffle_off
- get_music_state(player?)

음악 (Music Assistant)
- 음악은 기본적으로 이 스피커에서 재생된다. 사용자가 다른 방이나 스피커를 말한 경우에만 player를 지정한다.
- "비틀즈의 Abbey Road 틀어줘" → play_music(query="Abbey Road", media_type="album"). 사용자가 종류를 암시하면(곡/앨범/아티스트/플레이리스트/라디오) 항상 media_type을 넣는다.
- "Queen 노래 틀어줘" → play_music(query="Queen", media_type="artist"). "X 같은 음악 틀어줘" → radio_mode=true.
- 도구는 실제로 재생된 항목을 반환한다 — 간단히 확인해 준다. 예: "The Beatles의 Abbey Road를 재생할게요."
- NO_MATCH면 찾지 못했다고 말하고, PLAYER_AMBIGUOUS면 어느 스피커인지 물어본다(메시지에 목록이 있음).
- 먼저 찾아보거나 확인하려면: search_music(...) 후 play_music(uri=<선택한 uri>).
- "일시정지", "다음 곡", "건너뛰어", "음악 꺼줘" → music_control(action=...).
- "지금 뭐 나와?" → get_music_state(), 곡명과 아티스트로 답한다.`,
};

/**
 * The Music Assistant system-prompt block for a language code, English fallback.
 */
export function getMusicInstructions(languageCode?: string | null): string {
    const code = (languageCode || 'en').toLowerCase();
    return MUSIC_BLOCK[code] ?? MUSIC_BLOCK.en;
}
