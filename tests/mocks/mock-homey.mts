/**
 * Mock implementation of Homey class for testing purposes
 * Only implements the timer methods that route to default JavaScript functions
 */
export class MockHomey {
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
