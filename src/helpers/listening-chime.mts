import { promises as fs } from 'fs';
import { pcmToFlacBuffer } from './audio-encoders.mjs';
import { createLogger } from './logger.mjs';

const log = createLogger('CHIME', true);

/**
 * The persistent "I'm listening" chime played by the follow-up mic reopen.
 *
 * Why a real sound instead of the old empty-media reopen announce: the
 * firmware (voice_assistant.cpp) only ends an announce promptly when its
 * media player actually played something — with an empty media_id nothing
 * plays and the announce is ended by a hardcoded 2 s fallback timeout
 * (start_playback_timeout_), which delayed every follow-up mic-open by
 * ~2.1 s. A short clip ends the announce at end-of-playback (~0.3 s) AND
 * gives the user an audible "speak now" cue. Served from the app's LAN
 * webserver (not the GitHub sound URLs) so reopen latency never depends on
 * WAN and offline/local-pipeline setups keep working.
 *
 * The file lives in the turn-audio folder but is written once per boot
 * (initAudioFolder wipes the folder before devices init) and never gets a
 * scheduled deletion.
 */
export const LISTENING_CHIME_FILENAME = 'listening_chime.flac';

const SAMPLE_RATE = 24_000;

/** Two soft ascending tones (E5 -> A5), raised-cosine fades, ~280 ms total. */
export function synthesizeChimePcm(): Buffer {
    const AMPLITUDE = 0.22 * 32767;
    const FADE_MS = 12;
    const parts: { freq: number; ms: number }[] = [
        { freq: 659.25, ms: 90 }, // E5
        { freq: 0, ms: 40 },      // gap
        { freq: 880.0, ms: 90 },  // A5
        { freq: 0, ms: 60 },      // silent tail so playback doesn't clip the fade
    ];

    const chunks: Buffer[] = [];
    for (const { freq, ms } of parts) {
        const samples = Math.round(SAMPLE_RATE * (ms / 1000));
        const buf = Buffer.alloc(samples * 2); // PCM16 silence by default
        if (freq > 0) {
            const fadeSamples = Math.min(Math.round(SAMPLE_RATE * (FADE_MS / 1000)), Math.floor(samples / 2));
            for (let i = 0; i < samples; i++) {
                let envelope = 1;
                if (i < fadeSamples) {
                    envelope = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeSamples);
                } else if (i >= samples - fadeSamples) {
                    envelope = 0.5 - 0.5 * Math.cos((Math.PI * (samples - 1 - i)) / fadeSamples);
                }
                const sample = AMPLITUDE * envelope * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
                buf.writeInt16LE(Math.round(sample), i * 2);
            }
        }
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
}

let chimePcmCache: Buffer | null = null;

/**
 * Reply PCM + a short pause + the chime, for KEEP-OPEN in-band replies. Those
 * turns have no announce of ours — the PE auto-reopens the mic itself at end
 * of playback (firmware continue_conversation flag) — so baking the chime into
 * the tail of the reply file is the only way every reopen gets the "speak now"
 * cue, not just the first one. Both sides are PCM16 mono 24 kHz.
 */
export function appendChimeToPcm(replyPcm: Buffer): Buffer {
    chimePcmCache ??= synthesizeChimePcm();
    const leadInSilence = Buffer.alloc(Math.round(SAMPLE_RATE * 0.15) * 2); // 150 ms gap after the last word
    return Buffer.concat([replyPcm, leadInSilence, chimePcmCache]);
}

let chimeReady: Promise<string> | null = null;

/**
 * Synthesize + write the chime once per boot; concurrent/later callers share
 * the same promise. Resolves to the filename (the device builds the LAN URL
 * fresh per reopen — the IP can change). A failure clears the cache so the
 * next caller retries.
 */
export function ensureListeningChime(): Promise<string> {
    if (!chimeReady) {
        chimeReady = (async () => {
            const flac = await pcmToFlacBuffer(synthesizeChimePcm(), {
                sampleRate: SAMPLE_RATE,
                channels: 1,
                bitsPerSample: 16,
            });
            await fs.writeFile('/userdata/audio/' + LISTENING_CHIME_FILENAME, flac);
            log.info(`Listening chime written (${flac.length} bytes FLAC)`);
            return LISTENING_CHIME_FILENAME;
        })().catch((err) => {
            chimeReady = null;
            throw err;
        });
    }
    return chimeReady;
}
