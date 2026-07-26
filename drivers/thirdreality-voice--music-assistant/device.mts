import VoiceAssistantDevice from '../../src/homey/voice-assistant-device.mjs';


export default class ThirdRealityVoiceAndMusicAssistDevice extends VoiceAssistantDevice {
    readonly needDelayedPlayback: boolean = false;
    // The TR's WebRTC-processed mic stream is much quieter than the PE's XMOS
    // feed — without gain the local VAD never detects speech (see base class).
    // Default only: the `mic_gain` device setting overrides it when set (> 0).
    readonly defaultMicGain: number = 4;

    constructor(...args: any[]) {
        super(...args);
    }
}
