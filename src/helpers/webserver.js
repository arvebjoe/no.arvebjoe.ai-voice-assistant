'use strict';

const express = require('express');
const { networkInterfaces } = require('os');
const { createLogger } = require('./logger');
const { pcmToWav } = require('./wav-util');

const log = createLogger('WEB');

class WebServer {
    constructor(port = 3100) {
        this.port = port;
        this.baseUrl = null;
        this.streams = new Map(); // Map of stream names to their PCM buffers
        this.sampleRate = 16000;  // Sample rate from Piper (16kHz)
        this.app = null; // Express app instance
    }

    async start() {
        this.app = express();

        // Root endpoint for debugging
        this.app.get('/', (req, res) => {
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
                        ${Array.from(this.streams.keys()).map(name => `
                            <div class="stream-item">
                                <div>Name: ${name}</div>
                                <div>Size: ${this.streams.get(name).length} bytes</div>
                                <div>URL: <a href="/stream/${name}" target="_blank">${this.baseUrl}/stream/${name}</a></div>
                                <audio controls>
                                    <source src="/stream/${name}" type="audio/wav">
                                    Your browser does not support the audio element.
                                </audio>
                            </div>
                        `).join('') || '<p>No streams available</p>'}
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
        
        // Create a test stream
        this.app.post('/create-test-stream', (req, res) => {
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
                rate: sampleRate
            });
            
            res.redirect('/');
        });

        // Serve audio streams as WAV
        this.app.get('/stream/:name', (req, res) => {
            const { name } = req.params;
            const wavBuffer = this.streams.get(name);
            
            if (!wavBuffer || wavBuffer.length === 0) {
                return res.sendStatus(404);
            }
            
            log.info(`Serving WAV stream ${name}:`, null, {                 
                wavBytes: wavBuffer.length
            });

            res.set({
                'Content-Type': 'audio/wav',
                'Cache-Control': 'no-cache',
                'Content-Length': wavBuffer.length,
            });
            res.send(wavBuffer);

            // Clean up the stream after serving
            //this.streams.delete(name);
        });

        // Create server
        const ip = this.getLanIP();
        
        this.baseUrl = `http://${ip}:${this.port}`;

        await new Promise(resolve => {
            this.app.listen(this.port, '0.0.0.0', () => {
                log.info(`HTTP server ready at ${this.baseUrl}/`, 'EXPRESS');
                resolve();
            });
        });
        
    }
    
    async stop() {
        log.info('Stopping web server...'); 
        if (this.app) {
            this.app.close(() => {
                log.info('Web server stopped successfully');
            });
        }
        this.streams.clear();
        this.baseUrl = null;
    }

    buildStream(audioData) {
        const name = `stream-${Date.now()}.wav`;
        // Convert PCM to WAV (assuming 16kHz mono 16-bit PCM from Piper)
        const wavBuffer = pcmToWav(audioData.data, audioData.rate);
        this.streams.set(name, wavBuffer);
        return `${this.baseUrl}/stream/${name}`;
    }

    // Create a new named stream and get its URL
    createStream(name) {
        this.streams.set(name, Buffer.alloc(0));
        return {
            name,
            audioFormat: null,
            url: `${this.baseUrl}/stream/${name}`,
            appendChunk: (chunk) => {
                const currentBuffer = this.streams.get(name);
                this.streams.set(name, Buffer.concat([currentBuffer, chunk]));
                //log.debug(`Appended chunk to stream ${name}:`, null, { bytes: chunk.length });
            }
        };
    }

    getLanIP() {
       
        for (const ifc of Object.values(networkInterfaces())) {
            
            for (const v of ifc) {
                if (v.family === 'IPv4' && !v.internal) {
                    return v.address;
                }
            }
        }
        
        // Fallback to localhost if no suitable IP is found
        log.warn('Could not determine LAN IP, defaulting to localhost');
        return '127.0.0.1';
    }
}

module.exports = {
    WebServer: WebServer
};
