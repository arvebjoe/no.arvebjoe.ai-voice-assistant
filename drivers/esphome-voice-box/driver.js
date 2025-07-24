'use strict';

const Homey = require('homey');
const { findEsphomeDevices } = require('../../voice_assistant/detect');


module.exports = class MyDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MyDriver has been initialized');
  }

  async onUninit(){
    this.log('MyDriver has been uninitialized');
    
    // If there are any active discovery sessions that need to be cleaned up
    // This is mostly a safety measure as pairing sessions should clean up themselves
    try {
      // Your detect.js module might need an explicit cleanup method if it keeps global state
      // For example: require('../../voice_assistant/detect').cleanup();
    } catch (error) {
      this.error('Error during driver cleanup:', error);
    }
  }

  async onPair(session) {
    // Store reference to any active discovery to clean up later
    let emitter = null;
    const discoveredDevices = new Map(); // Use Map to avoid duplicates (by ID)
    
    // Handle listing devices
    session.setHandler('list_devices', async () => {
      this.log('Starting ESPHome device discovery...');
      
      // Start discovery process with 20 second timeout
      emitter = findEsphomeDevices(20000);
      
      // Handle discovered devices
      emitter.on('device-found', (device) => {
        this.log('Found ESPHome device during pairing:', device.name);
            
          // Create device data in Homey's expected format
          const homeyDevice = {
            name: device.name,
            data: {
              id: device.id,
            },
            store: {
              address: device.address,
              port: device.port,
              mac: device.mac,
              project: device.project
            },
          };
          
          // Store device and emit to update the UI in real-time
          discoveredDevices.set(device.id, homeyDevice);
          
          // Send updated device list to the frontend
          session.emit('list_devices', Array.from(discoveredDevices.values()));
        
      });
      
      // Handle scan completion
      emitter.on('scan-complete', () => {
        this.log('ESPHome device discovery completed, found', discoveredDevices.size, 'compatible devices');
      });
      
      // Return initially empty list - it will be updated via emit() as devices are found
      return Array.from(discoveredDevices.values());
    });
    
    // Clean up when the pairing session ends
    session.setHandler('disconnect', async () => {
      this.log('Pairing session ended, cleaning up...');
      if (emitter) {
        emitter.stopScanning();
        emitter = null;
      }
    });
  }
};
