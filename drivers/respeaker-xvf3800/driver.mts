import VoiceAssistantDriver  from  '../../src/homey/voice-assistant-driver.mjs';


export default class ReSpeakerXvf3800Driver extends VoiceAssistantDriver {
    thisAssistantType: string = 'respeaker';
    // No BLE provisioning: the community ESPHome config has no esp32_improv
    // component (its improv_* globals are leftover LED state copied from the
    // PE config), and the firmware is flashed over USB with the Wi-Fi
    // credentials already baked in — so the device is never advertising
    // Improv. This driver's pair flow omits the improv_setup view entirely.
    protected improvNameFilter: RegExp | null = null;
    // This driver's pair flow has the manual_entry + encryption_check views,
    // so encrypted devices are listed and route there for their key.
    protected supportsEncryptedPairing = true;

    constructor(...args: any[]) {
        super(...args);
    }
}
