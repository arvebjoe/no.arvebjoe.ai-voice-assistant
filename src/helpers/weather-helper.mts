import { createLogger } from './logger.mjs';
import { GeoHelper } from './geo-helper.mjs';

export interface WeatherCondition {
    code: number;           // WMO weather code
    description: string;    // Human readable weather description
}

export interface WeatherData {
    temperature: number;        // Current temperature in Celsius
    feelsLike: number;         // Apparent temperature in Celsius
    humidity: number;          // Relative humidity percentage
    pressure: number;          // Sea level pressure in hPa
    visibility: number;        // Visibility in meters
    windSpeed: number;         // Wind speed in km/h
    windDirection: number;     // Wind direction in degrees
    windGusts: number;         // Wind gusts in km/h
    cloudiness: number;        // Cloud cover percentage
    conditions: WeatherCondition[];
    uvIndex: number;           // UV Index
    isDaylight: boolean;       // Whether it's currently daylight
    precipitation: number;     // Precipitation in mm
    timestamp: Date;
    location: {
        latitude: number;
        longitude: number;
        timezone: string;
        elevation: number;
    };
}

export interface ForecastItem {
    timestamp: Date;
    temperature: number;
    feelsLike: number;
    humidity: number;
    conditions: WeatherCondition[];
    windSpeed: number;
    windGusts: number;
    cloudiness: number;
    precipitationProbability: number;  // Probability of precipitation (0-100%)
    precipitation: number;             // Precipitation amount in mm
    uvIndex: number;
    isDaylight: boolean;
}

export interface ForecastData {
    location: {
        latitude: number;
        longitude: number;
        timezone: string;
        elevation: number;
    };
    forecasts: ForecastItem[];
}

export interface IlluminationData {
    isDay: boolean;
    isDaylight: boolean;
    solarRadiation: number;      // W/m²
    directRadiation: number;     // W/m²
    diffuseRadiation: number;    // W/m²
    uvIndex: number;
    sunElevation: number;        // Degrees above horizon
    illuminationLevel: 'dark' | 'twilight' | 'dim' | 'bright' | 'very_bright';
    description: string;
}

export class WeatherHelper {
    private geoHelper: GeoHelper;
    private logger = createLogger('WeatherHelper', false);
    private isInitialized = false;
    private baseUrl = 'https://api.open-meteo.com/v1';

    // Cache to avoid excessive API calls
    private currentWeatherCache: { data: WeatherData; timestamp: number } | null = null;
    private forecastCache: { data: ForecastData; timestamp: number } | null = null;
    private illuminationCache: { data: IlluminationData; timestamp: number } | null = null;
    private cacheValidityMs = 10 * 60 * 1000; // 10 minutes

    // WMO Weather Code interpretations
    private readonly wmoWeatherCodes: { [key: number]: string } = {
        0: 'Clear sky',
        1: 'Mainly clear',
        2: 'Partly cloudy',
        3: 'Overcast',
        45: 'Fog',
        48: 'Depositing rime fog',
        51: 'Light drizzle',
        53: 'Moderate drizzle',
        55: 'Dense drizzle',
        56: 'Light freezing drizzle',
        57: 'Dense freezing drizzle',
        61: 'Slight rain',
        63: 'Moderate rain',
        65: 'Heavy rain',
        66: 'Light freezing rain',
        67: 'Heavy freezing rain',
        71: 'Slight snow fall',
        73: 'Moderate snow fall',
        75: 'Heavy snow fall',
        77: 'Snow grains',
        80: 'Slight rain showers',
        81: 'Moderate rain showers',
        82: 'Violent rain showers',
        85: 'Slight snow showers',
        86: 'Heavy snow showers',
        95: 'Thunderstorm',
        96: 'Thunderstorm with slight hail',
        99: 'Thunderstorm with heavy hail'
    };

    constructor(geoHelper: GeoHelper) {
        this.geoHelper = geoHelper;
    }

    async init(): Promise<void> {
        if (!this.geoHelper.hasLocation()) {
            this.logger.warn('GeoHelper has no location data. WeatherHelper may not work properly.');
            return;
        }

        this.isInitialized = true;
        this.logger.info('WeatherHelper initialized with Open-Meteo API');
    }

