import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { Device, ZoneChanged } from '../src/helpers/interfaces.mjs';

describe('MockDeviceManager', () => {
  let mockDeviceManager: MockDeviceManager;

  beforeEach(() => {
    mockDeviceManager = new MockDeviceManager();
  });

  describe('Initialization', () => {
    it('should initialize successfully', async () => {
      await expect(mockDeviceManager.init()).resolves.not.toThrow();
      expect(mockDeviceManager.initCallCount).toBe(1);
    });

    it('should fail initialization when configured to fail', async () => {
      mockDeviceManager.shouldFailInit = true;
      await expect(mockDeviceManager.init()).rejects.toThrow('Mock init failure');
      expect(mockDeviceManager.initCallCount).toBe(1);
    });

    it('should fetch data successfully', async () => {
      await expect(mockDeviceManager.fetchData()).resolves.not.toThrow();
      expect(mockDeviceManager.fetchDataCallCount).toBe(1);
    });

    it('should fail fetch data when configured to fail', async () => {
      mockDeviceManager.shouldFailFetchData = true;
      await expect(mockDeviceManager.fetchData()).rejects.toThrow('Mock fetch data failure');
      expect(mockDeviceManager.fetchDataCallCount).toBe(1);
    });
  });

  describe('Zones and Device Types', () => {
    it('should return list of zones', () => {
      const zones = mockDeviceManager.getZones();
      expect(zones).toEqual(['Living Room', 'Kitchen', 'Bedroom', 'Office']);
      expect(zones.length).toBe(4);
    });

    it('should return list of device types', () => {
      const deviceTypes = mockDeviceManager.getAllDeviceTypes();
      expect(deviceTypes).toEqual(['light', 'socket', 'sensor', 'thermostat', 'speaker']);
      expect(deviceTypes.length).toBe(5);
    });

    it('should return independent copies of arrays', () => {
      const zones1 = mockDeviceManager.getZones();
      const zones2 = mockDeviceManager.getZones();
      
      zones1.push('Modified');
      expect(zones2).not.toContain('Modified');
    });
  });

  describe('Device Management', () => {
    it('should return all devices without filters', () => {
      const result = mockDeviceManager.getSmartHomeDevices();
      
      expect(result.devices).toHaveLength(15); // Now we have 15 devices total (13 + 2 new office lights)
      expect(result.next_page_token).toBeNull();
      
      const deviceNames = result.devices.map(d => d.name);
      expect(deviceNames).toContain('Living Room Main Light');
      expect(deviceNames).toContain('Kitchen Ceiling Light');
      expect(deviceNames).toContain('Bedroom Main Light');
      expect(deviceNames).toContain('Office Thermostat');
    });

    it('should filter devices by zone', () => {
      const result = mockDeviceManager.getSmartHomeDevices('Kitchen');
      
      expect(result.devices).toHaveLength(3); // Kitchen now has 3 devices
      expect(result.devices.every(d => d.zone === 'Kitchen')).toBe(true);
      
      const deviceNames = result.devices.map(d => d.name);
      expect(deviceNames).toContain('Kitchen Ceiling Light');
      expect(deviceNames).toContain('Kitchen Under Cabinet Lights');
      expect(deviceNames).toContain('Kitchen Coffee Machine');
    });

    it('should filter devices by type', () => {
      const result = mockDeviceManager.getSmartHomeDevices(undefined, 'light');
      
      expect(result.devices).toHaveLength(9); // Now we have 9 light devices (7 + 2 new office lights)
      const lightDevices = result.devices.filter(d => d.type === 'light');
      expect(lightDevices).toHaveLength(9);
    });

    it('should filter devices by both zone and type', () => {
      const result = mockDeviceManager.getSmartHomeDevices('Bedroom', 'light');
      
      expect(result.devices).toHaveLength(2); // Bedroom now has 2 light devices
      expect(result.devices.every(d => d.zone === 'Bedroom' && d.type === 'light')).toBe(true);
      
      const deviceNames = result.devices.map(d => d.name);
      expect(deviceNames).toContain('Bedroom Main Light');
      expect(deviceNames).toContain('Bedroom Bedside Lamp');
    });

    it('should return empty result for non-existent zone', () => {
      const result = mockDeviceManager.getSmartHomeDevices('NonExistent');
      
      expect(result.devices).toHaveLength(0);
      expect(result.next_page_token).toBeNull();
    });

    it('should return empty result for non-existent device type', () => {
      const result = mockDeviceManager.getSmartHomeDevices(undefined, 'nonexistent');
      
      expect(result.devices).toHaveLength(0);
      expect(result.next_page_token).toBeNull();
    });
  });

  describe('Pagination', () => {
    it('should handle pagination correctly', () => {
      // Get first page with page size 2
      const page1 = mockDeviceManager.getSmartHomeDevices(undefined, undefined, 2);
      
      expect(page1.devices).toHaveLength(2);
      expect(page1.next_page_token).toBe('2');
      
      // Get second page
      const page2 = mockDeviceManager.getSmartHomeDevices(undefined, undefined, 2, page1.next_page_token);
      
      expect(page2.devices).toHaveLength(2);
      expect(page2.next_page_token).toBe('4'); // Still more pages with 13 devices total
      
      // Verify no overlap
      const page1Ids = page1.devices.map(d => d.id);
      const page2Ids = page2.devices.map(d => d.id);
      const intersection = page1Ids.filter(id => page2Ids.includes(id));
      expect(intersection).toHaveLength(0);
    });

    it('should respect page size limits', () => {
      const tooSmall = mockDeviceManager.getSmartHomeDevices(undefined, undefined, 0);
      expect(tooSmall.devices).toHaveLength(1); // Should be clamped to 1
      
      const tooBig = mockDeviceManager.getSmartHomeDevices(undefined, undefined, 200);
      expect(tooBig.devices).toHaveLength(15); // Should return all 15 available devices
    });
  });

  describe('Device Registration', () => {
    it('should register device for zone change notifications', () => {
      const callback = vi.fn();
      const zone = mockDeviceManager.registerDevice('mac-001', callback);
      
      expect(zone).toBe('Living Room');
      expect(mockDeviceManager.getRegisteredDevicesCount()).toBe(1);
    });

    it('should return unknown zone for non-existent device', () => {
      const callback = vi.fn();
      const zone = mockDeviceManager.registerDevice('non-existent-mac', callback);
      
      expect(zone).toBe('<Unknown Zone>');
      expect(mockDeviceManager.getRegisteredDevicesCount()).toBe(0);
    });

    it('should unregister device correctly', () => {
      const callback = vi.fn();
      mockDeviceManager.registerDevice('mac-001', callback);
      expect(mockDeviceManager.getRegisteredDevicesCount()).toBe(1);
      
      mockDeviceManager.unRegisterDevice('mac-001');
      expect(mockDeviceManager.getRegisteredDevicesCount()).toBe(0);
    });

    it('should handle zone change simulation', () => {
      const callback = vi.fn();
      mockDeviceManager.registerDevice('mac-001', callback);
      
      mockDeviceManager.simulateDeviceZoneChange('device-1', 'New Zone');
      
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith({
        device: expect.objectContaining({
          id: 'device-1',
          zone: 'New Zone'
        }),
        oldZone: 'Living Room',
        newZone: 'New Zone'
      });
    });
  });

  describe('Device Capability Management', () => {
    it('should set device capability successfully', async () => {
      const result = await mockDeviceManager.setDeviceCapability('device-1', 'onoff', false);
      
      expect(result.status).toBe('success');
      expect(result.deviceId).toBe('device-1');
      expect(result.error).toBeUndefined();
      
      // Verify capability was updated in mock data
      const devices = mockDeviceManager.getSmartHomeDevices();
      const device = devices.devices.find(d => d.id === 'device-1');
      expect(device?.capabilities).toContain('onoff=false');
    });

    it('should fail capability setting when configured to fail', async () => {
      mockDeviceManager.shouldFailSetCapability = true;
      
      const result = await mockDeviceManager.setDeviceCapability('device-1', 'onoff', false);
      
      expect(result.status).toBe('error');
      expect(result.deviceId).toBe('device-1');
      expect(result.error).toBe('Mock capability set failure');
    });

    it('should set bulk device capabilities', async () => {
      const deviceIds = ['device-1', 'device-3']; // Both lights
      const results = await mockDeviceManager.setDeviceCapabilityBulk(deviceIds, 'dim', 0.8);
      
      expect(results).toHaveLength(2);
      results.forEach(result => {
        expect(result.status).toBe('success');
        expect(deviceIds).toContain(result.deviceId);
      });
      
      // Verify both devices were updated
      const devices = mockDeviceManager.getSmartHomeDevices(undefined, 'light');
      devices.devices.forEach(device => {
        if (deviceIds.includes(device.id)) {
          expect(device.capabilities).toContain('dim=0.8');
        }
      });
    });

    it('should add new capability if it does not exist', async () => {
      const result = await mockDeviceManager.setDeviceCapability('device-2', 'new_capability', 'test_value');
      
      expect(result.status).toBe('success');
      
      const devices = mockDeviceManager.getSmartHomeDevices();
      const device = devices.devices.find(d => d.id === 'device-2');
      expect(device?.capabilities).toContain('new_capability=test_value');
    });
  });

  describe('Helper Methods', () => {
    it('should add new device correctly', () => {
      const newDevice: Device = {
        id: 'device-999',
        name: 'Test Device',
        zone: 'Test Zone',
        zones: ['Test Zone'],
        type: 'test',
        capabilities: ['onoff=true'],
        dataId: 'mac-999'
      };
      
      mockDeviceManager.addDevice(newDevice);
      
      const devices = mockDeviceManager.getSmartHomeDevices();
      expect(devices.devices).toHaveLength(16); // 15 + 1 new device
      expect(devices.devices.find(d => d.id === 'device-999')).toEqual(newDevice);
    });

    it('should remove device correctly', () => {
      mockDeviceManager.removeDevice('device-1');
      
      const devices = mockDeviceManager.getSmartHomeDevices();
      expect(devices.devices).toHaveLength(14); // 15 - 1 removed device
      expect(devices.devices.find(d => d.id === 'device-1')).toBeUndefined();
    });

    it('should clear all devices', () => {
      mockDeviceManager.clearDevices();
      
      const devices = mockDeviceManager.getSmartHomeDevices();
      expect(devices.devices).toHaveLength(0);
    });

    it('should reset to initial state', () => {
      // Modify state
      mockDeviceManager.shouldFailInit = true;
      mockDeviceManager.initCallCount = 5;
      mockDeviceManager.clearDevices();
      
      // Reset
      mockDeviceManager.reset();
      
      // Verify reset
      expect(mockDeviceManager.shouldFailInit).toBe(false);
      expect(mockDeviceManager.initCallCount).toBe(0);
      expect(mockDeviceManager.getSmartHomeDevices().devices).toHaveLength(15); // Back to 15 devices
    });
  });
});
