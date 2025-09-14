import { createLogger } from './logger.mjs';
import { GeoHelper } from './geo-helper.mjs';
import { settingsManager } from '../settings/settings-manager.mjs';

export interface WeatherCondition {
    main: string;           // Rain, Snow, Clear, etc.
    description: string;    // light rain, clear sky, etc.
    icon: string;          // Weather icon code
}

export interface WeatherData {
    temperature: number;        // Current temperature in Celsius
    feelsLike: number;         // Feels like temperature in Celsius
    humidity: number;          // Humidity percentage
    pressure: number;          // Atmospheric pressure in hPa
    visibility: number;        // Visibility in meters
    windSpeed: number;         // Wind speed in m/s
    windDirection: number;     // Wind direction in degrees
    cloudiness: number;        // Cloudiness percentage
    conditions: WeatherCondition[];
    sunrise: Date;
    sunset: Date;
    timestamp: Date;
    location: {
        latitude: number;
        longitude: number;
        name?: string;
        country?: string;
    };
}

export interface ForecastItem {
    timestamp: Date;
    temperature: number;
    feelsLike: number;
    humidity: number;
    conditions: WeatherCondition[];
    windSpeed: number;
    cloudiness: number;
    precipitationProbability: number;  // Probability of precipitation (0-100%)
    precipitationAmount?: number;      // Precipitation amount in mm
}

export interface ForecastData {
    location: {
        latitude: number;
        longitude: number;
        name?: string;
        country?: string;
    };
    forecasts: ForecastItem[];
}

export class WeatherHelper {
    private geoHelper: GeoHelper;
    private logger = createLogger('WeatherHelper', false);
    private apiKey: string;
    private isInitialized = false;
    private baseUrl = 'https://api.openweathermap.org/data/2.5';

    // Cache to avoid excessive API calls
    private currentWeatherCache: { data: WeatherData; timestamp: number } | null = null;
    private forecastCache: { data: ForecastData; timestamp: number } | null = null;
    private cacheValidityMs = 10 * 60 * 1000; // 10 minutes

    constructor(geoHelper: GeoHelper, apiKey?: string) {
        this.geoHelper = geoHelper;
        this.apiKey = apiKey || '';
    }

    async init(): Promise<void> {
        if (!this.geoHelper.hasLocation()) {
            this.logger.warn('GeoHelper has no location data. WeatherHelper may not work properly.');
        }

        if (!this.apiKey) {
            // Try to get API key from settings
            this.apiKey = settingsManager.getGlobal<string>('openweather_api_key', '');
            if (!this.apiKey) {
                this.logger.warn('No OpenWeatherMap API key provided. Weather functionality will be limited.');
                return;
            }
        }

        this.isInitialized = true;
        this.logger.info('WeatherHelper initialized');
    }

    /**
     * Get current weather for the current location
     */
    async getCurrentWeather(forceRefresh: boolean = false): Promise<WeatherData> {
        if (!this.isInitialized) {
            throw new Error('WeatherHelper not initialized. Call init() first.');
        }

        if (!this.apiKey) {
            throw new Error('No OpenWeatherMap API key configured.');
        }

        // Check cache first
        if (!forceRefresh && this.currentWeatherCache && this.isCacheValid(this.currentWeatherCache.timestamp)) {
            this.logger.info('Returning cached current weather data');
            return this.currentWeatherCache.data;
        }

        const latitude = this.geoHelper.latitude;
        const longitude = this.geoHelper.longitude;

        if (latitude === null || longitude === null) {
            throw new Error('No location data available from GeoHelper.');
        }
//&appid=${this.apiKey}
        try {
            const url = `${this.baseUrl}/weather?lat=${latitude}&lon=${longitude}&units=metric`;
            this.logger.info(`Fetching current weather from: ${url.replace(this.apiKey, '[API_KEY]')}`);

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Weather API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            const weatherData = this.parseCurrentWeatherResponse(data);

            // Update cache
            this.currentWeatherCache = {
                data: weatherData,
                timestamp: Date.now()
            };

            this.logger.info(`Current weather retrieved: ${weatherData.temperature}°C, ${weatherData.conditions[0]?.description}`);
            return weatherData;

        } catch (error) {
            this.logger.error('Failed to fetch current weather:', error);
            throw error;
        }
    }

    /**
     * Get weather forecast for the current location
     */
    async getForecast(forceRefresh: boolean = false): Promise<ForecastData> {
        if (!this.isInitialized) {
            throw new Error('WeatherHelper not initialized. Call init() first.');
        }

        if (!this.apiKey) {
            throw new Error('No OpenWeatherMap API key configured.');
        }

        // Check cache first
        if (!forceRefresh && this.forecastCache && this.isCacheValid(this.forecastCache.timestamp)) {
            this.logger.info('Returning cached forecast data');
            return this.forecastCache.data;
        }

        const latitude = this.geoHelper.latitude;
        const longitude = this.geoHelper.longitude;

        if (latitude === null || longitude === null) {
            throw new Error('No location data available from GeoHelper.');
        }

        try {
            const url = `${this.baseUrl}/forecast?lat=${latitude}&lon=${longitude}&appid=${this.apiKey}&units=metric`;
            this.logger.info(`Fetching forecast from: ${url.replace(this.apiKey, '[API_KEY]')}`);

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Weather API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            const forecastData = this.parseForecastResponse(data);

            // Update cache
            this.forecastCache = {
                data: forecastData,
                timestamp: Date.now()
            };

            this.logger.info(`Forecast retrieved: ${forecastData.forecasts.length} items`);
            return forecastData;

        } catch (error) {
            this.logger.error('Failed to fetch weather forecast:', error);
            throw error;
        }
    }

