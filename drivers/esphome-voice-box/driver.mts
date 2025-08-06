import Homey from 'homey';
import * as Bonjour from 'bonjour-service';
import { createLogger } from '../../src/helpers/logger.mjs';


const log = createLogger('DRV.ESP');
const bonjourInstance = new Bonjour.Bonjour();

interface Device {
  name: string;
  data: {
    id: string;
  };
  store: {
    address: string;
    port: number;
    mac: string;
    platform: string;
    project: string;
    serviceName: string;
  };
}

export default class MyDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit(): Promise<void> {
    this.log('MyDriver has been initialized');
  }

  async onPair(session: any): Promise<void> {

    const deviceList: Device[] = [];

    session.setHandler('list_devices', async () => {
      this.log('Starting ESPHome device discovery...');


      const browser = bonjourInstance.find(
        { type: 'esphomelib', protocol: 'tcp' },
        (service: any) => {

          const device: Device = {
            name: service.txt?.friendly_name || service.name || 'Unknown',
            data: {
              id: service.txt?.mac || service.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
            },
            store: {
              address: service.addresses?.find((addr: string) => addr.includes('.')) || 'Unknown',
              port: service.port || 6053,
              mac: service.txt?.mac || 'Unknown',
              platform: service.txt?.platform || 'Unknown',
              project: service.txt?.project_name || 'Unknown',
              serviceName: service.name || 'Unknown',
            },
          };

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
      return new Promise<Device[]>((resolve) => {
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

}
