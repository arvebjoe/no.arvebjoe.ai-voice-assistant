import VoiceAssistantDriver  from  '../../src/homey/voice-assistant-driver.mjs';


export default class XiaozhiAIDriver extends VoiceAssistantDriver {
    thisAssistantType: string = 'xiaozhi';

    constructor(...args: any[]) {
        super(...args);
    }

};
