'use strict';

import { networkInterfaces } from 'os';
import { createLogger } from './logger.mjs';
import { AudioData, StreamInfo } from './interfaces.mjs';
import express from 'express' ;
//import { pcmToWav } from './wav-util';
import { HomeyAPI } from 'homey-api';

export declare interface IWebServer {
    start(): Promise<void>;
    stop(): Promise<void>;
}

const log = createLogger('WEB');

export class WebServer implements IWebServer {
    private port: number;
    private homey: any;
    private api: any;
    private baseUrl: string | null;
    private streams: Map<string, Buffer>;
    private sampleRate: number;
    private app: any; // Express app
    
    constructor(port: number, homey: any) {
        this.port = port;
        this.homey = homey;
        this.api = null;
        this.baseUrl = null;
        this.streams = new Map<string, Buffer>(); // Map of stream names to their PCM buffers
        this.sampleRate = 16000;  // Sample rate from Piper (16kHz)
        this.app = null; // Express app instance
    }

    async start(): Promise<void> {
        this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
        this.app = express();

        // Define Express types inline for better type safety
        type Request = {
            params: Record<string, string>;
        };
        
        type Response = {
            send: (content: string | Buffer) => void;
            json: (data: any) => void;
            status: (code: number) => Response;
            set: (headers: Record<string, string | number>) => void;
            sendStatus: (code: number) => void;
            redirect: (url: string) => void;
        };
        
        // Root endpoint for debugging
        this.app.get('/', (req: Request, res: Response) => {
            res.send(`
                <html>
                <head>
                    <title>AI voice assistant</title>
                    <style>
                        body { font-family: Arial, sans-serif; margin: 20px; }
                        h1 { color: #333; }
                        .stream-list { margin-top: 20px; }
                        .stream-item { padding: 10px; background: #f5f5f5; margin-bottom: 5px; border-radius: 3px; }
                        .test-audio { margin-top: 30px; }
                        .url-list { margin: 20px 0; padding: 10px; background: #e8f5e9; border-radius: 3px; }
                    </style>
                </head>
                <body>
                    <h1>Audio Stream Server</h1>
                    <div class="url-list">
                        <p><strong>Access URLs:</strong></p>
                        <ul>
                            <li>Production URL: ${this.baseUrl || 'unknown URL'}</li>
                            <li>Development URL: <a href="http://localhost:${this.port}/">http://localhost:${this.port}/</a></li>
                        </ul>
                    </div>
                    
                    <div class="stream-list">
                        <h2>Available Streams:</h2>
                        ${Array.from(this.streams.keys()).map(name => {
                            const streamBuffer = this.streams.get(name);
                            const streamSize = streamBuffer ? streamBuffer.length : 0;
                            return `
                            <div class="stream-item">
                                <div>Name: ${name}</div>
                                <div>Size: ${streamSize} bytes</div>
                                <div>URL: <a href="/stream/${name}" target="_blank">${this.baseUrl}/stream/${name}</a></div>
                                <audio controls>
                                    <source src="/stream/${name}" type="audio/wav">
                                    Your browser does not support the audio element.
                                </audio>
                            </div>
                        `}).join('') || '<p>No streams available</p>'}
                    </div>
                    
                    <div class="test-audio">
                        <h2>Create Test Stream:</h2>
                        <form action="/create-test-stream" method="post">
                            <button type="submit">Create Test Audio Stream</button>
                        </form>
                    </div>
                </body>
                </html>
            `);
        });
        

        this.app.get('/devices', async (req: Request, res: Response) => {
            try {
                if (!this.api) {
                    throw new Error('Homey API not initialized. Call init() first.');
                }            
                const devices = await this.api.devices.getDevices();
                res.json(devices);
            } catch (error: any) {
                log.error('Error fetching devices:', error.message || 'Unknown error');
                res.status(500).json({ error: error.message || 'Unknown error' });
            }
        });

        this.app.get('/zones', async (req: Request, res: Response) => {
            try {
                if (!this.api) {
                    throw new Error('Homey API not initialized. Call init() first.');
                }
                const zones = await this.api.zones.getZones();
                res.json(zones);
            } catch (error: any) {
                log.error('Error fetching zones:', error.message || 'Unknown error');
                res.status(500).json({ error: error.message || 'Unknown error' });
            }
        });

        // Create a test stream
        this.app.post('/create-test-stream', (req: Request, res: Response) => {
            // Create a simple sine wave as test audio
            const sampleRate = 16000;
            const duration = 3; // seconds
            const frequency = 440; // A4 note
            const numSamples = sampleRate * duration;
            const buffer = Buffer.alloc(numSamples * 2); // 16-bit samples = 2 bytes per sample
            
            for (let i = 0; i < numSamples; i++) {
                const sample = Math.sin(2 * Math.PI * frequency * i / sampleRate) * 32767;
                buffer.writeInt16LE(Math.floor(sample), i * 2);
            }
            
            const testStreamUrl = this.buildStream({
                data: buffer,
                rate: sampleRate,
                extension: 'wav' // Use 'wav' for the test stream
            });
            
            res.redirect('/');
        });

        // Serve audio streams as WAV
        this.app.get('/stream/:name', (req: Request, res: Response) => {
            const { name } = req.params;
            const audioBuffer = this.streams.get(name);
            if (!audioBuffer || audioBuffer.length === 0) {
                return res.sendStatus(404);
            }
            // Determine content type from extension
            let contentType = 'application/octet-stream';
            if (name.endsWith('.wav')) {
                contentType = 'audio/wav';
            } else if (name.endsWith('.flac')) {
                contentType = 'audio/flac';
            }
            log.info(`Serving audio stream ${name}:`, '', {                 
                bytes: audioBuffer.length,
                contentType
            });
            res.set({
                'Content-Type': contentType,
                'Cache-Control': 'no-cache',
                'Content-Length': audioBuffer.length,
            });
            res.send(audioBuffer);
            // Clean up the stream after serving
            //this.streams.delete(name);
        });

        // Create server
        const ip = this.getLanIP();
        
        this.baseUrl = `http://${ip}:${this.port}`;

        await new Promise<void>(resolve => {
            this.app.listen(this.port, ip, () => {
                log.info(`HTTP server ready at ${this.baseUrl}/`, 'EXPRESS');
                resolve();
            });
        });
        
    }
    
