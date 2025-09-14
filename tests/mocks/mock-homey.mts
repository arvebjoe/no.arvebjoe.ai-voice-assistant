/**
 * Mock implementation of Homey class for testing purposes
 * Only implements the timer methods that route to default JavaScript functions
 * and basic settings functionality
 */
export class MockHomey {
    private mockSettings: Record<string, any> = {
        'selected_language_code': 'en',
        'selected_language_name': 'English',
        'selected_voice': 'alloy',
        'openai_api_key': 'test-key',
        'ai_instructions': ''
    };

    private settingsEventListeners: Record<string, Function[]> = {};

    // Settings mock
    settings = {
        get: (key: string) => {
            return this.mockSettings[key];
        },
        set: (key: string, value: any) => {
            this.mockSettings[key] = value;
            // Trigger 'set' event listeners
            const listeners = this.settingsEventListeners['set'] || [];
            listeners.forEach(listener => listener(key));
        },
        on: (event: string, listener: Function) => {
            if (!this.settingsEventListeners[event]) {
                this.settingsEventListeners[event] = [];
            }
            this.settingsEventListeners[event].push(listener);
        }
    };

    /**
     * Set a mock setting value (for testing)
     */
    setMockSetting(key: string, value: any): void {
        this.settings.set(key, value);
    }

    /**
     * Get all mock settings (for testing)
     */
    getMockSettings(): Record<string, any> {
        return { ...this.mockSettings };
    }
    /**
     * Alias to setTimeout that routes to the default JavaScript setTimeout
     * @param callback - Function to execute
     * @param ms - Delay in milliseconds
     * @param args - Additional arguments to pass to the callback
     * @returns NodeJS.Timeout object
     */
    setTimeout(callback: Function, ms: number, ...args: any[]): NodeJS.Timeout {
        return setTimeout(callback as (...args: any[]) => void, ms, ...args);
    }

    /**
     * Alias to clearTimeout that routes to the default JavaScript clearTimeout
     * @param timeoutId - The timeout ID to clear
     */
    clearTimeout(timeoutId: any): void {
        clearTimeout(timeoutId);
    }

    /**
     * Alias to setInterval that routes to the default JavaScript setInterval
     * @param callback - Function to execute repeatedly
     * @param ms - Interval in milliseconds
     * @param args - Additional arguments to pass to the callback
     * @returns NodeJS.Timeout object
     */
    setInterval(callback: Function, ms: number, ...args: any[]): NodeJS.Timeout {
        return setInterval(callback as (...args: any[]) => void, ms, ...args);
    }

    /**
     * Alias to clearInterval that routes to the default JavaScript clearInterval
     * @param timeoutId - The interval ID to clear
     */
    clearInterval(timeoutId: any): void {
        clearInterval(timeoutId);
    }
}
