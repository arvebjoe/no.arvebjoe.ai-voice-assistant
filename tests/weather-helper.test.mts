import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WeatherHelper } from '../src/helpers/weather-helper.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';

// Mock fetch globally
global.fetch = vi.fn();

describe('WeatherHelper', () => {
    let weatherHelper: WeatherHelper;
    let mockGeoHelper: MockGeoHelper;
    const testApiKey = 'test-api-key-12345';

    beforeEach(async () => {
        // Reset mocks
        vi.clearAllMocks();
        settingsManager.reset();
        
        // Clear fetch mock and restore it
        (global.fetch as any).mockClear();
        (global.fetch as any).mockReset();
        
        // Setup mock geo helper with Oslo coordinates
        mockGeoHelper = new MockGeoHelper();
        await mockGeoHelper.init();
        mockGeoHelper.setMockLocation(59.9139, 10.7522); // Oslo
        mockGeoHelper.setMockTimezone('Europe/Oslo');
        
        weatherHelper = new WeatherHelper(mockGeoHelper as any, testApiKey);
        await weatherHelper.init();
        
        // Clear any cached data
        weatherHelper.clearCache();
    });

    describe('Initialization', () => {
        it('should initialize successfully with API key', async () => {
            await weatherHelper.init();
            // No error should be thrown
        });

        it('should warn when GeoHelper has no location', async () => {
            mockGeoHelper.clearLocation();
            await weatherHelper.init();
            // Should not throw, but log warning
        });

        it('should get API key from settings if not provided', async () => {
            // Mock homey settings
            const mockHomey = { settings: { get: vi.fn().mockReturnValue(testApiKey) } };
            settingsManager.init(mockHomey);
            
            const weatherHelperNoKey = new WeatherHelper(mockGeoHelper as any);
            await weatherHelperNoKey.init();
            // Should initialize successfully
        });

        it('should warn when no API key is available', async () => {
            const weatherHelperNoKey = new WeatherHelper(mockGeoHelper as any);
            await weatherHelperNoKey.init();
            // Should not throw, but log warning
        });
    });

    describe('Current Weather', () => {
        const mockCurrentWeatherResponse = {
            coord: { lat: 59.9139, lon: 10.7522 },
            weather: [{ main: 'Clear', description: 'clear sky', icon: '01d' }],
            main: { temp: 15.5, feels_like: 14.2, humidity: 65, pressure: 1013 },
            wind: { speed: 3.2 },
            clouds: { all: 10 },
            sys: { sunrise: 1694664000, sunset: 1694707200, country: 'NO' },
            name: 'Oslo'
        };

        it('should fetch current weather successfully', async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockCurrentWeatherResponse)
            });

            const weather = await weatherHelper.getCurrentWeather();

            expect(weather.temperature).toBe(15.5);
            expect(weather.conditions[0].description).toBe('clear sky');
            expect(weather.feelsLike).toBe(14.2);
            expect(weather.humidity).toBe(65);
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
                    main: { ...mockCurrentWeatherResponse.main, temp: 20 }
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

            await expect(weatherHelper.getCurrentWeather()).rejects.toThrow('Weather API error: 404 Not Found');
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
            city: { coord: { lat: 59.9139, lon: 10.7522 }, name: 'Oslo', country: 'NO' },
            list: [
                {
                    dt: Math.floor((Date.now() + 3 * 60 * 60 * 1000) / 1000), // 3 hours from now
                    main: { temp: 12.5, feels_like: 11.8, humidity: 70 },
                    weather: [{ main: 'Clear', description: 'clear sky', icon: '01d' }],
                    wind: { speed: 2.1 },
                    clouds: { all: 10 },
                    pop: 0.05
                },
                {
                    dt: Math.floor((Date.now() + 6 * 60 * 60 * 1000) / 1000), // 6 hours from now
                    main: { temp: 14.0, feels_like: 13.2, humidity: 60 },
                    weather: [{ main: 'Clouds', description: 'overcast clouds', icon: '04d' }],
                    wind: { speed: 3.0 },
                    clouds: { all: 90 },
                    pop: 0.20
                }
            ]
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

    describe('Weather for Specific Time', () => {
        const mockForecastResponse = {
            city: { coord: { lat: 59.9139, lon: 10.7522 }, name: 'Oslo', country: 'NO' },
            list: [
                {
                    dt: Math.floor(new Date('2023-09-14T12:00:00Z').getTime() / 1000),
                    main: { temp: 12.5, feels_like: 11.8, humidity: 70 },
                    weather: [{ main: 'Clear', description: 'clear sky', icon: '01d' }],
                    wind: { speed: 2.1 },
                    clouds: { all: 10 },
                    pop: 0.05
                }
            ]
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
                    city: { coord: { lat: 59, lon: 10 }, name: 'Test' }, 
                    list: [] 
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
                city: { coord: { lat: 59.9139, lon: 10.7522 }, name: 'Oslo', country: 'NO' },
                list: [
                    {
                        dt: Math.floor((Date.now() + 2 * 60 * 60 * 1000) / 1000), // 2 hours from now
                        main: { temp: 12.5, feels_like: 11.8, humidity: 80 },
                        weather: [{ main: 'Rain', description: 'light rain', icon: '10d' }],
                        wind: { speed: 2.5 },
                        clouds: { all: 80 },
                        pop: 0.75
                    }
                ]
            };

            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockForecastWithRain)
            });

            const rainPrediction = await weatherHelper.willItRain(2);

            expect(rainPrediction.willRain).toBe(true);
            expect(rainPrediction.probability).toBe(75);
            expect(rainPrediction.description).toBe('light rain');
        });

        it('should predict no rain correctly', async () => {
            // Clear cache to ensure fresh API call
            weatherHelper.clearCache();
            
            const mockForecastClear = {
                city: { coord: { lat: 59.9139, lon: 10.7522 }, name: 'Oslo', country: 'NO' },
                list: [
                    {
                        dt: Math.floor((Date.now() + 2 * 60 * 60 * 1000) / 1000), // 2 hours from now
                        main: { temp: 12.5, feels_like: 11.8, humidity: 60 },
                        weather: [{ main: 'Clear', description: 'clear sky', icon: '01d' }],
                        wind: { speed: 2.5 },
                        clouds: { all: 20 },
                        pop: 0.10
                    }
                ]
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
        const mockWeatherResponse = {
            coord: { lat: 59.9139, lon: 10.7522 },
            weather: [{ main: 'Clear', description: 'clear sky', icon: '01d' }],
            main: { temp: 15.5, feels_like: 14.2, humidity: 65, pressure: 1013 },
            wind: { speed: 3.2 },
            sys: { sunrise: 1694664000, sunset: 1694707200, country: 'NO' },
            name: 'Oslo'
        };

        it('should generate weather summary', async () => {
            // Clear cache to ensure fresh API call
            weatherHelper.clearCache();
            
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockWeatherResponse)
            });

            const summary = await weatherHelper.getWeatherSummary();

            expect(summary).toContain('15.5°C');
            expect(summary).toContain('clear sky');
            expect(summary).toContain('14.2°C');
            expect(summary).toContain('65%');
            expect(summary).toContain('3.2 m/s');
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
        it('should clear cache successfully', async () => {
            const mockResponse = {
                ok: true,
                json: () => Promise.resolve({
                    coord: { lat: 59, lon: 10 },
                    weather: [{ main: 'Clear', description: 'clear', icon: '01d' }],
                    main: { temp: 15, feels_like: 15, humidity: 50, pressure: 1000 },
                    wind: { speed: 2 },
                    sys: { sunrise: 1694664000, sunset: 1694707200, country: 'NO' },
                    name: 'Test'
                })
            };

            (global.fetch as any).mockResolvedValue(mockResponse);

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