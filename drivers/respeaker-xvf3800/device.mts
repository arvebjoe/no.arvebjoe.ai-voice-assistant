import VoiceAssistantDevice from '../../src/homey/voice-assistant-device.mjs';


export default class ReSpeakerXvf3800Device extends VoiceAssistantDevice {
    // Playback goes through a speaker_source media player with a FLAC
    // announcement pipeline — the same design as the PE, so no delay needed.
    readonly needDelayedPlayback: boolean = false;
    // No defaultMicGain override (base = 1x): the XMOS XVF3800 does AEC, AGC,
    // beamforming and noise suppression on-chip, and the ESPHome config
    // deliberately zeroes the software stages (noise_suppression_level: 0,
    // auto_gain: 0 dbfs). Expect PE-like levels, not the TR's quiet feed.

    constructor(...args: any[]) {
        super(...args);
    }
}
