import VoiceAssistantDevice from '../../src/homey/voice-assistant-device.mjs';


export default class M5StackAtomS3rDevice extends VoiceAssistantDevice {
    // Playback goes through a speaker-platform media player with a FLAC
    // announcement pipeline (48 kHz) — the same design as the PE, so no
    // delay needed.
    readonly needDelayedPlayback: boolean = false;
    // No defaultMicGain override (base = 1x): the stock M5Stack config runs
    // the ESPHome software stages on-device (noise_suppression_level: 2,
    // auto_gain: 31dBFS, volume_multiplier: 2.0), so the streamed audio
    // should arrive at PE-like levels, not the TR's quiet feed.

    constructor(...args: any[]) {
        super(...args);
    }
}
