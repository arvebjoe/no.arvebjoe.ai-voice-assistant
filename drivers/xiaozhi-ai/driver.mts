import VoiceAssistantDriver  from  '../../src/homey/voice_assistant_driver.mjs';


export default class XiaozhiAIDriver extends VoiceAssistantDriver {
    thisAssistantType: string = 'xiaozhi-ai';

    constructor(...args: any[]) {
        super(...args);
    }

};