    /**
     * Get current weather for the current location
     */
    async getCurrentWeather(forceRefresh: boolean = false): Promise<WeatherData> {
        if (!this.isInitialized) {
            throw new Error('WeatherHelper not initialized. Call init() first.');
        }

        // Check cache first
        if (!forceRefresh && this.currentWeatherCache && this.isCacheValid(this.currentWeatherCache.timestamp)) {
            this.logger.info('Returning cached current weather data');
            return this.currentWeatherCache.data;
        }

        const latitude = this.geoHelper.latitude;
        const longitude = this.geoHelper.longitude;
        const timezone = this.geoHelper.timezone || 'auto';

        if (latitude === null || longitude === null) {
            throw new Error('No location data available from GeoHelper.');
        }

        try {
            const params = new URLSearchParams({
                latitude: latitude.toString(),
                longitude: longitude.toString(),
                timezone,
                current: [
                    'temperature_2m',
                    'apparent_temperature',
                    'relative_humidity_2m',
                    'precipitation',
                    'weather_code',
                    'surface_pressure',
                    'cloud_cover',
                    'visibility',
                    'wind_speed_10m',
                    'wind_direction_10m',
                    'wind_gusts_10m',
                    'uv_index',
                    'is_day'
                ].join(',')
            });

            const url = `${this.baseUrl}/forecast?${params}`;
            this.logger.info(`Fetching current weather from Open-Meteo: ${url}`);

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Open-Meteo API error: ${response.status} ${response.statusText}`);
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
    async getForecast(forceRefresh: boolean = false, days: number = 7): Promise<ForecastData> {
        if (!this.isInitialized) {
            throw new Error('WeatherHelper not initialized. Call init() first.');
        }

        // Check cache first
        if (!forceRefresh && this.forecastCache && this.isCacheValid(this.forecastCache.timestamp)) {
            this.logger.info('Returning cached forecast data');
            return this.forecastCache.data;
        }

        const latitude = this.geoHelper.latitude;
        const longitude = this.geoHelper.longitude;
        const timezone = this.geoHelper.timezone || 'auto';

        if (latitude === null || longitude === null) {
            throw new Error('No location data available from GeoHelper.');
        }

        try {
            const params = new URLSearchParams({
                latitude: latitude.toString(),
                longitude: longitude.toString(),
                timezone,
                forecast_days: Math.min(days, 16).toString(),
                hourly: [
                    'temperature_2m',
                    'apparent_temperature',
                    'relative_humidity_2m',
                    'precipitation',
                    'precipitation_probability',
                    'weather_code',
                    'cloud_cover',
                    'wind_speed_10m',
                    'wind_gusts_10m',
                    'uv_index',
                    'is_day'
                ].join(',')
            });

            const url = `${this.baseUrl}/forecast?${params}`;
            this.logger.info(`Fetching forecast from Open-Meteo: ${url}`);

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Open-Meteo API error: ${response.status} ${response.statusText}`);
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
     * Get current outside illumination data
     */
    async getOutsideIllumination(forceRefresh: boolean = false): Promise<IlluminationData> {
        if (!this.isInitialized) {
            throw new Error('WeatherHelper not initialized. Call init() first.');
        }

        // Check cache first
        if (!forceRefresh && this.illuminationCache && this.isCacheValid(this.illuminationCache.timestamp)) {
            this.logger.info('Returning cached illumination data');
            return this.illuminationCache.data;
        }

        const latitude = this.geoHelper.latitude;
        const longitude = this.geoHelper.longitude;
        const timezone = this.geoHelper.timezone || 'auto';

        if (latitude === null || longitude === null) {
            throw new Error('No location data available from GeoHelper.');
        }

        try {
            const params = new URLSearchParams({
                latitude: latitude.toString(),
                longitude: longitude.toString(),
                timezone,
                current: [
                    'is_day',
                    'shortwave_radiation',
                    'direct_radiation',
                    'diffuse_radiation',
                    'uv_index'
                ].join(','),
                daily: 'sunrise,sunset'
            });

            const url = `${this.baseUrl}/forecast?${params}`;
            this.logger.info(`Fetching illumination data from Open-Meteo: ${url}`);

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Open-Meteo API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            const illuminationData = this.parseIlluminationResponse(data);

            // Update cache
            this.illuminationCache = {
                data: illuminationData,
                timestamp: Date.now()
            };

            this.logger.info(`Illumination data retrieved: ${illuminationData.illuminationLevel}, ${illuminationData.solarRadiation}W/m²`);
            return illuminationData;

        } catch (error) {
            this.logger.error('Failed to fetch illumination data:', error);
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
            this.isRainWeatherCode(condition.code)
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
                   `Feels like ${weather.feelsLike}°C. Humidity: ${weather.humidity}%, Wind: ${weather.windSpeed} km/h.`;
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
        this.illuminationCache = null;
        this.logger.info('Weather cache cleared');
    }

    /**
     * Check if cached data is still valid
     */
    private isCacheValid(timestamp: number): boolean {
        return Date.now() - timestamp < this.cacheValidityMs;
    }

    /**
     * Check if WMO weather code indicates rain
     */
    private isRainWeatherCode(code: number): boolean {
        const rainCodes = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82];
        return rainCodes.includes(code);
    }

    /**
     * Parse Open-Meteo current weather API response
     */
    private parseCurrentWeatherResponse(data: any): WeatherData {
        const current = data.current || {};
        const weatherCode = current.weather_code || 0;
        
        return {
            temperature: Math.round((current.temperature_2m || 0) * 10) / 10,
            feelsLike: Math.round((current.apparent_temperature || current.temperature_2m || 0) * 10) / 10,
            humidity: current.relative_humidity_2m || 0,
            pressure: current.surface_pressure || 0,
            visibility: (current.visibility || 10000) / 1000, // Convert to km, default 10km
            windSpeed: Math.round((current.wind_speed_10m || 0) * 10) / 10,
            windDirection: current.wind_direction_10m || 0,
            windGusts: Math.round((current.wind_gusts_10m || 0) * 10) / 10,
            cloudiness: current.cloud_cover || 0,
            conditions: [{
                code: weatherCode,
                description: this.wmoWeatherCodes[weatherCode] || `Weather code ${weatherCode}`
            }],
            uvIndex: current.uv_index || 0,
            isDaylight: current.is_day === 1,
            precipitation: current.precipitation || 0,
            timestamp: new Date(),
            location: {
                latitude: data.latitude,
                longitude: data.longitude,
                timezone: data.timezone || 'UTC',
                elevation: data.elevation || 0
            }
        };
    }

    /**
     * Parse Open-Meteo forecast API response
     */
    private parseForecastResponse(data: any): ForecastData {
        const hourly = data.hourly || {};
        const timeArray = hourly.time || [];
        
        const forecasts = timeArray.map((time: string, index: number) => {
            const weatherCode = hourly.weather_code?.[index] || 0;
            
            return {
                timestamp: new Date(time),
                temperature: Math.round((hourly.temperature_2m?.[index] || 0) * 10) / 10,
                feelsLike: Math.round((hourly.apparent_temperature?.[index] || hourly.temperature_2m?.[index] || 0) * 10) / 10,
                humidity: hourly.relative_humidity_2m?.[index] || 0,
                conditions: [{
                    code: weatherCode,
                    description: this.wmoWeatherCodes[weatherCode] || `Weather code ${weatherCode}`
                }],
                windSpeed: Math.round((hourly.wind_speed_10m?.[index] || 0) * 10) / 10,
                windGusts: Math.round((hourly.wind_gusts_10m?.[index] || 0) * 10) / 10,
                cloudiness: hourly.cloud_cover?.[index] || 0,
                precipitationProbability: hourly.precipitation_probability?.[index] || 0,
                precipitation: hourly.precipitation?.[index] || 0,
                uvIndex: hourly.uv_index?.[index] || 0,
                isDaylight: hourly.is_day?.[index] === 1
            };
        });

        return {
            location: {
                latitude: data.latitude,
                longitude: data.longitude,
                timezone: data.timezone || 'UTC',
                elevation: data.elevation || 0
            },
            forecasts
        };
    }

    /**
     * Parse Open-Meteo illumination response
     */
    private parseIlluminationResponse(data: any): IlluminationData {
        const current = data.current || {};
        const daily = data.daily || {};
        
        const isDay = current.is_day === 1;
        const solarRadiation = current.shortwave_radiation || 0;
        const directRadiation = current.direct_radiation || 0;
        const diffuseRadiation = current.diffuse_radiation || 0;
        const uvIndex = current.uv_index || 0;
        
        // Calculate sun elevation based on radiation
        let sunElevation = 0;
        if (directRadiation > 0) {
            // Rough approximation: max direct radiation ~1000 W/m² at 90° elevation
            sunElevation = Math.asin(Math.min(directRadiation / 1000, 1)) * (180 / Math.PI);
        }
        
        // Determine illumination level
        let illuminationLevel: 'dark' | 'twilight' | 'dim' | 'bright' | 'very_bright';
        let description: string;
        
        if (!isDay && solarRadiation < 1) {
            illuminationLevel = 'dark';
            description = 'It is dark outside with no solar radiation.';
        } else if (solarRadiation < 50) {
            illuminationLevel = 'twilight';
            description = 'It is twilight outside with minimal light.';
        } else if (solarRadiation < 200) {
            illuminationLevel = 'dim';
            description = 'It is dim outside with low light conditions.';
        } else if (solarRadiation < 600) {
            illuminationLevel = 'bright';
            description = 'It is bright outside with good lighting conditions.';
        } else {
            illuminationLevel = 'very_bright';
            description = 'It is very bright outside with excellent lighting conditions.';
        }

        // Handle sunrise/sunset times
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];
        const sunriseTime = daily.sunrise?.[0] ? new Date(daily.sunrise[0]) : null;
        const sunsetTime = daily.sunset?.[0] ? new Date(daily.sunset[0]) : null;
        
        let isDaylight = isDay;
        if (sunriseTime && sunsetTime) {
            isDaylight = now >= sunriseTime && now <= sunsetTime;
        }

        return {
            isDay,
            isDaylight,
            solarRadiation,
            directRadiation,
            diffuseRadiation,
            uvIndex,
            sunElevation,
            illuminationLevel,
            description
        };
    }
}