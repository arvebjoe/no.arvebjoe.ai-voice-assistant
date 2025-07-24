'use strict';

const Homey = require('homey');
const { createLogger } = require('./logger');
const { AudioStreamServer } = require('./webserver');

const log = createLogger('APP');

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MyApp has been initialized');
    log.info('App initialized successfully');
    
    // Set the known Homey IP address
    process.env.HOST_IP = '192.168.0.99';
    log.info(`Setting HOST_IP to ${process.env.HOST_IP}`);
    
    // Start the web server on port 8080 for development (more likely to be exposed)
    this.webServer = new AudioStreamServer(8080);
    await this.webServer.start();
  }

};
