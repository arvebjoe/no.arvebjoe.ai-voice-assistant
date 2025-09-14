// Using require for HomeyAPI as it might not have TypeScript typings
import { HomeyAPI } from 'homey-api';
import { createLogger } from './logger.mjs';

export class ApiHelper {
    private homey: any;
    private api: any;
    private logger = createLogger('ApiHelper', false);

    constructor(homey: any) {
        this.homey = homey;
        this.api = null;
    }

    async init(): Promise<void> {
        this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
        this.logger.info('ApiHelper initialized');

        await this.api.devices.connect();
        this.logger.info('API devices connected');
    }

    /**
     * Get the devices API instance
     */
    get devices() {
        if (!this.api) {
            throw new Error('ApiHelper not initialized. Call init() first.');
        }
        return this.api.devices;
    }

    /**
     * Get the zones API instance
     */
    get zones() {
        if (!this.api) {
            throw new Error('ApiHelper not initialized. Call init() first.');
        }
        return this.api.zones;
    }

    /**
     * Get the full API instance (for any other API calls)
     */
    getApi() {
        if (!this.api) {
            throw new Error('ApiHelper not initialized. Call init() first.');
        }
        return this.api;
    }
}