import Homey from 'homey';
import { createLogger } from '../../src/helpers/logger.mjs';
import { EspVoiceClient } from '../../src/voice_assistant/esphome_home_assistant_pe.mjs';

const log = createLogger('VA_DRIVER', false);

export default class VoiceAssistantDriver extends Homey.Driver {

}