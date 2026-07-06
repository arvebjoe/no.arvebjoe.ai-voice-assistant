/**
 * Minimal WAV (RIFF) helpers for the local voice pipeline.
 *
 * The local services speak WAV at their edges: Whisper wants a WAV upload
 * (16 kHz mic PCM wrapped in a header) and Piper answers with a WAV whose
 * sample rate depends on the loaded voice model (16000 for *-low, 22050 for
 * *-medium/high). The rest of the app deals in raw PCM16 mono, so these
 * helpers convert both ways plus resample to the app's 24 kHz reply contract.
 * Only PCM16 is supported — same restriction as pcmToFlacBuffer.
 */

export interface WavData {
    pcm: Buffer;          // raw sample data (interleaved if stereo)
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
}

/** Wrap raw PCM16 in a canonical 44-byte WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels: number = 1): Buffer {
    const bitsPerSample = 16;
    const blockAlign = channels * (bitsPerSample >> 3);
    const byteRate = sampleRate * blockAlign;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);                 // fmt chunk size
    header.writeUInt16LE(1, 20);                  // PCM format
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

/**
 * Parse a WAV buffer by walking its RIFF chunks (Piper's header is canonical,
 * but chunk-walking also survives extra chunks like LIST/INFO). Throws on
 * anything that isn't PCM16 — the FLAC encoder downstream can't take it.
 */
export function wavToPcm(wav: Buffer): WavData {
    if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Not a RIFF/WAVE buffer');
    }

    let sampleRate = 0;
    let channels = 0;
    let bitsPerSample = 0;
    let format = 0;
    let pcm: Buffer | null = null;

    let offset = 12;
    while (offset + 8 <= wav.length) {
        const chunkId = wav.toString('ascii', offset, offset + 4);
        const chunkSize = wav.readUInt32LE(offset + 4);
        const body = offset + 8;

        if (chunkId === 'fmt ') {
            format = wav.readUInt16LE(body);
            channels = wav.readUInt16LE(body + 2);
            sampleRate = wav.readUInt32LE(body + 4);
            bitsPerSample = wav.readUInt16LE(body + 14);
        } else if (chunkId === 'data') {
            // A streamed WAV may declare 0xFFFFFFFF / 0 and just run to EOF.
            const declared = chunkSize === 0 || chunkSize === 0xFFFFFFFF
                ? wav.length - body
                : Math.min(chunkSize, wav.length - body);
            pcm = wav.subarray(body, body + declared);
        }

        // Chunks are word-aligned: odd sizes carry a pad byte.
        offset = body + chunkSize + (chunkSize & 1);
    }

    if (!pcm || !sampleRate) throw new Error('WAV is missing fmt/data chunks');
    if (format !== 1 || bitsPerSample !== 16) {
        throw new Error(`Unsupported WAV format (format=${format}, bits=${bitsPerSample}) — only PCM16 is supported`);
    }
    return { pcm, sampleRate, channels, bitsPerSample };
}

/** Downmix interleaved PCM16 to mono by averaging channels. */
export function toMonoPcm16(pcm: Buffer, channels: number): Buffer {
    if (channels <= 1) return pcm;
    const frames = Math.floor(pcm.length / (2 * channels));
    const out = Buffer.allocUnsafe(frames * 2);
    for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let ch = 0; ch < channels; ch++) {
            sum += pcm.readInt16LE((i * channels + ch) * 2);
        }
        out.writeInt16LE(Math.round(sum / channels), i * 2);
    }
    return out;
}

/**
 * One-shot linear resample of PCM16 mono between arbitrary rates. Used on
 * complete TTS clips (not the streaming mic path — that's Pcm16kTo24k), so a
 * simple whole-buffer interpolation is fine.
 */
export function resamplePcm16Mono(pcm: Buffer, inRate: number, outRate: number): Buffer {
    if (inRate === outRate || pcm.length < 4) return pcm;
    const inSamples = pcm.length >>> 1;
    const outSamples = Math.max(1, Math.round(inSamples * outRate / inRate));
    const out = Buffer.allocUnsafe(outSamples * 2);
    const step = (inSamples - 1) / Math.max(1, outSamples - 1);
    for (let i = 0; i < outSamples; i++) {
        const pos = i * step;
        const j = Math.min(inSamples - 2, pos | 0);
        const frac = pos - j;
        const s0 = pcm.readInt16LE(j * 2);
        const s1 = pcm.readInt16LE((j + 1) * 2);
        let v = Math.round(s0 + (s1 - s0) * frac);
        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        out.writeInt16LE(v, i * 2);
    }
    return out;
}
