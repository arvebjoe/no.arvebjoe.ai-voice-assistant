import VoiceAssistantDriver  from  '../../src/homey/voice-assistant-driver.mjs';


export default class HomeAssistantVoicePreviewEditionDriver extends VoiceAssistantDriver{
    thisAssistantType: string = 'pe';

    constructor(...args: any[]) {
        super(...args);
    }
}
