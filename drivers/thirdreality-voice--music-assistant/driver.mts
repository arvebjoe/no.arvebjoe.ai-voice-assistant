import VoiceAssistantDriver  from  '../../src/homey/voice-assistant-driver.mjs';
import ThirdRealityVoiceAndMusicAssistDevice from "./device.mjs";


export default class ThirdRealityVoiceAndMusicAssistDriver extends VoiceAssistantDriver{
    thisAssistantType: string = 'tr';
    // TR advertises as "3RSPK-XXXXX Improv via BLE" while waiting for setup.
    protected improvNameFilter: RegExp | null = /3rspk|thirdreality/i;

    constructor(...args: any[]) {
        super(...args);
    }
}
