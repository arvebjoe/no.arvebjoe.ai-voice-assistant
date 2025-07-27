'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { createLogger } = require('./src/helpers/logger');
const { WebServer } = require('./src/helpers/webserver');

const log = createLogger('APP');

module.exports = class AiVoiceAssistantApp extends Homey.App {


  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    log.info('AI voice assistant initialized successfully');
      
    await this.test();

    // Initialize and start WebServer
    this.webServer = new WebServer(7709);
    await this.webServer.start();


  }

  async test(){
    log.info('Testing started');
 
    this.api = await HomeyAPI.createAppAPI({ homey: this.homey });

    // Fetch everything concurrently
    const [devices, zones] = await Promise.all([
      this.api.devices.getDevices(),     // Map<string, Device>
      this.api.zones.getZones(),         // Map<string, Zone>
    ]);

    // Pretty-print: Zone → Device → Capabilities
    Object.values(zones).forEach(zone => {
      log.info(`📂  ${zone.name}  (id: ${zone.id})`);
      const inZone = Object.values(devices).filter(d => d.zone === zone.id);

      if (!inZone.length) {
        log.info('   — no devices —');
        return;
      }

      inZone.forEach(dev => {
        // dev.capabilities   → [ 'onoff', 'measure_temperature', … ]
        // dev.capabilitiesObj→ { onoff:{ value:true,… }, … } :contentReference[oaicite:1]{index=1}
        log.info(`   • ${dev.name}`);
        for (const capId of dev.capabilities) {
          const val = dev.capabilitiesObj?.[capId]?.value;   // boolean | number | string
          log.info(`       – ${capId}: ${val}`);
        }        
        //const val = device.capabilitiesObj?.[capId]?.value;   // boolean | number | string
        //dev.capabilities.forEach(cap => log.info(`       – ${cap}`));
      });
    });
    

    log.info('Testing completed'); 
  }


  async onUninit() {
    log.info('AI voice assistant is being uninitialized');
    
    // Clean up WebServer
    if (this.webServer) {
      await this.webServer.stop();
      this.webServer = null;
      log.info('WebServer stopped');
    }
  }


};
