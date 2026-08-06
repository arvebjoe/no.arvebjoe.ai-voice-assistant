import VoiceAssistantDriver  from  '../../src/homey/voice-assistant-driver.mjs';


export default class M5StackAtomS3rDriver extends VoiceAssistantDriver {
    thisAssistantType: string = 'm5stack';
    // No BLE provisioning: M5Stack's official ESPHome config has no
    // esp32_improv component, and the firmware is flashed over USB with the
    // Wi-Fi credentials already baked in — the device never advertises
    // Improv. This driver's pair flow omits the improv_setup view entirely.
    protected improvNameFilter: RegExp | null = null;
    // This driver's pair flow has the manual_entry + encryption_check views,
    // so encrypted devices are listed and route there for their key.
    protected supportsEncryptedPairing = true;

    constructor(...args: any[]) {
        super(...args);
    }
}
