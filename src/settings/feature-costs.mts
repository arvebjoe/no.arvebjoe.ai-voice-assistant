import { loadInstructionModule } from '../llm/agent-instructions.mjs';
import { PLAIN_TEXT_BLOCK } from '../llm/instruction-state.mjs';
import { getShoppingListInstructions } from '../llm/instructions/shopping-list-instructions.mjs';
import { getMusicInstructions } from '../llm/instructions/music-instructions.mjs';
import { ToolManager } from '../llm/tool-manager.mjs';

/**
 * Live per-feature context-cost computation for the settings page budget
 * panel (docs/settings-redesign.md). Costs are computed from the REAL
 * instruction modules (selected language) and the REAL tool definitions, so
 * the numbers track the code — nothing is hardcoded. Token counts are a
 * chars-per-token heuristic and always approximate (docs/cost-of-growth.md).
 */

/**
 * Characters per token by language. Latin scripts sit near English; Cyrillic
 * and Hangul carry fewer characters per token, so the same prompt costs more.
 * Tool definitions are JSON in English regardless of the language setting.
 */
const CHARS_PER_TOKEN: Record<string, number> = {
    en: 3.8, nl: 3.6, de: 3.6, fr: 3.6, it: 3.6, sv: 3.6, no: 3.6, es: 3.6, da: 3.6,
    pl: 3.3, ru: 2.6, ko: 2.2,
};
const TOOL_CHARS_PER_TOKEN = 3.8;

export interface FeatureCost {
    id: 'smart' | 'weather' | 'timers' | 'shopping' | 'music' | 'websearch';
    /** Approx. tokens of the feature's instruction block (0 = tools only). */
    instructions: number;
    /** Approx. tokens of the feature's tool definitions (JSON). */
    tools: number;
    /** instructions + tools. */
    total: number;
}

export interface FeatureCostReport {
    language: string;
    /** Divisor the page can use to price the live (unsaved) extra-instructions text. */
    charsPerToken: number;
    features: FeatureCost[];
}

/** The app services a measurement ToolManager needs (all handlers stay unexecuted). */
export interface FeatureCostServices {
    homey: any;
    deviceManager: any;
    geoHelper: any;
    weatherHelper: any;
}

function instructionTokens(chars: number, languageCode: string): number {
    const divisor = CHARS_PER_TOKEN[languageCode] ?? 3.6;
    return Math.max(0, Math.round(chars / divisor));
}

function toolTokens(chars: number): number {
    return Math.max(0, Math.round(chars / TOOL_CHARS_PER_TOKEN));
}

export async function computeFeatureCosts(
    services: FeatureCostServices,
    languageCode: string,
    languageName: string,
): Promise<FeatureCostReport> {
    // --- instruction blocks, from the real per-language modules -------------
    const mod = await loadInstructionModule(languageCode);
    // Base is measured without the user's extra instructions: the page prices
    // the (possibly unsaved) textarea live using charsPerToken instead.
    const baseText = mod.getDefaultInstructions(languageName, null, false);
    const withTimersText = mod.getDefaultInstructions(languageName, null, true);
    const timersInstrChars = Math.max(0, withTimersText.length - baseText.length);
    // The budget verdict applies to the local pipeline, which always appends
    // the plain-text-output block — count it as part of the base.
    const baseInstrChars = baseText.length + PLAIN_TEXT_BLOCK.length;
    const shoppingInstrChars = getShoppingListInstructions(languageCode).length;
    const musicInstrChars = getMusicInstructions(languageCode).length;

    // --- tool definitions, from a measurement ToolManager -------------------
    // Every optional feature is force-registered so its definitions can be
    // sized; no handler ever runs, so a missing TimerManager is fine.
    const tm = new ToolManager(
        services.homey, 'measurement', services.deviceManager,
        services.geoHelper, services.weatherHelper, undefined,
    );
    tm.registerAllToolsForMeasurement();

    const featureOfTool = new Map<string, string>();
    for (const [feature, names] of Object.entries(ToolManager.FEATURE_TOOLS)) {
        for (const name of names) featureOfTool.set(name, feature);
    }
    const toolChars: Record<string, number> = { smart: 0, weather: 0, timers: 0, shopping: 0, music: 0, websearch: 0 };
    for (const def of tm.getToolDefinitions()) {
        const feature = featureOfTool.get(def.name) ?? 'smart';
        toolChars[feature] += JSON.stringify(def).length;
    }

    const feature = (id: FeatureCost['id'], instrChars: number): FeatureCost => {
        const instructions = instructionTokens(instrChars, languageCode);
        const tools = toolTokens(toolChars[id]);
        return { id, instructions, tools, total: instructions + tools };
    };

    return {
        language: languageCode,
        charsPerToken: CHARS_PER_TOKEN[languageCode] ?? 3.6,
        features: [
            feature('smart', baseInstrChars),
            feature('weather', 0),
            feature('timers', timersInstrChars),
            feature('shopping', shoppingInstrChars),
            feature('music', musicInstrChars),
            feature('websearch', 0),
        ],
    };
}
