import { createLogger } from '../../src/helpers/logger.mjs';

export class MockWeatherHelper {
    private logger = createLogger('MOCKWEATHERHELPER', false);

    constructor() {
        this.logger.info('MockWeatherHelper initialized');
    }

    async init() {
        // Mock initialization
    }

    async getCurrentWeather() {
        return {
            temperature: 15.5,
            feelsLike: 14.2,
            humidity: 65,
            windSpeed: 3.2,
            conditions: [{ main: 'Clear', description: 'clear sky', icon: '01d' }],
            location: { latitude: 59.9139, longitude: 10.7522, name: 'Oslo' }
        };
    }

    async getForecast() {
        return {
            location: { latitude: 59.9139, longitude: 10.7522, name: 'Oslo' },
            forecasts: [
                {
                    timestamp: new Date(Date.now() + 3 * 60 * 60 * 1000),
                    temperature: 12.5,
                    feelsLike: 11.8,
                    humidity: 70,
                    conditions: [{ main: 'Clear', description: 'clear sky', icon: '01d' }],
                    precipitationProbability: 5
                }
            ]
        };
    }

    async getWeatherForTime(targetTime: Date) {
        return {
            timestamp: targetTime,
            temperature: 14,
            feelsLike: 13.2,
            humidity: 60,
            conditions: [{ main: 'Clear', description: 'clear sky', icon: '01d' }],
            precipitationProbability: 10
        };
    }

    async willItRain(hoursFromNow: number) {
        return {
            willRain: false,
            probability: 10,
            description: 'clear sky'
        };
    }

    async getWeatherSummary() {
        return 'Current weather in Oslo: 15.5°C, clear sky. Feels like 14.2°C. Humidity: 65%, Wind: 3.2 m/s.';
    }

    clearCache() {
        // Mock cache clear
    }
}