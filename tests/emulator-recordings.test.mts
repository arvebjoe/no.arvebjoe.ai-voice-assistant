import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecording, decodeWav, resampleLinear, MIC_SAMPLE_RATE } from '../emulator/runtime/recordings.mjs';
import { pcmToFlacBuffer } from '../src/helpers/audio-encoders.mjs';

/** s16le sine wave as raw samples. */
function sine(rate: number, ms: number, freq: number = 440, amp: number = 12000): Int16Array {
  const n = Math.round((rate * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}

function toBuffer(samples: Int16Array): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

/** Minimal 16-bit PCM WAV wrapper around interleaved samples. */
function buildWav(samples: Int16Array, rate: number, channels: number): Buffer {
  const data = toBuffer(samples);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);          // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe('decodeWav', () => {
  it('parses a 16-bit PCM WAV', () => {
    const src = sine(16000, 100);
    const parsed = decodeWav(buildWav(src, 16000, 1));
    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.channels).toBe(1);
    expect([...parsed.samples.subarray(0, 50)]).toEqual([...src.subarray(0, 50)]);
  });

  it('rejects non-WAV data and non-16-bit formats', () => {
    expect(() => decodeWav(Buffer.from('definitely not a wav file, not even close'))).toThrow(/RIFF/);
    const wav = buildWav(sine(16000, 10), 16000, 1);
    wav.writeUInt16LE(24, 34); // claim 24-bit
    expect(() => decodeWav(wav)).toThrow(/16-bit/);
  });
});

describe('resampleLinear', () => {
  it('scales the sample count by the rate ratio', () => {
    const src = sine(48000, 100);
    const out = resampleLinear(src, 48000, 16000);
    expect(Math.abs(out.length - src.length / 3)).toBeLessThanOrEqual(1);
  });

  it('preserves a DC signal exactly', () => {
    const src = new Int16Array(4800).fill(1000);
    const out = resampleLinear(src, 24000, 16000);
    expect(out.every((s) => s === 1000)).toBe(true);
  });

  it('passes through when rates match', () => {
    const src = sine(16000, 20);
    expect(resampleLinear(src, 16000, 16000)).toBe(src);
  });
});

describe('loadRecording', () => {
  it('decodes a FLAC clip back to 16 kHz mono PCM (roundtrip via the app encoder)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'he-rec-'));
    try {
      // Encode with the same encoder the app uses for reply audio (24 kHz, as
      // input_buffer_debug recordings are), then load it as a mic clip.
      const src = sine(24000, 200);
      const flac = await pcmToFlacBuffer(toBuffer(src), { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
      const path = join(dir, 'clip.flac');
      writeFileSync(path, flac);

      const rec = await loadRecording(path);
      expect(rec.sourceRate).toBe(24000);
      expect(rec.sourceChannels).toBe(1);
      expect(Math.abs(rec.durationMs - 200)).toBeLessThanOrEqual(5);
      // 200 ms at 16 kHz mono s16le ≈ 6400 bytes.
      expect(Math.abs(rec.pcm.length - (MIC_SAMPLE_RATE * 0.2 * 2))).toBeLessThanOrEqual(64);
      // The signal survived: not silence, sane amplitude.
      let max = 0;
      for (let i = 0; i < rec.pcm.length; i += 2) max = Math.max(max, Math.abs(rec.pcm.readInt16LE(i)));
      expect(max).toBeGreaterThan(8000);
      expect(max).toBeLessThanOrEqual(13000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('downmixes a stereo WAV and resamples 48 kHz to 16 kHz', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'he-rec-'));
    try {
      const mono = sine(48000, 100);
      const stereo = new Int16Array(mono.length * 2);
      for (let i = 0; i < mono.length; i++) {
        stereo[i * 2] = mono[i];
        stereo[i * 2 + 1] = mono[i];
      }
      const path = join(dir, 'clip.wav');
      writeFileSync(path, buildWav(stereo, 48000, 2));

      const rec = await loadRecording(path);
      expect(rec.sourceRate).toBe(48000);
      expect(rec.sourceChannels).toBe(2);
      expect(Math.abs(rec.durationMs - 100)).toBeLessThanOrEqual(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
