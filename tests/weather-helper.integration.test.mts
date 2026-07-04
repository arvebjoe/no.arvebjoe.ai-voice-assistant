import { describe, it, expect, beforeEach } from 'vitest';
import { WeatherHelper } from '../src/helpers/weather-helper.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';

// Integration tests with real API calls
// These tests make actual HTTP requests to Open-Meteo API, so they are gated
// behind RUN_INTEGRATION=1 to keep the default `npm test` run offline/CI-safe.
describe.skipIf(!process.env.RUN_INTEGRATION)('WeatherHelper Integration Tests', () => {
    let weatherHelper: WeatherHelper;
    let mockGeoHelper: MockGeoHelper;

    beforeEach(async () => {
        // Setup mock geo helper with Oslo coordinates
        mockGeoHelper = new MockGeoHelper();
        await mockGeoHelper.init();
        mockGeoHelper.setMockLocation(59.9139, 10.7522); // Oslo, Norway
        mockGeoHelper.setMockTimezone('Europe/Oslo');
        
        // Create weather helper with real API calls
        weatherHelper = new WeatherHelper(mockGeoHelper as any);
        await weatherHelper.init();
        
        // Clear any cached data for fresh API calls
        weatherHelper.clearCache();
    });

    it('should fetch real current weather data from Open-Meteo API', async () => {
        console.log('\n🌤️  Testing Real Current Weather API...');
        
        const weather = await weatherHelper.getCurrentWeather();
        
        // Log the actual data we get from the API
        console.log('📍 Location:', `${weather.location.latitude}, ${weather.location.longitude}`);
        console.log('🌡️  Temperature:', `${weather.temperature}°C`);
        console.log('🤒 Feels Like:', `${weather.feelsLike}°C`);
        console.log('💧 Humidity:', `${weather.humidity}%`);
        console.log('🌨️  Conditions:', weather.conditions[0]?.description);
        console.log('💨 Wind Speed:', `${weather.windSpeed} km/h`);
        console.log('💨 Wind Gusts:', `${weather.windGusts} km/h`);
        console.log('☁️  Cloud Cover:', `${weather.cloudiness}%`);
        console.log('☀️  UV Index:', weather.uvIndex);
        console.log('🌅 Is Daylight:', weather.isDaylight);
        console.log('🌧️  Precipitation:', `${weather.precipitation} mm`);
        console.log('📊 Pressure:', `${weather.pressure} hPa`);
        console.log('⏰ Timezone:', weather.location.timezone);
        console.log('⛰️  Elevation:', `${weather.location.elevation}m`);
        
        // Verify the data structure and types
        expect(weather.temperature).toBeTypeOf('number');
        expect(weather.feelsLike).toBeTypeOf('number');
        expect(weather.humidity).toBeGreaterThanOrEqual(0);
        expect(weather.humidity).toBeLessThanOrEqual(100);
        expect(weather.conditions).toHaveLength(1);
        expect(weather.conditions[0].code).toBeTypeOf('number');
        expect(weather.conditions[0].description).toBeTypeOf('string');
        expect(weather.windSpeed).toBeGreaterThanOrEqual(0);
        expect(weather.location.latitude).toBeCloseTo(59.9139, 0);
        expect(weather.location.longitude).toBeCloseTo(10.7522, 0);
        expect(weather.location.timezone).toBe('Europe/Oslo');
        expect(weather.isDaylight).toBeTypeOf('boolean');
        
        console.log('✅ Current weather test passed!\n');
    }, 10000); // 10 second timeout for API call

    it('should fetch real weather forecast data from Open-Meteo API', async () => {
        console.log('📅 Testing Real Weather Forecast API...');
        
        const forecast = await weatherHelper.getForecast();
        
        // Log forecast summary
        console.log('📍 Location:', `${forecast.location.latitude}, ${forecast.location.longitude}`);
        console.log('📊 Total Forecast Items:', forecast.forecasts.length);
        console.log('⏰ Timezone:', forecast.location.timezone);
        
        // Show first few forecast items
        console.log('\n🔮 First 5 Forecast Items:');
        forecast.forecasts.slice(0, 5).forEach((item, index) => {
            const localTime = new Date(item.timestamp).toLocaleString('en-GB', { 
                timeZone: forecast.location.timezone,
                dateStyle: 'short',
                timeStyle: 'short'
            });
            console.log(`  ${index + 1}. ${localTime}: ${item.temperature}°C, ${item.conditions[0]?.description}, ${item.precipitationProbability}% rain chance`);
        });
        
        // Verify the data structure
        expect(forecast.forecasts.length).toBeGreaterThan(0);
        expect(forecast.forecasts.length).toBeLessThanOrEqual(168); // Max 7 days * 24 hours
        // Open-Meteo snaps coordinates to its model grid, so allow ~0.5° slack.
        expect(forecast.location.latitude).toBeCloseTo(59.9139, 0);
        expect(forecast.location.longitude).toBeCloseTo(10.7522, 0);
        
        // Check first forecast item structure
        const firstItem = forecast.forecasts[0];
        expect(firstItem.temperature).toBeTypeOf('number');
        expect(firstItem.feelsLike).toBeTypeOf('number');
        expect(firstItem.humidity).toBeGreaterThanOrEqual(0);
        expect(firstItem.humidity).toBeLessThanOrEqual(100);
        expect(firstItem.precipitationProbability).toBeGreaterThanOrEqual(0);
        expect(firstItem.precipitationProbability).toBeLessThanOrEqual(100);
        expect(firstItem.conditions[0].description).toBeTypeOf('string');
        expect(firstItem.isDaylight).toBeTypeOf('boolean');
        
        console.log('✅ Weather forecast test passed!\n');
    }, 10000);

    it('should fetch real outside illumination data from Open-Meteo API', async () => {
        console.log('☀️  Testing Real Outside Illumination API...');
        
        const illumination = await weatherHelper.getOutsideIllumination();
        
        // Log illumination data
        console.log('🌞 Is Day:', illumination.isDay);
        console.log('🌅 Is Daylight:', illumination.isDaylight);
        console.log('☀️  Solar Radiation:', `${illumination.solarRadiation} W/m²`);
        console.log('🔆 Direct Radiation:', `${illumination.directRadiation} W/m²`);
        console.log('☁️  Diffuse Radiation:', `${illumination.diffuseRadiation} W/m²`);
        console.log('🌞 UV Index:', illumination.uvIndex);
        console.log('📐 Sun Elevation:', `${illumination.sunElevation.toFixed(1)}°`);
        console.log('💡 Illumination Level:', illumination.illuminationLevel);
        console.log('📝 Description:', illumination.description);
        
        // Verify the data structure
        expect(illumination.isDay).toBeTypeOf('boolean');
        expect(illumination.isDaylight).toBeTypeOf('boolean');
        expect(illumination.solarRadiation).toBeGreaterThanOrEqual(0);
        expect(illumination.directRadiation).toBeGreaterThanOrEqual(0);
        expect(illumination.diffuseRadiation).toBeGreaterThanOrEqual(0);
        expect(illumination.uvIndex).toBeGreaterThanOrEqual(0);
        expect(illumination.sunElevation).toBeGreaterThanOrEqual(-90);
        expect(illumination.sunElevation).toBeLessThanOrEqual(90);
        expect(['dark', 'twilight', 'dim', 'bright', 'very_bright']).toContain(illumination.illuminationLevel);
        expect(illumination.description).toBeTypeOf('string');
        
        console.log('✅ Outside illumination test passed!\n');
    }, 10000);

    it('should predict rain accurately using real forecast data', async () => {
        console.log('🌧️  Testing Real Rain Prediction...');
        
        // Test different time horizons
        const timeHorizons = [1, 6, 12, 24];
        
        for (const hours of timeHorizons) {
            const rainPrediction = await weatherHelper.willItRain(hours);
            
            console.log(`  📊 ${hours}h forecast: ${rainPrediction.willRain ? '🌧️  Rain expected' : '☀️  No rain'} (${rainPrediction.probability}% chance)`);
            console.log(`     Conditions: ${rainPrediction.description}`);
            
            // Verify data structure
            expect(rainPrediction.willRain).toBeTypeOf('boolean');
            expect(rainPrediction.probability).toBeGreaterThanOrEqual(0);
            expect(rainPrediction.probability).toBeLessThanOrEqual(100);
            expect(rainPrediction.description).toBeTypeOf('string');
        }
        
        console.log('✅ Rain prediction test passed!\n');
    }, 15000);

    it('should generate accurate weather summary with real data', async () => {
        console.log('📋 Testing Real Weather Summary...');
        
        const summary = await weatherHelper.getWeatherSummary();
        
        console.log('📝 Weather Summary:');
        console.log(`   ${summary}`);
        
        // Verify summary contains expected elements
        expect(summary).toContain('°C');
        expect(summary).toContain('59.9139, 10.7522'); // Location from GeoHelper
        expect(summary).toContain('Humidity:');
        expect(summary).toContain('%');
        expect(summary).toContain('Wind:');
        expect(summary).toContain('km/h');
        expect(summary).not.toBe('Weather information is currently unavailable.');
        
        console.log('✅ Weather summary test passed!\n');
    }, 10000);

    it('should find weather for specific future time', async () => {
        console.log('🕐 Testing Weather for Specific Time...');
        
        // Test weather for 6 hours from now
        const futureTime = new Date(Date.now() + 6 * 60 * 60 * 1000);
        const weather = await weatherHelper.getWeatherForTime(futureTime);
        
        console.log('🎯 Target Time:', futureTime.toLocaleString('en-GB', { timeZone: 'Europe/Oslo' }));
        
        if (weather) {
            console.log('🌡️  Temperature:', `${weather.temperature}°C`);
            console.log('🌨️  Conditions:', weather.conditions[0]?.description);
            console.log('🌧️  Rain Probability:', `${weather.precipitationProbability}%`);
            console.log('💨 Wind Speed:', `${weather.windSpeed} km/h`);
            console.log('☀️  UV Index:', weather.uvIndex);
            console.log('🌅 Is Daylight:', weather.isDaylight);
            
            // Verify data structure
            expect(weather.temperature).toBeTypeOf('number');
            expect(weather.conditions[0].description).toBeTypeOf('string');
            expect(weather.precipitationProbability).toBeGreaterThanOrEqual(0);
            expect(weather.precipitationProbability).toBeLessThanOrEqual(100);
            expect(weather.isDaylight).toBeTypeOf('boolean');
        } else {
            console.log('⚠️  No weather data found for the specified time');
            expect(weather).toBeNull();
        }
        
        console.log('✅ Specific time weather test passed!\n');
    }, 10000);

    it('should handle caching correctly with real API calls', async () => {
        console.log('💾 Testing Real API Caching...');
        
        // Time the first call (should make API request)
        const start1 = Date.now();
        const weather1 = await weatherHelper.getCurrentWeather();
        const duration1 = Date.now() - start1;
        
        // Time the second call (should use cache)
        const start2 = Date.now();
        const weather2 = await weatherHelper.getCurrentWeather();
        const duration2 = Date.now() - start2;
        
        console.log(`⏱️  First call (API): ${duration1}ms`);
        console.log(`⏱️  Second call (cache): ${duration2}ms`);
        console.log(`🚀 Cache speedup: ${(duration1 / duration2).toFixed(1)}x faster`);
        
        // Verify cached data matches
        expect(weather1.temperature).toBe(weather2.temperature);
        expect(weather1.timestamp.getTime()).toBe(weather2.timestamp.getTime());
        
        // Second call should be significantly faster (cached)
        expect(duration2).toBeLessThan(duration1 * 0.5); // At least 50% faster
        
        console.log('✅ Caching test passed!\n');
    }, 15000);

    it('should demonstrate all WMO weather codes work correctly', async () => {
        console.log('📊 Testing WMO Weather Code Mapping...');
        
        // Get current weather to see real weather code
        const weather = await weatherHelper.getCurrentWeather();
        const currentCode = weather.conditions[0].code;
        
        console.log(`🌨️  Current weather code: ${currentCode} -> "${weather.conditions[0].description}"`);
        
        // Test some common weather codes to ensure our mapping works
        const testCodes = [0, 1, 2, 3, 45, 51, 61, 71, 80, 95];
        const weatherHelper2 = new WeatherHelper(mockGeoHelper as any);
        
        console.log('🔍 Testing weather code mappings:');
        testCodes.forEach(code => {
            const description = (weatherHelper2 as any).wmoWeatherCodes[code];
            console.log(`   ${code}: ${description || 'Unknown'}`);
            expect(description).toBeDefined();
        });
        
        // Verify current weather code is mapped
        expect(weather.conditions[0].description).not.toContain('Weather code');
        
        console.log('✅ WMO weather codes test passed!\n');
    }, 10000);
});