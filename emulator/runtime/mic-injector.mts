// Feeds a pre-recorded clip into a booted device's voice pipeline as if the
// user had spoken it into the satellite's microphone: emits a synthetic
// 'starting' (wake) on the device's ESP client, then paces the 16 kHz PCM out
// as 'chunk' events exactly like VoiceAssistantAudio frames from the firmware.
//
// The device code runs unchanged — wake handling, mic-skip trimming, resampling
// to the provider rate, server VAD, tool calls and the reply path all execute
// for real. Padding makes that work:
// - leading silence covers the wake-turn skip budget (`initial_audio_skip`,
//   which exists to swallow the PE's wake ding) so none of the clip is trimmed;
// - trailing silence gives the provider's server VAD the quiet it needs to
//   declare end-of-speech — without it the turn would hang open, since unlike a
//   real satellite we stop sending audio when the clip ends.
import { MIC_SAMPLE_RATE } from './recordings.mjs';

const BYTES_PER_MS = (MIC_SAMPLE_RATE * 2) / 1000; // s16le mono
const CHUNK_BYTES = 1024;                          // = 32 ms, typical firmware frame
const CHUNK_MS = CHUNK_BYTES / BYTES_PER_MS;

const LEAD_SILENCE_MS = 200;    // on top of the skip budget; VAD likes a quiet run-up
const TRAIL_SILENCE_MS = 1500;  // > server-VAD silence threshold

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface InjectResult {
  ok: boolean;
  reason?: string;
  sentMs?: number;
}

/**
 * Push `pcm16k` (s16le mono 16 kHz) through `device`'s mic path. Resolves once
 * all audio has been sent — the transcript/reply then stream in asynchronously
 * (watch the CONVO log). Real-time paced so the turn behaves like live speech.
 */
export async function injectRecording(device: any, pcm16k: Buffer): Promise<InjectResult> {
  const esp = device?.esp;
  const turn = device?.turn;
  const provider = device?.provider;
  if (!esp || !turn) {
    return { ok: false, reason: 'device has no ESP client/turn state (not initialized?)' };
  }
  if (!provider?.isConnected?.()) {
    return { ok: false, reason: 'agent is not connected — check the API key / wait for "Agent connection opened"' };
  }
  if (!turn.canStartTurn()) {
    return { ok: false, reason: 'a turn is already in progress (mic is streaming)' };
  }

  // The wake handler arms this turn's skip budget from the device settings
  // (meant to swallow the PE's wake ding). Prepend that much silence so the
  // budget eats padding, not the beginning of the clip.
  const skipMs = Number(device.getSettings?.()?.initial_audio_skip ?? 0) || 0;
  const lead = silence(skipMs + LEAD_SILENCE_MS);
  const trail = silence(TRAIL_SILENCE_MS);
  const audio = Buffer.concat([lead, pcm16k, trail]);

  // Synthetic wake. The 'starting' handler runs synchronously up to arming the
  // mic gate, so chunks emitted right after are accepted. If a real satellite
  // is connected its state events are sent too — same as a real wake.
  esp.emit('starting');
  if (!turn.isListening) {
    return { ok: false, reason: 'device did not enter listening state (agent busy or not connected?)' };
  }

  for (let off = 0; off < audio.length; off += CHUNK_BYTES) {
    esp.emit('chunk', audio.subarray(off, off + CHUNK_BYTES));
    // Stop early if the provider's VAD already closed the mic — everything
    // after that would be dropped by the listening gate anyway.
    if (!turn.isListening) break;
    await sleep(CHUNK_MS);
  }

  return { ok: true, sentMs: Math.round(audio.length / BYTES_PER_MS) };
}

function silence(ms: number): Buffer {
  const bytes = Math.max(0, Math.round(ms * BYTES_PER_MS)) & ~1; // whole samples
  return Buffer.alloc(bytes);
}
