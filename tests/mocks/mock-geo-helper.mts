import { createLogger } from '../../src/helpers/logger.mjs';

/**
 * Mock implementation of GeoHelper for testing purposes
 * Provides predictable, controllable behavior for unit tests
 */
export class MockGeoHelper {
    private logger = createLogger('MockGeoHelper', false);
    private _latitude: number | null = null;
    private _longitude: number | null = null;
    private _timezone: string | null = null;
    private isInitialized = false;
    
    // Flags to control mock behavior
    public shouldFailInit = false;
    public shouldFailUpdateLocation = false;
    public shouldFailUpdateTimezone = false;
    public shouldFailRefresh = false;
    public initCallCount = 0;
    public updateLocationCallCount = 0;
    public updateTimezoneCallCount = 0;
    public refreshLocationCallCount = 0;
    public refreshTimezoneCallCount = 0;

    // Event simulation
    public locationChangeCallbacks: (() => void)[] = [];
    public timezoneChangeCallbacks: (() => void)[] = [];

    constructor(homey?: any) {
        // Set default mock data
        this.setupDefaultData();
    }

    /**
     * Set up default test data
     */
    private setupDefaultData(): void {
        // Mock Oslo, Norway coordinates and timezone
        this._latitude = 59.9139;
        this._longitude = 10.7522;
        this._timezone = 'Europe/Oslo';
    }

    async init(): Promise<void> {
        this.initCallCount++;
        
        if (this.shouldFailInit) {
            throw new Error('Mock GeoHelper init failure');
        }

        this.isInitialized = true;
        this.logger.info('MockGeoHelper initialized with default data');
    }

    /**
     * Get the current latitude
     */
    get latitude(): number | null {
        if (!this.isInitialized) {
            this.logger.warn('MockGeoHelper not initialized. Call init() first.');
            return null;
        }
        return this._latitude;
    }

    /**
     * Get the current longitude
     */
    get longitude(): number | null {
        if (!this.isInitialized) {
            this.logger.warn('MockGeoHelper not initialized. Call init() first.');
            return null;
        }
        return this._longitude;
    }

    /**
     * Get the current timezone
     */
    get timezone(): string | null {
        if (!this.isInitialized) {
            this.logger.warn('MockGeoHelper not initialized. Call init() first.');
            return null;
        }
        return this._timezone;
    }

    /**
     * Get both coordinates as an object
     */
    getCoordinates(): { latitude: number | null; longitude: number | null } {
        return {
            latitude: this._latitude,
            longitude: this._longitude
        };
    }

    /**
     * Get coordinates as a formatted string
     */
    getCoordinatesString(): string {
        if (this._latitude === null || this._longitude === null) {
            return 'Location unknown';
        }
        return `${this._latitude}, ${this._longitude}`;
    }

    /**
     * Check if location data is available
     */
    hasLocation(): boolean {
        return this._latitude !== null && this._longitude !== null;
    }

    /**
     * Check if timezone data is available
     */
    hasTimezone(): boolean {
        return this._timezone !== null;
    }

    /**
     * Get location and timezone data together
     */
    getLocationInfo(): { 
        latitude: number | null; 
        longitude: number | null; 
        timezone: string | null;
        coordinatesString: string;
    } {
        return {
            latitude: this._latitude,
            longitude: this._longitude,
            timezone: this._timezone,
            coordinatesString: this.getCoordinatesString()
        };
    }

    /**
     * Get a formatted string with location and timezone
     */
    getLocationInfoString(): string {
        const coords = this.getCoordinatesString();
        const tz = this._timezone || 'Unknown timezone';
        return `${coords} (${tz})`;
    }

    /**
     * Force refresh the location and timezone (useful for manual updates)
     */
    async refreshLocation(): Promise<void> {
        this.refreshLocationCallCount++;
        
        if (!this.isInitialized) {
            throw new Error('MockGeoHelper not initialized. Call init() first.');
        }
        
        if (this.shouldFailRefresh) {
            throw new Error('Mock refresh failure');
        }

        // In mock, we don't actually change the values unless explicitly set
        this.logger.info('MockGeoHelper location refreshed');
    }

