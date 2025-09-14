import { describe, it, expect, beforeEach } from 'vitest';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';

describe('MockGeoHelper', () => {
    let mockGeoHelper: MockGeoHelper;

    beforeEach(() => {
        mockGeoHelper = new MockGeoHelper();
    });

    describe('Initialization', () => {
        it('should initialize successfully', async () => {
            expect(mockGeoHelper.latitude).toBeNull(); // Not initialized yet
            expect(mockGeoHelper.longitude).toBeNull();
            expect(mockGeoHelper.timezone).toBeNull();

            await mockGeoHelper.init();

            expect(mockGeoHelper.latitude).toBe(59.9139);
            expect(mockGeoHelper.longitude).toBe(10.7522);
            expect(mockGeoHelper.timezone).toBe('Europe/Oslo');
            expect(mockGeoHelper.initCallCount).toBe(1);
        });

        it('should fail initialization when configured to fail', async () => {
            mockGeoHelper.shouldFailInit = true;
            
            await expect(mockGeoHelper.init()).rejects.toThrow('Mock GeoHelper init failure');
            expect(mockGeoHelper.initCallCount).toBe(1);
        });
    });

    describe('Location Data', () => {
        beforeEach(async () => {
            await mockGeoHelper.init();
        });

        it('should provide location getters', () => {
            expect(mockGeoHelper.latitude).toBe(59.9139);
            expect(mockGeoHelper.longitude).toBe(10.7522);
            expect(mockGeoHelper.hasLocation()).toBe(true);
        });

        it('should provide coordinates as object and string', () => {
            const coords = mockGeoHelper.getCoordinates();
            expect(coords).toEqual({ latitude: 59.9139, longitude: 10.7522 });
            
            const coordsString = mockGeoHelper.getCoordinatesString();
            expect(coordsString).toBe('59.9139, 10.7522');
        });

        it('should handle location updates', () => {
            mockGeoHelper.setMockLocation(60.1699, 24.9384); // Helsinki
            
            expect(mockGeoHelper.latitude).toBe(60.1699);
            expect(mockGeoHelper.longitude).toBe(24.9384);
            expect(mockGeoHelper.getCoordinatesString()).toBe('60.1699, 24.9384');
            expect(mockGeoHelper.updateLocationCallCount).toBe(1);
        });

        it('should handle cleared location', () => {
            mockGeoHelper.clearLocation();
            
            expect(mockGeoHelper.latitude).toBeNull();
            expect(mockGeoHelper.longitude).toBeNull();
            expect(mockGeoHelper.hasLocation()).toBe(false);
            expect(mockGeoHelper.getCoordinatesString()).toBe('Location unknown');
        });
    });

    describe('Timezone Data', () => {
        beforeEach(async () => {
            await mockGeoHelper.init();
        });

        it('should provide timezone getter', () => {
            expect(mockGeoHelper.timezone).toBe('Europe/Oslo');
            expect(mockGeoHelper.hasTimezone()).toBe(true);
        });

        it('should handle timezone updates', () => {
            mockGeoHelper.setMockTimezone('America/New_York');
            
            expect(mockGeoHelper.timezone).toBe('America/New_York');
            expect(mockGeoHelper.updateTimezoneCallCount).toBe(1);
        });

        it('should handle cleared timezone', () => {
            mockGeoHelper.clearTimezone();
            
            expect(mockGeoHelper.timezone).toBeNull();
            expect(mockGeoHelper.hasTimezone()).toBe(false);
        });
    });

    describe('Combined Data', () => {
        beforeEach(async () => {
            await mockGeoHelper.init();
        });

        it('should provide combined location info', () => {
            const info = mockGeoHelper.getLocationInfo();
            expect(info).toEqual({
                latitude: 59.9139,
                longitude: 10.7522,
                timezone: 'Europe/Oslo',
                coordinatesString: '59.9139, 10.7522'
            });
        });

        it('should provide formatted info string', () => {
            const infoString = mockGeoHelper.getLocationInfoString();
            expect(infoString).toBe('59.9139, 10.7522 (Europe/Oslo)');
        });

        it('should handle partial data in info string', () => {
            mockGeoHelper.clearTimezone();
            const infoString = mockGeoHelper.getLocationInfoString();
            expect(infoString).toBe('59.9139, 10.7522 (Unknown timezone)');
        });
    });

    describe('Event Simulation', () => {
        beforeEach(async () => {
            await mockGeoHelper.init();
        });

        it('should simulate location change events', () => {
            let callbackCalled = false;
            mockGeoHelper.onLocationChange(() => {
                callbackCalled = true;
            });

            mockGeoHelper.simulateLocationChange(55.6761, 12.5683); // Copenhagen
            
            expect(callbackCalled).toBe(true);
            expect(mockGeoHelper.latitude).toBe(55.6761);
            expect(mockGeoHelper.longitude).toBe(12.5683);
        });

        it('should simulate timezone change events', () => {
            let callbackCalled = false;
            mockGeoHelper.onTimezoneChange(() => {
                callbackCalled = true;
            });

            mockGeoHelper.simulateTimezoneChange('Europe/Copenhagen');
            
            expect(callbackCalled).toBe(true);
            expect(mockGeoHelper.timezone).toBe('Europe/Copenhagen');
        });
    });

    describe('Refresh Operations', () => {
        beforeEach(async () => {
            await mockGeoHelper.init();
        });

        it('should handle refresh operations', async () => {
            await mockGeoHelper.refreshLocation();
            expect(mockGeoHelper.refreshLocationCallCount).toBe(1);

            await mockGeoHelper.refreshTimezone();
            expect(mockGeoHelper.refreshTimezoneCallCount).toBe(1);
        });

        it('should fail refresh when configured to fail', async () => {
            mockGeoHelper.shouldFailRefresh = true;
            
            await expect(mockGeoHelper.refreshLocation()).rejects.toThrow('Mock refresh failure');
            await expect(mockGeoHelper.refreshTimezone()).rejects.toThrow('Mock timezone refresh failure');
        });
    });

    describe('Test Utilities', () => {
        beforeEach(async () => {
            await mockGeoHelper.init();
        });

        it('should provide test statistics', () => {
            mockGeoHelper.setMockLocation(60, 10);
            mockGeoHelper.setMockTimezone('Europe/Berlin');
            
            const stats = mockGeoHelper.getStats();
            expect(stats).toEqual({
                initCallCount: 1,
                updateLocationCallCount: 1,
                updateTimezoneCallCount: 1,
                refreshLocationCallCount: 0,
                refreshTimezoneCallCount: 0,
                isInitialized: true,
                hasLocation: true,
                hasTimezone: true
            });
        });

        it('should reset to default state', async () => {
            await mockGeoHelper.init();
            mockGeoHelper.setMockLocation(60, 10);
            mockGeoHelper.setMockTimezone('Europe/Berlin');
            
            mockGeoHelper.reset();
            
            const stats = mockGeoHelper.getStats();
            expect(stats.initCallCount).toBe(0);
            expect(stats.isInitialized).toBe(false);
            
            // After reset, should have default values but not be initialized
            expect(mockGeoHelper.latitude).toBeNull(); // Not initialized
            expect(mockGeoHelper.longitude).toBeNull();
            expect(mockGeoHelper.timezone).toBeNull();
        });
    });
});