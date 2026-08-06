import { AudioData, FileInfo } from './interfaces.mjs';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import { createLogger } from './logger.mjs';

const log = createLogger('FILE', true);

/**
 * Where reply/chime audio is written. On a Homey this is always the app's
 * /userdata volume. The emulator can point it somewhere writable with
 * HE_AUDIO_DIR — a plain user cannot create /userdata on macOS or Linux.
 * The playback URL path (/app/<id>/userdata/audio/...) is unaffected: that is
 * Homey's public mapping, not the location on disk.
 */
export function audioDir(): string {
    return process.env.HE_AUDIO_DIR?.trim() || '/userdata/audio';
}

export function audioFilePath(filename: string): string {
    return `${audioDir()}/${filename}`;
}


export async function initAudioFolder() {

    try {
        // Create the directory if it doesn't exist
        await fs.mkdir(audioDir(), { recursive: true });

        // Read and empty the folder
        const files = await fs.readdir(audioDir());
        await Promise.all(files.map(file => {
            log.info(audioFilePath(file), 'DELETING');
            return fs.unlink(audioFilePath(file))
        }));
        log.info('Audio folder initialized successfully');
    } catch (error) {
        log.error('Error initializing audio folder:', error);
    }

}


export async function saveAudioData(homey: any, audioData: AudioData): Promise<FileInfo> {
    const uniqueFilename = `${audioData.prefix}_${uuidv4()}.${audioData.extension}`;

    const filePath = audioFilePath(uniqueFilename);

    await fs.writeFile(filePath, audioData.data);

    return {
        filename: uniqueFilename,
        filepath: filePath,
        url: ''
    };

}

// How long (ms) a played audio file lingers before it's deleted. Defaults to
// 30s; override with AUDIO_FILE_TTL_MS (e.g. the emulator sets it high so debug
// recordings stick around long enough to inspect). Invalid/unset -> 30_000.
const DEFAULT_AUDIO_FILE_TTL_MS = 30_000;
function audioFileTtlMs(): number {
    const raw = Number(process.env.AUDIO_FILE_TTL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUDIO_FILE_TTL_MS;
}

// `extraMs` extends the lifetime for files that keep playing past the base TTL —
// e.g. a whole in-band reply concatenated into one file, which the PE streams over
// its full playback duration. Pass the expected playback length so the file isn't
// deleted mid-stream.
export async function scheduleAudioFileDeletion(homey: any, fileInfo: FileInfo, extraMs: number = 0) {

    const ttl = audioFileTtlMs() + Math.max(0, extraMs);
    homey.setTimeout(() => {
        log.info(`Deleting temporary file: ${fileInfo.filepath}`);
        fs.unlink(fileInfo.filepath).catch(err => log.error('Error deleting temporary file:', err));
    }, ttl);
}


