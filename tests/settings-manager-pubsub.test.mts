import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { settingsManager } from '../src/settings/settings-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

// settingsManager is a shared singleton, so reset()+init() per test (the same
// pattern used by tool-manager-local-time.test.mts).
//
// Subscriber notification is debounced (code_review_2 H1: a settings-page Save
// writes ~20 keys and must land as ONE emit), so tests use fake timers and
// advance past the debounce window to observe notifications.
describe('SettingsManager pub/sub', () => {
    let homey: MockHomey;

    const flushDebounce = () => vi.advanceTimersByTime(1_600);

    beforeEach(() => {
        vi.useFakeTimers();
        settingsManager.reset();
        homey = new MockHomey();
        settingsManager.init(homey as any);
    });

    afterEach(() => {
        vi.useRealTimers();
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

    it('notifies subscribers when a setting changes (after the debounce)', () => {
        const sub = vi.fn();
        settingsManager.onGlobals(sub);
        sub.mockClear();

        homey.setMockSetting('selected_voice', 'verse');

        // getGlobal sees the new value immediately, before any emit
        expect(settingsManager.getGlobal('selected_voice')).toBe('verse');
        expect(sub).not.toHaveBeenCalled();

        flushDebounce();

        expect(sub).toHaveBeenCalledTimes(1);
        expect(sub.mock.calls[0][0].selected_voice).toBe('verse');
    });

    it('H1 — a burst of key writes coalesces into ONE emit with the final snapshot', () => {
        const sub = vi.fn();
        settingsManager.onGlobals(sub);
        sub.mockClear();

        // Simulate a settings-page Save: many keys written back-to-back
        homey.setMockSetting('openai_api_key', 'new-key');
        homey.setMockSetting('selected_voice', 'verse');
        homey.setMockSetting('selected_language_code', 'no');
        homey.setMockSetting('weather_enabled', false);
        homey.setMockSetting('voice_provider', 'local');

        expect(sub).not.toHaveBeenCalled();
        flushDebounce();

        expect(sub).toHaveBeenCalledTimes(1);
        const snapshot = sub.mock.calls[0][0];
        expect(snapshot.openai_api_key).toBe('new-key');
        expect(snapshot.selected_voice).toBe('verse');
        expect(snapshot.selected_language_code).toBe('no');
        expect(snapshot.weather_enabled).toBe(false);
        expect(snapshot.voice_provider).toBe('local');
    });

    it('a write during the debounce window restarts it and still lands in the emit', () => {
        const sub = vi.fn();
        settingsManager.onGlobals(sub);
        sub.mockClear();

        homey.setMockSetting('selected_voice', 'verse');
        vi.advanceTimersByTime(1_000); // inside the window
        homey.setMockSetting('selected_voice', 'aria');
        vi.advanceTimersByTime(1_000); // window restarted — still nothing
        expect(sub).not.toHaveBeenCalled();

        flushDebounce();
        expect(sub).toHaveBeenCalledTimes(1);
        expect(sub.mock.calls[0][0].selected_voice).toBe('aria');
    });

    it('stops notifying after unsubscribe', () => {
        const sub = vi.fn();
        const unsub = settingsManager.onGlobals(sub);
        sub.mockClear();

        unsub();
        homey.setMockSetting('selected_voice', 'aria');
        flushDebounce();

        expect(sub).not.toHaveBeenCalled();
    });

    it('reset cancels a pending emit', () => {
        const sub = vi.fn();
        settingsManager.onGlobals(sub);
        sub.mockClear();

        homey.setMockSetting('selected_voice', 'verse');
        settingsManager.reset();
        flushDebounce();

        expect(sub).not.toHaveBeenCalled();
    });

    it('M7 — a throwing subscriber does not block the others', () => {
        const bad = vi.fn(() => { throw new Error('device mid-rebuild'); });
        const good = vi.fn();
        // The initial-snapshot call is guarded too: subscribing must not throw.
        expect(() => settingsManager.onGlobals(bad)).not.toThrow();
        settingsManager.onGlobals(good);
        bad.mockClear();
        good.mockClear();

        expect(() => homey.setMockSetting('selected_voice', 'verse')).not.toThrow();
        expect(() => flushDebounce()).not.toThrow();

        expect(bad).toHaveBeenCalledTimes(1);
        expect(good).toHaveBeenCalledTimes(1);
        expect(good.mock.calls[0][0].selected_voice).toBe('verse');
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
