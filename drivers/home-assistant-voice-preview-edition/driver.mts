import VoiceAssistantDriver  from  '../../src/homey/voice-assistant-driver.mjs';


export default class HomeAssistantVoicePreviewEditionDriver extends VoiceAssistantDriver{
    thisAssistantType: string = 'pe';

    constructor(...args: any[]) {
        super(...args);
    }

    async onInit(){
        super.onInit();

        const card = this.homey.flow.getActionCard('mute');
        card.registerRunListener(async (args, state) => {
            await args.device.mute();
            // Handle the mute action
        });
    }


}
