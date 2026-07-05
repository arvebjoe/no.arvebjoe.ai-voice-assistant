import VoiceAssistantDriver  from  '../../src/homey/voice-assistant-driver.mjs';
import ThirdRealityVoiceAndMusicAssistDevice from "./device.mjs";


export default class ThirdRealityVoiceAndMusicAssistDriver extends VoiceAssistantDriver{
    thisAssistantType: string = 'tr';

    constructor(...args: any[]) {
        super(...args);
    }
}