    /**
     * Get weather forecast for a specific time period
     */
    async getWeatherForTime(targetTime: Date): Promise<ForecastItem | null> {
        const forecast = await this.getForecast();
        
        // Find the closest forecast item to the target time
        let closest: ForecastItem | null = null;
        let minTimeDiff = Number.MAX_SAFE_INTEGER;

        for (const item of forecast.forecasts) {
            const timeDiff = Math.abs(item.timestamp.getTime() - targetTime.getTime());
            if (timeDiff < minTimeDiff) {
                minTimeDiff = timeDiff;
                closest = item;
            }
        }

        if (closest) {
            this.logger.info(`Found forecast for ${targetTime.toISOString()}: ${closest.temperature}°C`);
        }

        return closest;
    }

    /**
     * Check if it will rain within a certain time period
     */
    async willItRain(hoursFromNow: number): Promise<{ willRain: boolean; probability: number; description: string }> {
        const targetTime = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
        const forecast = await this.getWeatherForTime(targetTime);

        if (!forecast) {
            return { willRain: false, probability: 0, description: 'No forecast data available' };
        }

        const hasRain = forecast.conditions.some(condition => 
            condition.main.toLowerCase().includes('rain') || 
            condition.main.toLowerCase().includes('drizzle')
        );

        const probability = forecast.precipitationProbability;
        const description = forecast.conditions[0]?.description || 'Unknown';

        return {
            willRain: hasRain || probability > 50,
            probability,
            description
        };
    }

    /**
     * Get weather summary as a human-readable string
     */
    async getWeatherSummary(): Promise<string> {
        try {
            const weather = await this.getCurrentWeather();
            const location = this.geoHelper.getLocationInfoString();
            
            return `Current weather at ${location}: ${weather.temperature}°C, ${weather.conditions[0]?.description}. ` +
                   `Feels like ${weather.feelsLike}°C. Humidity: ${weather.humidity}%, Wind: ${weather.windSpeed} m/s.`;
        } catch (error) {
            this.logger.error('Failed to get weather summary:', error);
            return 'Weather information is currently unavailable.';
        }
    }

    /**
     * Clear the weather cache
     */
    clearCache(): void {
        this.currentWeatherCache = null;
        this.forecastCache = null;
        this.logger.info('Weather cache cleared');
    }

    /**
     * Check if cached data is still valid
     */
    private isCacheValid(timestamp: number): boolean {
        return Date.now() - timestamp < this.cacheValidityMs;
    }

    /**
     * Parse OpenWeatherMap current weather API response
     */
    private parseCurrentWeatherResponse(data: any): WeatherData {
        return {
            temperature: Math.round(data.main.temp * 10) / 10,
            feelsLike: Math.round(data.main.feels_like * 10) / 10,
            humidity: data.main.humidity,
            pressure: data.main.pressure,
            visibility: data.visibility || 0,
            windSpeed: Math.round((data.wind?.speed || 0) * 10) / 10,
            windDirection: data.wind?.deg || 0,
            cloudiness: data.clouds?.all || 0,
            conditions: (data.weather || []).map((w: any) => ({
                main: w.main,
                description: w.description,
                icon: w.icon
            })),
            sunrise: new Date(data.sys.sunrise * 1000),
            sunset: new Date(data.sys.sunset * 1000),
            timestamp: new Date(),
            location: {
                latitude: data.coord.lat,
                longitude: data.coord.lon,
                name: data.name,
                country: data.sys?.country
            }
        };
    }

    /**
     * Parse OpenWeatherMap forecast API response
     */
    private parseForecastResponse(data: any): ForecastData {
        const forecasts = (data.list || []).map((item: any) => ({
            timestamp: new Date(item.dt * 1000),
            temperature: Math.round(item.main.temp * 10) / 10,
            feelsLike: Math.round(item.main.feels_like * 10) / 10,
            humidity: item.main.humidity,
            conditions: (item.weather || []).map((w: any) => ({
                main: w.main,
                description: w.description,
                icon: w.icon
            })),
            windSpeed: Math.round((item.wind?.speed || 0) * 10) / 10,
            cloudiness: item.clouds?.all || 0,
            precipitationProbability: Math.round((item.pop || 0) * 100),
            precipitationAmount: item.rain?.['3h'] || item.snow?.['3h'] || undefined
        }));

        return {
            location: {
                latitude: data.city.coord.lat,
                longitude: data.city.coord.lon,
                name: data.city.name,
                country: data.city.country
            },
            forecasts
        };
    }
}