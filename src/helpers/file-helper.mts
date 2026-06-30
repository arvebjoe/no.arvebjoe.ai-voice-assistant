import { AudioData, FileInfo } from './interfaces.mjs';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import { createLogger } from './logger.mjs';

const log = createLogger('FILE', true);


export async function initAudioFolder() {

    try {
        // Create the directory if it doesn't exist
        await fs.mkdir('/userdata/audio', { recursive: true });

        // Read and empty the folder
        const files = await fs.readdir('/userdata/audio');
        await Promise.all(files.map(file => {
            log.info(`/userdata/audio/${file}`, 'DELETING');
            return fs.unlink(`/userdata/audio/${file}`)
        }));
        log.info('Audio folder initialized successfully');
    } catch (error) {
        log.error('Error initializing audio folder:', error);
    }

}


export async function saveAudioData(homey: any, audioData: AudioData): Promise<FileInfo> {
    const uniqueFilename = `${audioData.prefix}_${uuidv4()}.${audioData.extension}`;

    const filePath = '/userdata/audio/' + uniqueFilename;

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

export async function scheduleAudioFileDeletion(homey: any, fileInfo: FileInfo) {

    homey.setTimeout(() => {
        log.info(`Deleting temporary file: ${fileInfo.filepath}`);
        fs.unlink(fileInfo.filepath).catch(err => log.error('Error deleting temporary file:', err));
    }, audioFileTtlMs());
}


