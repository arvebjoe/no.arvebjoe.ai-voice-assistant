import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scheduleAudioFileDeletion } from '../src/helpers/file-helper.mjs';
import { FileInfo } from '../src/helpers/interfaces.mjs';

// Capture scheduled deletions without executing them (so no real fs access) by
// providing a homey stub whose setTimeout just records the delay.
function makeCapturingHomey() {
    const calls: { ms: number }[] = [];
    return {
        calls,
        setTimeout: (_cb: Function, ms: number) => { calls.push({ ms }); return 0 as any; },
    };
}

const fileInfo: FileInfo = { filename: 'tx_x.flac', filepath: '/userdata/audio/tx_x.flac', url: '' };

describe('scheduleAudioFileDeletion', () => {
    beforeEach(() => { delete process.env.AUDIO_FILE_TTL_MS; });
    afterEach(() => { delete process.env.AUDIO_FILE_TTL_MS; });

    it('uses the 30s default TTL when no extra time is given', async () => {
        const homey = makeCapturingHomey();
        await scheduleAudioFileDeletion(homey as any, fileInfo);
        expect(homey.calls[0].ms).toBe(30_000);
    });

    it('extends the TTL by extraMs (long in-band reply playback) — M2', async () => {
        const homey = makeCapturingHomey();
        await scheduleAudioFileDeletion(homey as any, fileInfo, 12_000);
        expect(homey.calls[0].ms).toBe(42_000);
    });

    it('clamps a negative extraMs to the base TTL', async () => {
        const homey = makeCapturingHomey();
        await scheduleAudioFileDeletion(homey as any, fileInfo, -5_000);
        expect(homey.calls[0].ms).toBe(30_000);
    });

    it('honors the AUDIO_FILE_TTL_MS override as the base', async () => {
        process.env.AUDIO_FILE_TTL_MS = '1000';
        const homey = makeCapturingHomey();
        await scheduleAudioFileDeletion(homey as any, fileInfo, 500);
        expect(homey.calls[0].ms).toBe(1_500);
    });
});
