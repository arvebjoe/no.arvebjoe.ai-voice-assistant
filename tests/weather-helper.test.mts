import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WeatherHelper } from '../src/helpers/weather-helper.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';

// Mock fetch globally
global.fetch = vi.fn();

describe('WeatherHelper', () => {
    let weatherHelper: WeatherHelper;
    let mockGeoHelper: MockGeoHelper;

    beforeEach(async () => {
        // Reset mocks
        vi.clearAllMocks();
        
        // Clear fetch mock and restore it
        (global.fetch as any).mockClear();
        (global.fetch as any).mockReset();
        
        // Setup mock geo helper with Oslo coordinates
        mockGeoHelper = new MockGeoHelper();
        await mockGeoHelper.init();
        mockGeoHelper.setMockLocation(59.9139, 10.7522); // Oslo
        mockGeoHelper.setMockTimezone('Europe/Oslo');
        
        weatherHelper = new WeatherHelper(mockGeoHelper as any);
        await weatherHelper.init();
        
        // Clear any cached data
        weatherHelper.clearCache();
    });

    describe('Initialization', () => {
        it('should initialize successfully', async () => {
            await weatherHelper.init();
            // No error should be thrown
        });

        it('should warn when GeoHelper has no location', async () => {
            mockGeoHelper.clearLocation();
            await weatherHelper.init();
            // Should not throw, but log warning
        });
    });

    describe('Current Weather', () => {
        const mockCurrentWeatherResponse = {
            latitude: 59.9139,
            longitude: 10.7522,
            timezone: 'Europe/Oslo',
            elevation: 94.0,
            current: {
                temperature_2m: 15.5,
                apparent_temperature: 14.2,
                relative_humidity_2m: 65,
                precipitation: 0,
                weather_code: 0,
                surface_pressure: 1013.25,
                cloud_cover: 10,
                visibility: 10000,
                wind_speed_10m: 11.5, // km/h
                wind_direction_10m: 225,
                wind_gusts_10m: 18.0,
                uv_index: 3.2,
                is_day: 1
            }
        };

        it('should fetch current weather successfully', async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockCurrentWeatherResponse)
            });

            const weather = await weatherHelper.getCurrentWeather();

            expect(weather.temperature).toBe(15.5);
            expect(weather.conditions[0].description).toBe('Clear sky');
            expect(weather.feelsLike).toBe(14.2);
            expect(weather.humidity).toBe(65);
            expect(weather.windSpeed).toBe(11.5);
            expect(weather.isDaylight).toBe(true);
        });

        it('should use cached data when available', async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockCurrentWeatherResponse)
            });

            // First call
            const weather1 = await weatherHelper.getCurrentWeather();
            
            // Second call should use cache (no new fetch call)
            const weather2 = await weatherHelper.getCurrentWeather();

            expect(weather1.temperature).toBe(15.5);
            expect(weather2.temperature).toBe(15.5);
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        it('should force refresh when requested', async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockCurrentWeatherResponse)
            }).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    ...mockCurrentWeatherResponse,
                    current: { ...mockCurrentWeatherResponse.current, temperature_2m: 20 }
                })
            });

            // First call
            const weather1 = await weatherHelper.getCurrentWeather();
            
            // Second call with force refresh
            const weather2 = await weatherHelper.getCurrentWeather(true);

            expect(weather1.temperature).toBe(15.5);
            expect(weather2.temperature).toBe(20);
            expect(global.fetch).toHaveBeenCalledTimes(2);
        });

        it('should handle API errors', async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: false,
                status: 404,
                statusText: 'Not Found'
            });

            await expect(weatherHelper.getCurrentWeather()).rejects.toThrow('Open-Meteo API error: 404 Not Found');
        });

        it('should handle network errors', async () => {
            (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

            await expect(weatherHelper.getCurrentWeather()).rejects.toThrow('Network error');
        });

        it('should throw when no location is available', async () => {
            mockGeoHelper.clearLocation();

            await expect(weatherHelper.getCurrentWeather()).rejects.toThrow('No location data available from GeoHelper');
        });
    });

    describe('Weather Forecast', () => {
        const mockForecastResponse = {
            latitude: 59.9139,
            longitude: 10.7522,
            timezone: 'Europe/Oslo',
            elevation: 94.0,
            hourly: {
                time: [
                    new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(), // 3 hours from now
                    new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()  // 6 hours from now
                ],
                temperature_2m: [12.5, 14.0],
                apparent_temperature: [11.8, 13.2],
                relative_humidity_2m: [70, 60],
                weather_code: [0, 3],
                wind_speed_10m: [7.5, 10.8],
                wind_gusts_10m: [12.0, 15.5],
                cloud_cover: [10, 90],
                precipitation_probability: [5, 20],
                precipitation: [0, 0],
                uv_index: [2.0, 1.5],
                is_day: [1, 1]
            }
        };

        it('should fetch forecast successfully', async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockForecastResponse)
            });

            const forecast = await weatherHelper.getForecast();

            expect(forecast.forecasts).toHaveLength(2);
            expect(forecast.forecasts[0].temperature).toBe(12.5);
            expect(forecast.forecasts[1].temperature).toBe(14);
        });

        it('should use cached forecast data', async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockForecastResponse)
            });

            // First call
            const forecast1 = await weatherHelper.getForecast();
            
            // Second call should use cache
            const forecast2 = await weatherHelper.getForecast();

            expect(forecast1.forecasts).toHaveLength(2);
            expect(forecast2.forecasts).toHaveLength(2);
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('Outside Illumination', () => {
        const mockIlluminationResponse = {
            latitude: 59.9139,
            longitude: 10.7522,
            timezone: 'Europe/Oslo',
            elevation: 94.0,
            current: {
                is_day: 1,
                shortwave_radiation: 450,
                direct_radiation: 320,
                diffuse_radiation: 130,
                uv_index: 4.5
            },
            daily: {
                sunrise: ['2023-09-16T05:45:00+02:00'],
                sunset: ['2023-09-16T19:30:00+02:00']
            }
        };

        it('should fetch illumination data successfully', async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockIlluminationResponse)
            });

            const illumination = await weatherHelper.getOutsideIllumination();

            expect(illumination.isDay).toBe(true);
            expect(illumination.solarRadiation).toBe(450);
            expect(illumination.illuminationLevel).toBe('bright');
            expect(illumination.uvIndex).toBe(4.5);
        });

        it('should use cached illumination data', async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockIlluminationResponse)
            });

            // First call
            const illumination1 = await weatherHelper.getOutsideIllumination();
            
            // Second call should use cache
            const illumination2 = await weatherHelper.getOutsideIllumination();

            expect(illumination1.solarRadiation).toBe(450);
            expect(illumination2.solarRadiation).toBe(450);
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('Weather for Specific Time', () => {
        const mockForecastResponse = {
            latitude: 59.9139,
            longitude: 10.7522,
            timezone: 'Europe/Oslo',
            elevation: 94.0,
            hourly: {
                time: [new Date('2023-09-14T12:00:00Z').toISOString()],
                temperature_2m: [12.5],
                apparent_temperature: [11.8],
                relative_humidity_2m: [70],
                weather_code: [0],
                wind_speed_10m: [7.5],
                wind_gusts_10m: [12.0],
                cloud_cover: [10],
                precipitation_probability: [5],
                precipitation: [0],
                uv_index: [2.0],
                is_day: [1]
            }
        };

        it('should find weather for specific time', async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockForecastResponse)
            });

            const targetTime = new Date('2023-09-14T11:30:00Z'); // Close to 12:00
            const weather = await weatherHelper.getWeatherForTime(targetTime);

            expect(weather).not.toBeNull();
            expect(weather!.temperature).toBe(12.5);
        });

        it('should return null when no forecast available', async () => {
            // Clear cache to ensure fresh API call
            weatherHelper.clearCache();
            
            // Mock empty forecast
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ 
                    latitude: 59,
                    longitude: 10,
                    hourly: { time: [], temperature_2m: [] }
                })
            });

            const targetTime = new Date();
            const weather = await weatherHelper.getWeatherForTime(targetTime);

            expect(weather).toBeNull();
        });
    });

    describe('Rain Prediction', () => {
        it('should predict rain correctly', async () => {
            // Clear cache to ensure fresh API call
            weatherHelper.clearCache();
            
            const mockForecastWithRain = {
                latitude: 59.9139,
                longitude: 10.7522,
                timezone: 'Europe/Oslo',
                elevation: 94.0,
                hourly: {
                    time: [new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()],
                    temperature_2m: [12.5],
                    apparent_temperature: [11.8],
                    relative_humidity_2m: [80],
                    weather_code: [61], // Slight rain
                    wind_speed_10m: [9.0],
                    wind_gusts_10m: [15.0],
                    cloud_cover: [80],
                    precipitation_probability: [75],
                    precipitation: [2.5],
                    uv_index: [1.0],
                    is_day: [1]
                }
            };

            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockForecastWithRain)
            });

            const rainPrediction = await weatherHelper.willItRain(2);

            expect(rainPrediction.willRain).toBe(true);
            expect(rainPrediction.probability).toBe(75);
            expect(rainPrediction.description).toBe('Slight rain');
        });

        it('should predict no rain correctly', async () => {
            // Clear cache to ensure fresh API call
            weatherHelper.clearCache();
            
            const mockForecastClear = {
                latitude: 59.9139,
                longitude: 10.7522,
                timezone: 'Europe/Oslo',
                elevation: 94.0,
                hourly: {
                    time: [new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()],
                    temperature_2m: [12.5],
                    apparent_temperature: [11.8],
                    relative_humidity_2m: [60],
                    weather_code: [0], // Clear sky
                    wind_speed_10m: [9.0],
                    wind_gusts_10m: [15.0],
                    cloud_cover: [20],
                    precipitation_probability: [10],
                    precipitation: [0],
                    uv_index: [3.0],
                    is_day: [1]
                }
            };

            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockForecastClear)
            });

            const rainPrediction = await weatherHelper.willItRain(2);

            expect(rainPrediction.willRain).toBe(false);
            expect(rainPrediction.probability).toBe(10);
        });
    });

    describe('Weather Summary', () => {
        const mockCurrentWeatherResponse = {
            latitude: 59.9139,
            longitude: 10.7522,
            timezone: 'Europe/Oslo',
            elevation: 94.0,
            current: {
                temperature_2m: 15.5,
                apparent_temperature: 14.2,
                relative_humidity_2m: 65,
                precipitation: 0,
                weather_code: 0,
                surface_pressure: 1013.25,
                cloud_cover: 10,
                visibility: 10000,
                wind_speed_10m: 11.5,
                wind_direction_10m: 225,
                wind_gusts_10m: 18.0,
                uv_index: 3.2,
                is_day: 1
            }
        };

        it('should generate weather summary', async () => {
            // Clear cache to ensure fresh API call
            weatherHelper.clearCache();
            
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockCurrentWeatherResponse)
            });

            const summary = await weatherHelper.getWeatherSummary();

            expect(summary).toContain('15.5°C');
            expect(summary).toContain('Clear sky');
            expect(summary).toContain('14.2°C');
            expect(summary).toContain('65%');
            expect(summary).toContain('11.5 km/h');
            expect(summary).toContain('59.9139, 10.7522');
        });

        it('should handle errors gracefully', async () => {
            // Clear cache to ensure fresh API call
            weatherHelper.clearCache();
            
            (global.fetch as any).mockRejectedValueOnce(new Error('API Error'));

            const summary = await weatherHelper.getWeatherSummary();

            expect(summary).toBe('Weather information is currently unavailable.');
        });
    });

    describe('Cache Management', () => {
        const mockResponse = {
            latitude: 59,
            longitude: 10,
            timezone: 'Europe/Oslo',
            elevation: 94.0,
            current: {
                temperature_2m: 15,
                apparent_temperature: 15,
                relative_humidity_2m: 50,
                precipitation: 0,
                weather_code: 0,
                surface_pressure: 1000,
                cloud_cover: 10,
                visibility: 10000,
                wind_speed_10m: 7.2,
                wind_direction_10m: 225,
                wind_gusts_10m: 12.0,
                uv_index: 2.0,
                is_day: 1
            }
        };

        it('should clear cache successfully', async () => {
            (global.fetch as any).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(mockResponse)
            });

            // First call
            await weatherHelper.getCurrentWeather();
            
            // Clear cache
            weatherHelper.clearCache();
            
            // Second call should fetch again
            await weatherHelper.getCurrentWeather();

            expect(global.fetch).toHaveBeenCalledTimes(2);
        });
    });
});