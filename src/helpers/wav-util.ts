/**
 * Converts PCM audio data to WAV format
 * @param pcm - The PCM audio data buffer
 * @param sr - Sample rate (default: 16kHz)
 * @returns Buffer containing WAV formatted audio data
 */
export function pcmToWav(pcm: Buffer, sr: number = 16_000): Buffer {
  const hdr = Buffer.alloc(44);
  const ch: number = 1; 
  const bps: number = 16;
  const blk: number = ch * bps / 8;

  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16); 
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(ch, 22); 
  hdr.writeUInt32LE(sr, 24);
  hdr.writeUInt32LE(sr * blk, 28); 
  hdr.writeUInt16LE(blk, 32);
  hdr.writeUInt16LE(bps, 34); 
  hdr.write('data', 36);
  hdr.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([hdr, pcm]);
}
