'use strict';

import Homey from 'homey';
import { createLogger } from './src/helpers/logger.js';

const log = createLogger('APP');

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    log.info('AI voice assistant initialized successfully');
  }

}
