import Homey from 'homey';
import { createLogger } from '../../src/helpers/logger';
import { WebServer } from '../../src/helpers/webserver';
import { EspVoiceClient } from '../../src/voice_assistant/esphome_home_assistant_pe';

const log = createLogger('DEV.ESP');

interface DeviceStore {
  address: string;
  port: number;
  [key: string]: any;
}

class MyDevice extends Homey.Device {
  private espVoiceClient!: EspVoiceClient;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit(): Promise<void> {
    this.log('MyDevice has been initialized');


    this.registerCapabilityListener('onoff', async (value: boolean) => {
      this.log('Capability onoff changed to:', value);
      // Here you would typically send the command to the device
      // await this.sendCommandToDevice(value);
    });

    this.registerCapabilityListener('volume_set', async (value: number) => {
      this.log('Capability volume_set changed to:', value);
      // Here you would typically send the command to the device
      // await this.setVolumeOnDevice(value);
    });

    this.registerCapabilityListener('volume_mute', async (value: boolean) => {
      this.log('Capability volume_mute changed to:', value);
      // Here you would typically send the command to the device
      // await this.muteVolumeOnDevice(value);
    });


    const store = this.getStore() as DeviceStore;
    log.info('Device store:', 'INIT', store);

    // Initialize and start EspVoiceClient
    this.espVoiceClient = new EspVoiceClient({
      host: store.address,
      apiPort: store.port,
      webServer: (this.homey as any).app.webServer as InstanceType<typeof WebServer>
    });

    await this.espVoiceClient.start();
    log.info('ESP Voice Client initialized and connected');    
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded(): Promise<void> {
    this.log('MyDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.log("MyDevice settings where changed");
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string): Promise<void> {
    this.log('MyDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted(): Promise<void> {
    this.log('MyDevice has been deleted');
  }
}

export = MyDevice;
