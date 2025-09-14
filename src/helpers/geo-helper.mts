import { createLogger } from './logger.mjs';

export class GeoHelper {
    private homey: any;
    private logger = createLogger('GeoHelper', false);
    private _latitude: number | null = null;
    private _longitude: number | null = null;
    private _timezone: string | null = null;
    private isInitialized = false;

    constructor(homey: any) {
        this.homey = homey;
    }

    async init(): Promise<void> {
        if (!this.homey.geolocation) {
            this.logger.warn('Geolocation not available on this Homey instance');
            return;
        }

        if (!this.homey.clock) {
            this.logger.warn('Clock manager not available on this Homey instance');
            return;
        }

        try {
            // Get initial location
            await this.updateLocation();

            // Get initial timezone
            await this.updateTimezone();

            // Listen for location changes
            this.homey.geolocation.on('location', () => {
                this.logger.info('Location changed event received');
                this.updateLocation().catch(error => {
                    this.logger.error('Failed to update location on change:', error);
                });
            });

            // Listen for timezone changes
            this.homey.clock.on('timezoneChange', () => {
                this.logger.info('Timezone changed event received');
                this.updateTimezone().catch((error: any) => {
                    this.logger.error('Failed to update timezone on change:', error);
                });
            });

            this.isInitialized = true;
            this.logger.info('GeoHelper initialized');
        } catch (error) {
            this.logger.error('Failed to initialize GeoHelper:', error);
            throw error;
        }
    }

    /**
     * Update the current location coordinates
     */
    private async updateLocation(): Promise<void> {
        try {
            this._latitude = await this.homey.geolocation.getLatitude();
            this._longitude = await this.homey.geolocation.getLongitude();
            
            this.logger.info(`Location updated: ${this._latitude}, ${this._longitude}`);
        } catch (error) {
            this.logger.error('Failed to get location coordinates:', error);
            throw error;
        }
    }

    /**
     * Update the current timezone
     */
    private async updateTimezone(): Promise<void> {
        try {
            this._timezone = this.homey.clock.getTimezone();
            
            this.logger.info(`Timezone updated: ${this._timezone}`);
        } catch (error) {
            this.logger.error('Failed to get timezone:', error);
            throw error;
        }
    }

    /**
     * Get the current latitude
     */
    get latitude(): number | null {
        if (!this.isInitialized) {
            this.logger.warn('GeoHelper not initialized. Call init() first.');
            return null;
        }
        return this._latitude;
    }

    /**
     * Get the current longitude
     */
    get longitude(): number | null {
        if (!this.isInitialized) {
            this.logger.warn('GeoHelper not initialized. Call init() first.');
            return null;
        }
        return this._longitude;
    }

    /**
     * Get the current timezone
     */
    get timezone(): string | null {
        if (!this.isInitialized) {
            this.logger.warn('GeoHelper not initialized. Call init() first.');
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
        if (!this.isInitialized) {
            throw new Error('GeoHelper not initialized. Call init() first.');
        }
        await this.updateLocation();
        await this.updateTimezone();
    }

    /**
     * Force refresh just the timezone
     */
    async refreshTimezone(): Promise<void> {
        if (!this.isInitialized) {
            throw new Error('GeoHelper not initialized. Call init() first.');
        }
        await this.updateTimezone();
    }
}