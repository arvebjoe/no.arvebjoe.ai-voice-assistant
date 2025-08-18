import { AudioData } from './interfaces.mjs';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import { createLogger } from './logger.mjs';

const log = createLogger('FILE');


export async function initAudioFolder() {

    try {
        // Create the directory if it doesn't exist
        await fs.mkdir('/userdata/audio', { recursive: true });

        // Read and empty the folder
        const files = await fs.readdir('/userdata/audio');
        await Promise.all(files.map(file => fs.unlink(`/userdata/audio/${file}`)));
        log.info('Audio folder initialized successfully');
    } catch (error) {
        log.error('Error initializing audio folder:', error);
    }

}


export async function saveAudioData(homey: any, prefix: string, audioData: AudioData) {
    const uniqueFilename = `${prefix}_${uuidv4()}.${audioData.extension}`;

    const filePath = '/userdata/audio/' + uniqueFilename;

    await fs.writeFile(filePath, audioData.data);

    homey.setTimeout(() => {
        log.info(`Deleting temporary file: ${filePath}`);
        fs.unlink(filePath).catch(err => log.error('Error deleting temporary file:', err));
    }, 30000);

    return {
        filename: uniqueFilename,
        filepath: filePath
    };
}

