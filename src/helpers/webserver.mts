import { networkInterfaces } from 'os';
import { createLogger } from './logger.mjs';
import { AudioData } from './interfaces.mjs';
import { emptyAudioFolder, saveAudioData } from './file-helper.mjs';


const log = createLogger('WEB');

export class WebServer {
    private homey: any;
    private ip: string | null;

    constructor(homey: any) {
        this.homey = homey;
        this.ip = null;
    }

    async start(): Promise<void> {
        this.ip = this.getLanIP();

        // Empty and remove audio subfolder
        emptyAudioFolder();
    }

    async stop(): Promise<void> {

    }

    async buildStream(audioData: AudioData): Promise<string> {

        const { filename } = await saveAudioData(this.homey, 'tx', audioData);

        const publicUrl = `http://${this.ip}/app/${this.homey.manifest.id}/userdata/audio/${filename}`;
        return publicUrl;
    }



    getLanIP(): string {

        log.info('Determining LAN IP address...', 'IP');
        let bestChoice: {
            address: string | null,
            name: string | null
        } = {
            address: null,
            name: null
        };

        const ifaces = networkInterfaces();

        for (const [name, addrs] of Object.entries(ifaces)) {
            if (!addrs) continue;

            const wired = (/^(eth|en|enx)/i.test(name));
            const ip4 = addrs.find(a => a.family === 'IPv4' && !a.internal);

            if (ip4 && ip4.address.startsWith('169.254.')) {
                // Skip link-local addresses
                continue;
            }

            if (ip4 && wired) {
                log.info(`Using wired interface ${name} with IP ${ip4.address}`, 'IP');
                return ip4.address;
            } else if (ip4) {
                log.info(`Found IPv4 address on interface ${name} with IP ${ip4.address}`, 'IP');
                bestChoice.address = ip4.address;
                bestChoice.name = name;
            }
        }

        if (bestChoice.address) {
            log.info(`Using best available interface ${bestChoice.name} with IP ${bestChoice.address}`, 'IP');
            return bestChoice.address;
        }

        log.warn('Could not determine LAN IP, defaulting to localhost');
        return '127.0.0.1';
    }
}

