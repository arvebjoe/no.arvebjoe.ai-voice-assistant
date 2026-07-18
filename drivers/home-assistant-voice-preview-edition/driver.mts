import VoiceAssistantDriver  from  '../../src/homey/voice-assistant-driver.mjs';


export default class HomeAssistantVoicePreviewEditionDriver extends VoiceAssistantDriver{
    thisAssistantType: string = 'pe';
    // PE BLE names differ from the mDNS/HA-app name and vary by firmware:
    // a factory PE (26.x) advertises "ha-voice-pe-093b27" over BLE while the
    // HA app shows "home-assistan-093b27" (truncated full name) for the same
    // unit. Self-compiled stock-yaml builds advertise their ESPHome device
    // name "home-assistant-voice-XXXXXX" (possibly truncated). Match both
    // families by their stable prefixes.
    protected improvNameFilter: RegExp | null = /home[-\s]?assistan|ha[-\s]?voice/i;

    constructor(...args: any[]) {
        super(...args);
    }
}
