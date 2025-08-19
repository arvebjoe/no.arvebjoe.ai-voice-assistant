import Homey from 'homey';
import * as Bonjour from 'bonjour-service';
import { createLogger } from '../../src/helpers/logger.mjs';
import { EspVoiceClient } from '../../src/voice_assistant/esphome_home_assistant_pe.mjs';


const log = createLogger('DRIVER');
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

export default class EspVoiceDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit(): Promise<void> {
    log.info('EspVoiceDriver has been initialized');
  }

  async onPair(session: any): Promise<void> {

    const deviceList: Device[] = [];

    session.setHandler('list_devices', async () => {
      log.info('Starting ESPHome device discovery...');


      const browser = bonjourInstance.find(
        { type: 'esphomelib', protocol: 'tcp' },
        async (service: any) => {          

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

          if(!device.store.platform.toLocaleLowerCase().includes('esp32')) {
            log.log(`Skipping none-esp32 device: ${device.name}`, 'onPair');
            return; 
          }

          
          let client : EspVoiceClient | null = new EspVoiceClient({host: device.store.address, apiPort: device.store.port});  

          client.on('capabilities', async (mediaPlayersCount, subscribeVoiceAssistantCount, voiceAssistantConfigurationCount) => {
            
            // TODO: Need to pass type of device, Nabu (PE) or xiaozhi
            log.info(`ESP Voice Client capabilities received from ${device.name}:`,'onPair', {
              mediaPlayersCount,
              subscribeVoiceAssistantCount,
              voiceAssistantConfigurationCount
            });

            if(mediaPlayersCount > 0 && subscribeVoiceAssistantCount > 0 && voiceAssistantConfigurationCount > 0) {
              deviceList.push(device);
              session.emit('list_devices', deviceList);

              if(client) {
                await client.disconnect();
                client = null;
              }
              
            }
          });

          await client.start();

          setTimeout(async () => {
            if(client) {
              await client.disconnect();
              client = null;
            }
          }, 5000);

 
        }
      );

      // Wait for 30 seconds to allow devices to be discovered
      return new Promise<Device[]>((resolve) => {
        log.info('Waiting 30 seconds for device discovery to complete...');

        // Set a timeout to resolve after 30 seconds
        setTimeout(() => {
          // Stop the browser/discovery process
          browser.stop();

          log.info(`Device discovery complete. Found ${deviceList.length} devices.`);

          resolve(deviceList);
        }, 30_000); // 30 seconds
      })

    });


  }

}
