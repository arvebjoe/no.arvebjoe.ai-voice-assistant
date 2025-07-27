function pcmToWav(pcm, sr = 16_000) {
  const hdr  = Buffer.alloc(44);
  const ch   = 1, bps = 16, blk = ch * bps / 8;

  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(ch, 22); hdr.writeUInt32LE(sr, 24);
  hdr.writeUInt32LE(sr * blk, 28); hdr.writeUInt16LE(blk, 32);
  hdr.writeUInt16LE(bps, 34); hdr.write('data', 36);
  hdr.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([hdr, pcm]);
}

module.exports = {
  pcmToWav
};
