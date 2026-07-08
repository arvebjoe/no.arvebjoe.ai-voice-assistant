import { describe, it, expect, vi } from 'vitest';
import { InstructionState } from '../src/llm/instruction-state.mjs';
import type { InstructionModule } from '../src/llm/agent-instructions.mjs';

const params = {
    languageCode: 'en',
    languageName: 'English',
    additionalInstructions: 'extra',
    supportsTimers: true,
};

/** A loader whose module echoes its inputs, so tests can assert the wiring. */
function echoLoader() {
    const module: InstructionModule = {
        getDefaultInstructions: (languageName, additionalInstructions, supportsTimers) =>
            `prompt:${languageName}:${additionalInstructions}:${supportsTimers}`,
        getErrorResponseInstructions: () => 'explain the error',
    };
    return { module, loader: vi.fn(async (_code: string) => module) };
}

describe('InstructionState', () => {
    it('reload() builds the prompt from the params and exposes the module', async () => {
        const { module, loader } = echoLoader();
        const state = new InstructionState(undefined, loader);

        await state.reload(params);
        expect(loader).toHaveBeenCalledWith('en');
        expect(state.text).toBe('prompt:English:extra:true');
        expect(state.module).toBe(module);
        expect(state.module?.getErrorResponseInstructions?.()).toBe('explain the error');
    });

    it('ready() awaits an in-flight load (the constructor-race fix)', async () => {
        const { module } = echoLoader();
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const state = new InstructionState(undefined, async () => { await gate; return module; });

        void state.reload(params); // fire-and-forget, like the provider constructors
        expect(state.text).toBe(''); // not loaded yet

        const ready = state.ready();
        release();
        await ready;
        expect(state.text).toBe('prompt:English:extra:true');
    });

    it('a failing load never rejects, logs, and leaves the text empty', async () => {
        const logger = { error: vi.fn() };
        const state = new InstructionState(logger, async () => { throw new Error('import failed'); });

        await expect(state.reload(params)).resolves.toBeUndefined();
        await expect(state.ready()).resolves.toBeUndefined();
        expect(state.text).toBe('');
        expect(logger.error).toHaveBeenCalled();
    });

    it('ensureLoaded() retries once after a failed load, and is a no-op once loaded', async () => {
        const { module } = echoLoader();
        let calls = 0;
        const flakyLoader = vi.fn(async () => {
            calls++;
            if (calls === 1) throw new Error('transient');
            return module;
        });
        const state = new InstructionState(undefined, flakyLoader);

        void state.reload(params); // constructor kick: fails
        await state.ensureLoaded(params); // pre-connect guard: retries
        expect(state.text).toBe('prompt:English:extra:true');
        expect(flakyLoader).toHaveBeenCalledTimes(2);

        await state.ensureLoaded(params); // already loaded -> no extra load
        expect(flakyLoader).toHaveBeenCalledTimes(2);
    });

    it('appends the Bring! shopping-list block only when supportsShoppingList is set', async () => {
        const { loader } = echoLoader();

        const off = new InstructionState(undefined, loader);
        await off.reload({ ...params, supportsShoppingList: false });
        expect(off.text).not.toMatch(/get_shopping_list/);

        const on = new InstructionState(undefined, loader);
        await on.reload({ ...params, supportsShoppingList: true });
        expect(on.text).toMatch(/get_shopping_list/);
        expect(on.text).toMatch(/ITEM_ALREADY_EXISTS/);
    });

    it('overrideText() replaces the prompt directly (updateAllInstructions seam)', async () => {
        const { loader } = echoLoader();
        const state = new InstructionState(undefined, loader);
        await state.reload(params);

        state.overrideText('manual prompt');
        expect(state.text).toBe('manual prompt');
    });

    it('defaults to the real loader and falls back to English for an unknown language code', async () => {
        const state = new InstructionState();
        await state.reload({ ...params, languageCode: 'zz' });
        expect(state.text.length).toBeGreaterThan(0);
        expect(state.module).not.toBeNull();
    });
});
