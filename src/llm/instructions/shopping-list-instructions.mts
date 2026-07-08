// Localized system-prompt block for the Bring! shopping-list tools.
//
// Kept in one file (rather than duplicated into every agent-instructions.<lang>
// file like the timer block) so the feature can be added/removed in a single
// place. InstructionState appends the block returned here only when the Bring!
// integration is enabled — the tool names stay in English everywhere because
// they are the literal function identifiers the model must emit.

const SHOPPING_LIST_BLOCK: Record<string, string> = {
    en: `

Shopping list tools (exact names)
- get_shopping_list()
- add_to_shopping_list(item, specification?)
- update_shopping_list_item(item, specification)
- remove_from_shopping_list(item)

SHOPPING LIST (Bring!)
- "What's on the shopping list?" → get_shopping_list(), then read the items briefly.
- "Add milk" → add_to_shopping_list(item="milk"). Put an amount in specification (e.g. "2" or "2 liters") only when the user says one.
- If add_to_shopping_list returns code ITEM_ALREADY_EXISTS, the item is already on the list (its current amount is in existing.specification). Do NOT add it again silently: tell the user it is already there and ask whether to increase the amount or leave it.
  • Increase the amount → update_shopping_list_item(item, specification=<the new amount>).
  • Leave it → do nothing.
- "Remove bread" → remove_from_shopping_list(item="bread").
- Confirm briefly, e.g. "Added milk to the shopping list."`,

    no: `

Handleliste-verktøy (eksakte navn)
- get_shopping_list()
- add_to_shopping_list(item, specification?)
- update_shopping_list_item(item, specification)
- remove_from_shopping_list(item)

HANDLELISTE (Bring!)
- "Hva står på handlelista?" → get_shopping_list(), les så opp varene kort.
- "Legg til melk" → add_to_shopping_list(item="melk"). Legg en mengde i specification (f.eks. "2" eller "2 liter") kun når brukeren oppgir en.
- Hvis add_to_shopping_list returnerer koden ITEM_ALREADY_EXISTS, ligger varen allerede på lista (nåværende mengde står i existing.specification). Ikke legg den til på nytt uten videre: si at den allerede er der og spør om mengden skal økes eller stå som den er.
  • Øke mengden → update_shopping_list_item(item, specification=<ny mengde>).
  • La den stå → ikke gjør noe.
- "Fjern brød" → remove_from_shopping_list(item="brød").
- Bekreft kort, f.eks. "La til melk på handlelista."`,

    sv: `

Inköpslistverktyg (exakta namn)
- get_shopping_list()
- add_to_shopping_list(item, specification?)
- update_shopping_list_item(item, specification)
- remove_from_shopping_list(item)

INKÖPSLISTA (Bring!)
- "Vad står på inköpslistan?" → get_shopping_list(), läs sedan upp varorna kort.
- "Lägg till mjölk" → add_to_shopping_list(item="mjölk"). Lägg en mängd i specification (t.ex. "2" eller "2 liter") endast när användaren anger en.
- Om add_to_shopping_list returnerar koden ITEM_ALREADY_EXISTS finns varan redan på listan (nuvarande mängd finns i existing.specification). Lägg inte till den igen utan vidare: säg att den redan finns och fråga om mängden ska ökas eller stå kvar.
  • Öka mängden → update_shopping_list_item(item, specification=<ny mängd>).
  • Låt stå → gör ingenting.
- "Ta bort bröd" → remove_from_shopping_list(item="bröd").
- Bekräfta kort, t.ex. "Lade till mjölk på inköpslistan."`,

    da: `

Indkøbslisteværktøjer (præcise navne)
- get_shopping_list()
- add_to_shopping_list(item, specification?)
- update_shopping_list_item(item, specification)
- remove_from_shopping_list(item)

INDKØBSLISTE (Bring!)
- "Hvad står der på indkøbslisten?" → get_shopping_list(), læs derefter varerne kort op.
- "Tilføj mælk" → add_to_shopping_list(item="mælk"). Læg en mængde i specification (f.eks. "2" eller "2 liter") kun når brugeren nævner en.
- Hvis add_to_shopping_list returnerer koden ITEM_ALREADY_EXISTS, er varen allerede på listen (den nuværende mængde står i existing.specification). Tilføj den ikke igen uden videre: sig at den allerede er der, og spørg om mængden skal øges eller blive som den er.
  • Øg mængden → update_shopping_list_item(item, specification=<ny mængde>).
  • Lad den stå → gør ingenting.
- "Fjern brød" → remove_from_shopping_list(item="brød").
- Bekræft kort, f.eks. "Tilføjede mælk til indkøbslisten."`,

    nl: `

Boodschappenlijst-tools (exacte namen)
- get_shopping_list()
- add_to_shopping_list(item, specification?)
- update_shopping_list_item(item, specification)
- remove_from_shopping_list(item)

BOODSCHAPPENLIJST (Bring!)
- "Wat staat er op de boodschappenlijst?" → get_shopping_list(), lees daarna de items kort voor.
- "Voeg melk toe" → add_to_shopping_list(item="melk"). Zet een hoeveelheid in specification (bijv. "2" of "2 liter") alleen als de gebruiker die noemt.
- Als add_to_shopping_list de code ITEM_ALREADY_EXISTS teruggeeft, staat het item al op de lijst (de huidige hoeveelheid staat in existing.specification). Voeg het niet zomaar opnieuw toe: zeg dat het er al op staat en vraag of de hoeveelheid verhoogd moet worden of zo moet blijven.
  • Hoeveelheid verhogen → update_shopping_list_item(item, specification=<de nieuwe hoeveelheid>).
  • Laten staan → doe niets.
- "Verwijder brood" → remove_from_shopping_list(item="brood").
- Bevestig kort, bijv. "Melk toegevoegd aan de boodschappenlijst."`,

    de: `

Einkaufslisten-Tools (genaue Namen)
- get_shopping_list()
- add_to_shopping_list(item, specification?)
- update_shopping_list_item(item, specification)
- remove_from_shopping_list(item)

EINKAUFSLISTE (Bring!)
- "Was steht auf der Einkaufsliste?" → get_shopping_list(), dann die Artikel kurz vorlesen.
- "Milch hinzufügen" → add_to_shopping_list(item="Milch"). Eine Menge nur dann in specification eintragen (z. B. "2" oder "2 Liter"), wenn der Nutzer eine nennt.
- Wenn add_to_shopping_list den Code ITEM_ALREADY_EXISTS zurückgibt, steht der Artikel bereits auf der Liste (die aktuelle Menge steht in existing.specification). Nicht einfach erneut hinzufügen: sagen, dass er schon vorhanden ist, und fragen, ob die Menge erhöht werden oder so bleiben soll.
  • Menge erhöhen → update_shopping_list_item(item, specification=<die neue Menge>).
  • So lassen → nichts tun.
- "Brot entfernen" → remove_from_shopping_list(item="Brot").
- Kurz bestätigen, z. B. "Milch zur Einkaufsliste hinzugefügt."`,

    fr: `

Outils de liste de courses (noms exacts)
- get_shopping_list()
- add_to_shopping_list(item, specification?)
- update_shopping_list_item(item, specification)
- remove_from_shopping_list(item)

LISTE DE COURSES (Bring!)
- "Qu'y a-t-il sur la liste de courses ?" → get_shopping_list(), puis énonce brièvement les articles.
- "Ajoute du lait" → add_to_shopping_list(item="lait"). Mets une quantité dans specification (par ex. "2" ou "2 litres") uniquement si l'utilisateur en indique une.
- Si add_to_shopping_list renvoie le code ITEM_ALREADY_EXISTS, l'article est déjà sur la liste (sa quantité actuelle est dans existing.specification). Ne l'ajoute pas de nouveau en silence : dis qu'il y est déjà et demande s'il faut augmenter la quantité ou la laisser.
  • Augmenter la quantité → update_shopping_list_item(item, specification=<la nouvelle quantité>).
  • Laisser tel quel → ne rien faire.
- "Enlève le pain" → remove_from_shopping_list(item="pain").
- Confirme brièvement, par ex. "J'ai ajouté du lait à la liste de courses."`,

    it: `

Strumenti lista della spesa (nomi esatti)
- get_shopping_list()
- add_to_shopping_list(item, specification?)
- update_shopping_list_item(item, specification)
- remove_from_shopping_list(item)

LISTA DELLA SPESA (Bring!)
- "Cosa c'è nella lista della spesa?" → get_shopping_list(), poi elenca brevemente gli articoli.
- "Aggiungi il latte" → add_to_shopping_list(item="latte"). Metti una quantità in specification (es. "2" o "2 litri") solo se l'utente ne indica una.
- Se add_to_shopping_list restituisce il codice ITEM_ALREADY_EXISTS, l'articolo è già nella lista (la quantità attuale è in existing.specification). Non aggiungerlo di nuovo in silenzio: di' che c'è già e chiedi se aumentare la quantità o lasciarla com'è.
  • Aumentare la quantità → update_shopping_list_item(item, specification=<la nuova quantità>).
  • Lasciarlo → non fare nulla.
- "Togli il pane" → remove_from_shopping_list(item="pane").
- Conferma brevemente, es. "Ho aggiunto il latte alla lista della spesa."`,

    es: `

Herramientas de lista de la compra (nombres exactos)
- get_shopping_list()
- add_to_shopping_list(item, specification?)
- update_shopping_list_item(item, specification)
- remove_from_shopping_list(item)

LISTA DE LA COMPRA (Bring!)
- "¿Qué hay en la lista de la compra?" → get_shopping_list(), luego enumera brevemente los artículos.
- "Añade leche" → add_to_shopping_list(item="leche"). Pon una cantidad en specification (p. ej. "2" o "2 litros") solo si el usuario la indica.
- Si add_to_shopping_list devuelve el código ITEM_ALREADY_EXISTS, el artículo ya está en la lista (su cantidad actual está en existing.specification). No lo añadas de nuevo sin más: di que ya está y pregunta si aumentar la cantidad o dejarla igual.
  • Aumentar la cantidad → update_shopping_list_item(item, specification=<la nueva cantidad>).
  • Dejarlo → no hagas nada.
- "Quita el pan" → remove_from_shopping_list(item="pan").
- Confirma brevemente, p. ej. "Añadí leche a la lista de la compra."`,

    pl: `

Narzędzia listy zakupów (dokładne nazwy)
- get_shopping_list()
- add_to_shopping_list(item, specification?)
- update_shopping_list_item(item, specification)
- remove_from_shopping_list(item)

LISTA ZAKUPÓW (Bring!)
- "Co jest na liście zakupów?" → get_shopping_list(), a następnie krótko wymień pozycje.
- "Dodaj mleko" → add_to_shopping_list(item="mleko"). Wpisz ilość w specification (np. "2" lub "2 litry") tylko wtedy, gdy użytkownik ją poda.
- Jeśli add_to_shopping_list zwróci kod ITEM_ALREADY_EXISTS, pozycja jest już na liście (aktualna ilość jest w existing.specification). Nie dodawaj jej ponownie po cichu: powiedz, że już tam jest, i zapytaj, czy zwiększyć ilość, czy zostawić.
  • Zwiększyć ilość → update_shopping_list_item(item, specification=<nowa ilość>).
  • Zostawić → nic nie rób.
- "Usuń chleb" → remove_from_shopping_list(item="chleb").
- Potwierdź krótko, np. "Dodałem mleko do listy zakupów."`,

    ru: `

Инструменты списка покупок (точные имена)
- get_shopping_list()
- add_to_shopping_list(item, specification?)
- update_shopping_list_item(item, specification)
- remove_from_shopping_list(item)

СПИСОК ПОКУПОК (Bring!)
- «Что в списке покупок?» → get_shopping_list(), затем кратко перечисли товары.
- «Добавь молоко» → add_to_shopping_list(item="молоко"). Указывай количество в specification (например «2» или «2 литра») только если пользователь его назвал.
- Если add_to_shopping_list вернул код ITEM_ALREADY_EXISTS, товар уже в списке (текущее количество — в existing.specification). Не добавляй его повторно молча: скажи, что он уже есть, и спроси, увеличить количество или оставить как есть.
  • Увеличить количество → update_shopping_list_item(item, specification=<новое количество>).
  • Оставить → ничего не делай.
- «Убери хлеб» → remove_from_shopping_list(item="хлеб").
- Подтверди кратко, например «Добавил молоко в список покупок.»`,

    ko: `

장보기 목록 도구 (정확한 이름)
- get_shopping_list()
- add_to_shopping_list(item, specification?)
- update_shopping_list_item(item, specification)
- remove_from_shopping_list(item)

장보기 목록 (Bring!)
- "장보기 목록에 뭐가 있어?" → get_shopping_list()를 호출한 뒤 항목을 간단히 말한다.
- "우유 추가해" → add_to_shopping_list(item="우유"). 사용자가 수량을 말한 경우에만 specification에 수량(예: "2" 또는 "2리터")을 넣는다.
- add_to_shopping_list가 ITEM_ALREADY_EXISTS 코드를 반환하면 그 항목은 이미 목록에 있다(현재 수량은 existing.specification에 있음). 조용히 다시 추가하지 말고, 이미 있다고 알린 뒤 수량을 늘릴지 그대로 둘지 물어본다.
  • 수량 늘리기 → update_shopping_list_item(item, specification=<새 수량>).
  • 그대로 두기 → 아무것도 하지 않는다.
- "빵 빼줘" → remove_from_shopping_list(item="빵").
- 간단히 확인한다, 예: "우유를 장보기 목록에 추가했어요."`,
};

/**
 * The shopping-list system-prompt block for a language code, English fallback.
 */
export function getShoppingListInstructions(languageCode?: string | null): string {
    const code = (languageCode || 'en').toLowerCase();
    return SHOPPING_LIST_BLOCK[code] ?? SHOPPING_LIST_BLOCK.en;
}
