import VoiceAssistantDriver  from  '../../src/homey/voice_assistant_driver.mjs';


export default class HomeAssistantVoicePreviewEditionDriver extends VoiceAssistantDriver{
    thisAssistantType: string = 'pe';

    constructor(...args: any[]) {
        super(...args);
    }

  
}
