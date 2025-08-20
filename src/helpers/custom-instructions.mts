// Example of how to customize agent instructions

import { getDefaultInstructions } from './agent-instructions.mjs';

/**
 * Example of customized instructions for specific use cases
 */
export function getCustomInstructions(): string {
    // You can build upon the default instructions
    const baseInstructions = getDefaultInstructions('English'); // Added required languageName parameter
    
    // Or create completely custom ones
    return `${baseInstructions}

SPESIELLE INSTRUKSJONER:
- Når brukeren spør om værmelding, forklar at du ikke har tilgang til værdata
- Ved sikkerhetsrelaterte spørsmål, vær ekstra forsiktig
- Hvis brukeren virker frustrert, vær ekstra tålmodig og hjelpsom

SMARTHUS-PREFERANSER:
- Foreslå energibesparende innstillinger når det er naturlig
- Gi beskjed hvis mange enheter slås på samtidig
- Husk å nevne hvis lysinnstillinger kan påvirke søvnkvalitet på kveldstid`;
}

/**
 * Instructions for debugging/development mode
 */
export function getDebugInstructions(): string {
    return `Du er en stemmeassistent i debug-modus.

- Vær mer utførlig i forklaringene
- Beskriv hvilke verktøy du bruker og hvorfor
- Gi tekniske detaljer når det er relevant
- Rapporter eventuelle feil eller uventede resultater

Snakk fortsatt norsk, men vær mer teknisk i språkbruken.`;
}

/**
 * Simple instructions for testing
 */
export function getTestInstructions(): string {
    return "Du er en test-assistent. Svar kort på norsk og bekreft alle kommandoer.";
}