    /**
     * Force refresh just the timezone
     */
    async refreshTimezone(): Promise<void> {
        this.refreshTimezoneCallCount++;
        
        if (!this.isInitialized) {
            throw new Error('MockGeoHelper not initialized. Call init() first.');
        }
        
        if (this.shouldFailRefresh) {
            throw new Error('Mock timezone refresh failure');
        }

        this.logger.info('MockGeoHelper timezone refreshed');
    }

    // === Test Helper Methods ===

    /**
     * Set mock location data (for testing)
     */
    setMockLocation(latitude: number, longitude: number): void {
        this._latitude = latitude;
        this._longitude = longitude;
        this.updateLocationCallCount++;
        this.logger.info(`Mock location set to: ${latitude}, ${longitude}`);
    }

    /**
     * Set mock timezone data (for testing)
     */
    setMockTimezone(timezone: string): void {
        this._timezone = timezone;
        this.updateTimezoneCallCount++;
        this.logger.info(`Mock timezone set to: ${timezone}`);
    }

    /**
     * Clear location data (for testing null scenarios)
     */
    clearLocation(): void {
        this._latitude = null;
        this._longitude = null;
        this.logger.info('Mock location cleared');
    }

    /**
     * Clear timezone data (for testing null scenarios)
     */
    clearTimezone(): void {
        this._timezone = null;
        this.logger.info('Mock timezone cleared');
    }

    /**
     * Simulate a location change event
     */
    simulateLocationChange(latitude: number, longitude: number): void {
        this.setMockLocation(latitude, longitude);
        this.locationChangeCallbacks.forEach(callback => {
            try {
                callback();
            } catch (error) {
                this.logger.error('Error in location change callback:', error);
            }
        });
    }

    /**
     * Simulate a timezone change event
     */
    simulateTimezoneChange(timezone: string): void {
        this.setMockTimezone(timezone);
        this.timezoneChangeCallbacks.forEach(callback => {
            try {
                callback();
            } catch (error) {
                this.logger.error('Error in timezone change callback:', error);
            }
        });
    }

    /**
     * Register a callback for location changes (for testing event handling)
     */
    onLocationChange(callback: () => void): void {
        this.locationChangeCallbacks.push(callback);
    }

    /**
     * Register a callback for timezone changes (for testing event handling)
     */
    onTimezoneChange(callback: () => void): void {
        this.timezoneChangeCallbacks.push(callback);
    }

    /**
     * Reset all mock state and counters
     */
    reset(): void {
        this.setupDefaultData();
        this.isInitialized = false;
        
        // Reset flags
        this.shouldFailInit = false;
        this.shouldFailUpdateLocation = false;
        this.shouldFailUpdateTimezone = false;
        this.shouldFailRefresh = false;
        
        // Reset counters
        this.initCallCount = 0;
        this.updateLocationCallCount = 0;
        this.updateTimezoneCallCount = 0;
        this.refreshLocationCallCount = 0;
        this.refreshTimezoneCallCount = 0;
        
        // Clear callbacks
        this.locationChangeCallbacks = [];
        this.timezoneChangeCallbacks = [];
        
        this.logger.info('MockGeoHelper reset to default state');
    }

    /**
     * Get test statistics
     */
    getStats(): {
        initCallCount: number;
        updateLocationCallCount: number;
        updateTimezoneCallCount: number;
        refreshLocationCallCount: number;
        refreshTimezoneCallCount: number;
        isInitialized: boolean;
        hasLocation: boolean;
        hasTimezone: boolean;
    } {
        return {
            initCallCount: this.initCallCount,
            updateLocationCallCount: this.updateLocationCallCount,
            updateTimezoneCallCount: this.updateTimezoneCallCount,
            refreshLocationCallCount: this.refreshLocationCallCount,
            refreshTimezoneCallCount: this.refreshTimezoneCallCount,
            isInitialized: this.isInitialized,
            hasLocation: this.hasLocation(),
            hasTimezone: this.hasTimezone()
        };
    }
}