    async stop(): Promise<void> {
        log.info('Stopping web server...'); 
        if (this.app) {
            this.app.close(() => {
                log.info('Web server stopped successfully');
            });
        }
        this.streams.clear();
        this.baseUrl = null;
    }

    buildStream(audioData: AudioData): string {

        const name = `stream-${Date.now()}.${audioData.extension}`;
        // Convert PCM to WAV (assuming 16kHz mono 16-bit PCM from Piper)

        
        this.streams.set(name, audioData.data);
        return `${this.baseUrl}/stream/${name}`;
    }

    // Create a new named stream and get its URL
    createStream(name: string): StreamInfo {
        this.streams.set(name, Buffer.alloc(0));
        return {
            name,
            audioFormat: null,
            url: `${this.baseUrl}/stream/${name}`,
            appendChunk: (chunk: Buffer): void => {
                const currentBuffer = this.streams.get(name) || Buffer.alloc(0);
                this.streams.set(name, Buffer.concat([currentBuffer, chunk]));
                //log.debug(`Appended chunk to stream ${name}:`, null, { bytes: chunk.length });
            }
        };
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

            if(ip4 && wired){
                log.info(`Using wired interface ${name} with IP ${ip4.address}`, 'IP');
                return ip4.address;
            } else if (ip4){
                log.info(`Found IPv4 address on interface ${name} with IP ${ip4.address}`, 'IP');
                bestChoice.address = ip4.address;
                bestChoice.name = name;
            }            
        }

        if(bestChoice.address){
            log.info(`Using best available interface ${bestChoice.name} with IP ${bestChoice.address}`, 'IP');
            return bestChoice.address;
        }

        log.warn('Could not determine LAN IP, defaulting to localhost');
        return '127.0.0.1';        
    }
}

