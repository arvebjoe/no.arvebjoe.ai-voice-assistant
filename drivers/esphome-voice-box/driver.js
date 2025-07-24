'use strict';

const Homey = require('homey');
const pkg = require('bonjour-service');
const { createLogger } = require('../../logger');


const log = createLogger('DRV.ESP');
const bonjourInstance = new pkg.Bonjour();


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

    const deviceList = [];

    session.setHandler('list_devices', async () => {
      this.log('Starting ESPHome device discovery...');
      

      const browser = bonjourInstance.find(
        { type: 'esphomelib', protocol: 'tcp' },
        (service) => {
          
          const device = {
            name: service.txt?.friendly_name || service.name || 'Unknown',
            data: {
              id: service.txt?.mac || service.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
            },
            store: {
              address: service.addresses?.find(addr => addr.includes('.')) || 'Unknown',
              port: service.port || 6053,
              mac: service.txt?.mac || 'Unknown',
              platform: service.txt?.platform || 'Unknown',
              project: service.txt?.project_name || 'Unknown',
              serviceName: service.name || 'Unknown'
            },
          };

                // TODO: Add more filtering here
          const isVoice = device.name.toLowerCase().includes('voice') 
                          || device.store.project.toLowerCase().includes('voice') 
                          || device.store.serviceName.toLowerCase().includes('voice');
          if (!isVoice) {
            log.log(`Skipping non-voice device: ${device.name}`, 'MDNS');
            return; // Skip non-voice devices
          }

          deviceList.push(device);
          
          // Send updated device list to the frontend
          session.emit('list_devices', deviceList);            
  
        }
      );

      // Wait for 10 seconds to allow devices to be discovered
      return new Promise(resolve => {
        log.log('Waiting 10 seconds for device discovery to complete...');
        
        // Set a timeout to resolve after 10 seconds
        setTimeout(() => {
          // Stop the browser/discovery process
          browser.stop();
          
          log.log(`Device discovery complete. Found ${deviceList.length} devices.`);
   
          resolve(deviceList);
        }, 10000); // 10 seconds
      })
      
    });
    

  }
};
