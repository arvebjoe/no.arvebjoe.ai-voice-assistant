// Pre-recorded voice clips for the `mic` console command. Clips live in
// emulator/recordings/ as FLAC (or WAV) and are decoded + normalized here to
// what the ESP satellite's microphone produces: PCM s16le mono 16 kHz.
//
// FLAC decoding uses libflacjs (already a dependency — the app encodes replies
// with it); WAV is parsed by hand. Anything is downmixed to mono and
// linearly resampled to 16 kHz, so recordings made at 24/44.1/48 kHz work too.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, basename } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FlacFactory = require('libflacjs');
const Flac = FlacFactory();
const { Decoder } = require('libflacjs/lib/decoder');

const __dirname = dirname(fileURLToPath(import.meta.url));
export const recordingsDir = resolve(__dirname, '../recordings');

export const MIC_SAMPLE_RATE = 16000;

export interface DecodedRecording {
  /** PCM s16le mono at MIC_SAMPLE_RATE. */
  pcm: Buffer;
  /** Source format details, for the console printout. */
  sourceRate: number;
  sourceChannels: number;
  durationMs: number;
}

let flacReady: Promise<void> | null = null;
function ensureFlacReady(): Promise<void> {
  if (!flacReady) {
    flacReady = new Promise<void>((res) => {
      if (Flac.isReady()) res();
      else Flac.on('ready', () => res());
    });
  }
  return flacReady;
}

/** List playable clips in emulator/recordings/ (relative names, sorted). */
export function listRecordings(): string[] {
  if (!existsSync(recordingsDir)) return [];
  return readdirSync(recordingsDir)
    .filter((f) => ['.flac', '.wav'].includes(extname(f).toLowerCase()))
    .sort();
}

/**
 * Resolve a user-typed clip name to a full path. Accepts the exact file name,
 * a name without extension, or a unique prefix.
 */
export function resolveRecording(query: string): string | null {
  const files = listRecordings();
  const q = query.toLowerCase();
  const match = files.find((f) => f.toLowerCase() === q)
    ?? files.find((f) => basename(f, extname(f)).toLowerCase() === q)
    ?? files.find((f) => f.toLowerCase().startsWith(q));
  return match ? resolve(recordingsDir, match) : null;
}

export async function loadRecording(path: string): Promise<DecodedRecording> {
  const raw = readFileSync(path);
  const ext = extname(path).toLowerCase();

  const { samples, sampleRate, channels } = ext === '.wav'
    ? decodeWav(raw)
    : await decodeFlac(raw);

  const mono = channels === 1 ? samples : downmix(samples, channels);
  const pcm16k = sampleRate === MIC_SAMPLE_RATE ? mono : resampleLinear(mono, sampleRate, MIC_SAMPLE_RATE);

  return {
    pcm: int16ToBuffer(pcm16k),
    sourceRate: sampleRate,
    sourceChannels: channels,
    durationMs: Math.round((pcm16k.length / MIC_SAMPLE_RATE) * 1000),
  };
}

// ---- decoders ---------------------------------------------------------------

async function decodeFlac(flacData: Buffer): Promise<{ samples: Int16Array; sampleRate: number; channels: number }> {
  await ensureFlacReady();

  const decoder = new Decoder(Flac, { verify: false });
  try {
    if (!decoder.decode(new Uint8Array(flacData.buffer, flacData.byteOffset, flacData.byteLength))) {
      throw new Error('FLAC decode failed (corrupt file?)');
    }
    const meta = decoder.metadata;
    if (!meta) throw new Error('FLAC decode produced no stream metadata');
    if (meta.bitsPerSample !== 16) {
      throw new Error(`Only 16-bit FLAC is supported (file is ${meta.bitsPerSample}-bit)`);
    }
    // Interleaved raw PCM bytes across all channels.
    const interleaved: Uint8Array = decoder.getSamples(true);
    const samples = new Int16Array(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength >> 1);
    // Copy out — the decoder's buffer is invalidated by destroy().
    return { samples: samples.slice(), sampleRate: meta.sampleRate, channels: meta.channels };
  } finally {
    try { decoder.destroy(); } catch { }
  }
}

export function decodeWav(wav: Buffer): { samples: Int16Array; sampleRate: number; channels: number } {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }

  let pos = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let data: Buffer | null = null;

  while (pos + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', pos, pos + 4);
    const chunkSize = wav.readUInt32LE(pos + 4);
    const body = wav.subarray(pos + 8, pos + 8 + chunkSize);
    if (chunkId === 'fmt ') {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitsPerSample: body.readUInt16LE(14),
      };
    } else if (chunkId === 'data') {
      data = body;
    }
    pos += 8 + chunkSize + (chunkSize & 1); // chunks are word-aligned
  }

  if (!fmt || !data) throw new Error('WAV file is missing fmt/data chunks');
  if (fmt.format !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`Only 16-bit PCM WAV is supported (format ${fmt.format}, ${fmt.bitsPerSample}-bit)`);
  }

  const samples = new Int16Array(data.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels };
}

// ---- normalization ----------------------------------------------------------

function downmix(interleaved: Int16Array, channels: number): Int16Array {
  const frames = Math.floor(interleaved.length / channels);
  const mono = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += interleaved[i * channels + c];
    mono[i] = Math.round(acc / channels);
  }
  return mono;
}

/** Plain linear resampler — a one-shot offline clip for STT doesn't need better. */
export function resampleLinear(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || input.length === 0) return input;
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Int16Array(outLength);
  const step = (input.length - 1) / Math.max(1, outLength - 1);
  for (let i = 0; i < outLength; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = Math.round(input[i0] * (1 - frac) + input[i1] * frac);
  }
  return out;
}

function int16ToBuffer(samples: Int16Array): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}
