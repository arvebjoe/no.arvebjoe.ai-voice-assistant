import VoiceAssistantDevice from '../../src/homey/voice-assistant-device.mjs';


export default class XiaozhiAIDevice extends VoiceAssistantDevice {
    readonly needDelayedPlayback: boolean = true;
    
    constructor(...args: any[]) {
        super(...args);
    }
}
