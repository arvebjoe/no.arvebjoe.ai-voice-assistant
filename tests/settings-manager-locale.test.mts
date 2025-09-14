import { describe, it, expect } from 'vitest';
import { SettingsManager } from '../src/settings/settings-manager.mjs';

describe('SettingsManager Locale Mapping', () => {
    describe('getLocaleFromLanguageCode', () => {
        it('should map language codes to correct BCP-47 locales', () => {
            expect(SettingsManager.getLocaleFromLanguageCode('en')).toBe('en-US');
            expect(SettingsManager.getLocaleFromLanguageCode('nl')).toBe('nl-NL');
            expect(SettingsManager.getLocaleFromLanguageCode('de')).toBe('de-DE');
            expect(SettingsManager.getLocaleFromLanguageCode('fr')).toBe('fr-FR');
            expect(SettingsManager.getLocaleFromLanguageCode('it')).toBe('it-IT');
            expect(SettingsManager.getLocaleFromLanguageCode('sv')).toBe('sv-SE');
            expect(SettingsManager.getLocaleFromLanguageCode('no')).toBe('nb-NO');
            expect(SettingsManager.getLocaleFromLanguageCode('es')).toBe('es-ES');
            expect(SettingsManager.getLocaleFromLanguageCode('da')).toBe('da-DK');
            expect(SettingsManager.getLocaleFromLanguageCode('ru')).toBe('ru-RU');
            expect(SettingsManager.getLocaleFromLanguageCode('pl')).toBe('pl-PL');
            expect(SettingsManager.getLocaleFromLanguageCode('ko')).toBe('ko-KR');
        });

        it('should default to en-US for unknown language codes', () => {
            expect(SettingsManager.getLocaleFromLanguageCode('unknown')).toBe('en-US');
            expect(SettingsManager.getLocaleFromLanguageCode('')).toBe('en-US');
            expect(SettingsManager.getLocaleFromLanguageCode('zh')).toBe('en-US');
        });
    });

    describe('getCurrentLocale', () => {
        it('should get current locale based on settings', () => {
            const settingsManager = SettingsManager.getInstance();
            
            // Since we can't easily mock the settings in a unit test,
            // we'll just test that it returns a valid locale format
            const locale = settingsManager.getCurrentLocale();
            
            // Should be in BCP-47 format (language-region)
            expect(locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
            
            // Should be one of our supported locales
            const supportedLocales = [
                'en-US', 'nl-NL', 'de-DE', 'fr-FR', 'it-IT', 
                'sv-SE', 'nb-NO', 'es-ES', 'da-DK', 'ru-RU', 
                'pl-PL', 'ko-KR'
            ];
            expect(supportedLocales).toContain(locale);
        });
    });
});