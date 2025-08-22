import Homey from 'homey';
import { createLogger } from '../helpers/logger.mjs';
import { WebServer } from '../helpers/webserver.mjs';
import { EspVoiceClient } from '../voice_assistant/esphome_home_assistant_pe.mjs';
import { DeviceManager } from '../helpers/device-manager.mjs';
//import { transcribe } from '../../src/speech_to_text/openai_stt.mjs';
//import { synthesize } from '../../src/text_to_speech/openai-tts.mjs';
//import { ToolMaker } from '../../src/llm/toolMaker.mjs';
import { settingsManager } from '../settings/settings-manager.mjs';
import { OpenAIRealtimeWS, RealtimeOptions } from '../llm/OpenAIRealtimeWS.mjs';
import { pcmToWavBuffer, pcmToFlacBuffer } from '../helpers/audio-encoders.mjs';
//import { AudioData } from '../../src/helpers/interfaces.mjs';
import { PcmSegmenter } from '../helpers/pcm-segmenter.mjs';
import { AudioData } from '../helpers/interfaces.mjs';
import { ToolManager } from '../llm/ToolManager.mjs';

const log = createLogger('VA_DEVICE', false);

export default abstract class VoiceAssistantDevice extends Homey.Device {

}