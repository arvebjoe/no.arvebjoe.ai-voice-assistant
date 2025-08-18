import EventEmitter from 'node:events';
import { TypedEmitter } from "tiny-typed-emitter";

// ---- CONFIG ----
const SAMPLE_RATE = 24_000;       // Hz
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;      // int16
const FRAME_MS = 30;             // analysis window
const MIN_SILENCE_MS = 300;      // how long silence to cut
const MIN_CHUNK_MS = 600;        // don't emit super tiny files
const PRE_PAD_MS = 60;           // keep a bit before silence
const POST_PAD_MS = 120;         // keep a bit after silence
const SILENCE_DBFS = -45;        // below this is "silence" (tweak)

// Derived
const FRAME_BYTES = Math.round(SAMPLE_RATE * (FRAME_MS / 1000) * CHANNELS * BYTES_PER_SAMPLE);
const PRE_PAD_BYTES = Math.round(SAMPLE_RATE * (PRE_PAD_MS / 1000) * CHANNELS * BYTES_PER_SAMPLE);
const POST_PAD_BYTES = Math.round(SAMPLE_RATE * (POST_PAD_MS / 1000) * CHANNELS * BYTES_PER_SAMPLE);
const MIN_SILENCE_FRAMES = Math.ceil(MIN_SILENCE_MS / FRAME_MS);
const MIN_CHUNK_BYTES = Math.round(SAMPLE_RATE * (MIN_CHUNK_MS / 1000) * CHANNELS * BYTES_PER_SAMPLE);


type SegmenterEvents = {
    chunk: (data: Buffer) => void;
}


// Main segmenter
export class PcmSegmenter extends (EventEmitter as new () => TypedEmitter<SegmenterEvents>) {    
    private remainder: Buffer;
    private current: Buffer[];           // array of Buffers for current segment
    private bytesInCurrent: number;
    private silenceFrames: number;
    private trailingBuffer: Buffer; // for post-pad


    constructor() {
        super();
        
        this.remainder = Buffer.alloc(0);
        this.current = [];           // array of Buffers for current segment
        this.bytesInCurrent = 0;
        this.silenceFrames = 0;
        this.trailingBuffer = Buffer.alloc(0); // for post-pad

    }

    flush(): void {
        if (this.bytesInCurrent > 0) {
            this.emit_segment(Buffer.concat(this.current));
            this.current = [];
            this.bytesInCurrent = 0;
            this.remainder = Buffer.alloc(0);
            this.silenceFrames = 0;
            this.trailingBuffer = Buffer.alloc(0);
        }
    }

    // feed() with arbitrary PCM chunk boundaries
    async feed(pcmChunk: Buffer): Promise<void> {
        // concat with remainder from last call so we have whole frames
        let buf = Buffer.concat([this.remainder, pcmChunk]);
        let offset = 0;

        while (offset + FRAME_BYTES <= buf.length) {
            const frame = buf.subarray(offset, offset + FRAME_BYTES);
            offset += FRAME_BYTES;

            // Loudness
            const int16 = new Int16Array(frame.buffer, frame.byteOffset, frame.length / 2);
            const db = this.frameDbfs(int16);
            const isSilent = db < SILENCE_DBFS;

            // Add frame into current segment
            this.current.push(frame);
            this.bytesInCurrent += frame.length;

            if (isSilent) {
                this.silenceFrames++;
                // Keep trailing buffer for POST_PAD
                this.trailingBuffer = Buffer.concat([this.trailingBuffer, frame]);
                // limit trailing buffer size
                if (this.trailingBuffer.length > POST_PAD_BYTES) {
                    this.trailingBuffer = this.trailingBuffer.subarray(this.trailingBuffer.length - POST_PAD_BYTES);
                }
            } else {
                this.silenceFrames = 0;
                // when speaking, also keep a small pre-pad window
                this.trailingBuffer = Buffer.alloc(0);
            }

            // End-of-utterance?
            if (this.silenceFrames >= MIN_SILENCE_FRAMES && this.bytesInCurrent >= MIN_CHUNK_BYTES) {
                // Assemble with some pre and post padding:
                // We already captured POST_PAD in trailingBuffer (which is silent).
                // For PRE_PAD, carve it from the tail of the accumulated audio if possible.
                let segment = Buffer.concat(this.current);
                const preStart = Math.max(0, segment.length - this.silenceFrames * FRAME_BYTES - PRE_PAD_BYTES);
                const postEnd = Math.min(segment.length, segment.length - this.silenceFrames * FRAME_BYTES + POST_PAD_BYTES);

                // Cut the segment at postEnd, emit that; keep remainder (after postEnd) for next start
                const current_chunk = segment.subarray(0, postEnd);
                const remainderForNext = segment.subarray(postEnd); // this contains the early part of the long silence

                this.emit_segment(current_chunk);

                // Reset state with leftover (so next chunk starts "after" the split)
                this.current = [remainderForNext];
                this.bytesInCurrent = remainderForNext.length;
                this.silenceFrames = 0;
                this.trailingBuffer = Buffer.alloc(0);
            }
        }

        // Keep remainder bytes that didn't fill a full frame
        this.remainder = buf.subarray(offset);
    }



    private emit_segment(pcmBuf: Buffer) {

        // Ignore near-empty chunks
        if (pcmBuf.length < MIN_CHUNK_BYTES) {
            return;
        }

        this.emit('chunk', pcmBuf);
    }

    
    // Simple dBFS from a 30ms frame of Int16 samples
    private frameDbfs(bufLE16: Int16Array): number {
        let sumSq = 0;
        for (let i = 0; i < bufLE16.length; i++) {
            const v = bufLE16[i] / 32768;
            sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / bufLE16.length) + 1e-12;
        return 20 * Math.log10(rms);
    }
}



