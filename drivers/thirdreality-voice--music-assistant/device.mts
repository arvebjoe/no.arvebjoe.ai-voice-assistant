import VoiceAssistantDevice from '../../src/homey/voice-assistant-device.mjs';


export default class ThirdRealityVoiceAndMusicAssistDevice extends VoiceAssistantDevice {
    readonly needDelayedPlayback: boolean = false;

    constructor(...args: any[]) {
        super(...args);
    }
}
