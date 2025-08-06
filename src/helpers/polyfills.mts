/**
 * Polyfills for Node.js features that might be missing in older versions
 * Used by components that require modern Node.js APIs
 */

// Ensure Blob is available first since File extends from it
import { Blob as NodeBlob } from 'node:buffer';

if (!globalThis.Blob) {
    globalThis.Blob = NodeBlob;
}

// Type for BlobPart (Node.js compatible)
type BlobPart = Buffer | ArrayBuffer | string | Blob;

if (!globalThis.File) {
    class File extends Blob {
        name: string;
        lastModified: number;
        constructor(bits: BlobPart[], name: string, options: { type?: string; lastModified?: number } = {}) {
            super(bits, options);
            this.name = name;
            this.lastModified = options.lastModified || Date.now();
        }
    }
    globalThis.File = File as any;
}

export {};
