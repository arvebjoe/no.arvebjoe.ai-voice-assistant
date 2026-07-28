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
 * The files live in the turn-audio folder but are written once per boot
 * (initAudioFolder wipes the folder before devices init) and never get a
 * scheduled deletion.
 */
export const LISTENING_CHIME_FILENAME = 'listening_chime.flac';

/**
 * The mirror cue: played when a listening window closes with nothing heard
 * (silent follow-up timeout / no answer after a wake), so the user knows the
 * mic is no longer open. Same two tones as the listening chime, descending.
 */
export const MIC_CLOSED_CHIME_FILENAME = 'mic_closed_chime.flac';

const SAMPLE_RATE = 24_000;

const E5 = 659.25;
const A5 = 880.0;

type TonePart = { freq: number; ms: number };

/** Soft tones with raised-cosine fades; freq 0 = silence. */
function synthesizeTonesPcm(parts: TonePart[]): Buffer {
    const AMPLITUDE = 0.22 * 32767;
    const FADE_MS = 12;

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

/** Two soft ascending tones (E5 -> A5), ~280 ms total: "speak now". */
export function synthesizeChimePcm(): Buffer {
    return synthesizeTonesPcm([
        { freq: E5, ms: 90 },
        { freq: 0, ms: 40 },  // gap
        { freq: A5, ms: 90 },
        { freq: 0, ms: 60 },  // silent tail so playback doesn't clip the fade
    ]);
}

/** The listening chime reversed (A5 -> E5), same length: "mic closed". */
export function synthesizeMicClosedChimePcm(): Buffer {
    return synthesizeTonesPcm([
        { freq: A5, ms: 90 },
        { freq: 0, ms: 40 },  // gap
        { freq: E5, ms: 90 },
        { freq: 0, ms: 60 },  // silent tail so playback doesn't clip the fade
    ]);
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

const chimeFileReady = new Map<string, Promise<string>>();

/**
 * Synthesize + write a chime once per boot; concurrent/later callers share
 * the same promise. Resolves to the filename (the device builds the LAN URL
 * fresh per use — the IP can change). A failure clears the cache so the
 * next caller retries.
 */
function ensureChimeFile(filename: string, synthesize: () => Buffer): Promise<string> {
    let ready = chimeFileReady.get(filename);
    if (!ready) {
        ready = (async () => {
            const flac = await pcmToFlacBuffer(synthesize(), {
                sampleRate: SAMPLE_RATE,
                channels: 1,
                bitsPerSample: 16,
            });
            await fs.writeFile('/userdata/audio/' + filename, flac);
            log.info(`Chime written: ${filename} (${flac.length} bytes FLAC)`);
            return filename;
        })().catch((err) => {
            chimeFileReady.delete(filename);
            throw err;
        });
        chimeFileReady.set(filename, ready);
    }
    return ready;
}

export function ensureListeningChime(): Promise<string> {
    return ensureChimeFile(LISTENING_CHIME_FILENAME, synthesizeChimePcm);
}

export function ensureMicClosedChime(): Promise<string> {
    return ensureChimeFile(MIC_CLOSED_CHIME_FILENAME, synthesizeMicClosedChimePcm);
}
