import { describe, it, expect, beforeEach, vi } from 'vitest';
import { settingsManager } from '../src/settings/settings-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

// settingsManager is a shared singleton, so reset()+init() per test (the same
// pattern used by tool-manager-local-time.test.mts).
describe('SettingsManager pub/sub', () => {
    let homey: MockHomey;

    beforeEach(() => {
        settingsManager.reset();
        homey = new MockHomey();
        settingsManager.init(homey as any);
    });

    it('primes globals from Homey on init', () => {
        expect(settingsManager.getGlobal('openai_api_key')).toBe('test-key');
        expect(settingsManager.getGlobal('selected_language_code')).toBe('en');
    });

    it('init is idempotent (a second init with a different homey is ignored)', () => {
        const other = new MockHomey();
        other.setMockSetting('openai_api_key', 'other-key');
        settingsManager.init(other as any);
        expect(settingsManager.getGlobal('openai_api_key')).toBe('test-key');
    });

    it('getGlobal returns the fallback for an unset key', () => {
        expect(settingsManager.getGlobal('does_not_exist', 'fallback')).toBe('fallback');
    });

    it('onGlobals fires immediately with an initial snapshot', () => {
        const sub = vi.fn();
        settingsManager.onGlobals(sub);
        expect(sub).toHaveBeenCalledTimes(1);
        expect(sub.mock.calls[0][0].openai_api_key).toBe('test-key');
    });

    it('notifies subscribers when a setting changes', () => {
        const sub = vi.fn();
        settingsManager.onGlobals(sub);
        sub.mockClear();

        homey.setMockSetting('selected_voice', 'verse');

        expect(sub).toHaveBeenCalledTimes(1);
        expect(sub.mock.calls[0][0].selected_voice).toBe('verse');
        expect(settingsManager.getGlobal('selected_voice')).toBe('verse');
    });

    it('stops notifying after unsubscribe', () => {
        const sub = vi.fn();
        const unsub = settingsManager.onGlobals(sub);
        sub.mockClear();

        unsub();
        homey.setMockSetting('selected_voice', 'aria');

        expect(sub).not.toHaveBeenCalled();
    });

    it('hands each subscriber an independent snapshot copy', () => {
        let captured: any;
        settingsManager.onGlobals((s) => { captured = s; });
        captured.openai_api_key = 'mutated';
        // Mutating the delivered snapshot must not corrupt manager state.
        expect(settingsManager.getGlobal('openai_api_key')).toBe('test-key');
    });

    it('refreshGlobals no-ops after reset (no homey)', () => {
        settingsManager.reset();
        expect(() => settingsManager.refreshGlobals()).not.toThrow();
        expect(settingsManager.getGlobal('openai_api_key', 'none')).toBe('none');
    });

    it('getCurrentLocale follows selected_language_code', () => {
        homey.setMockSetting('selected_language_code', 'no');
        expect(settingsManager.getCurrentLocale()).toBe('nb-NO');
    });
});
