const { Buffer } = require('node:buffer');

/**
 * Polyfills for Node.js features that might be missing in older versions
 * Used by components that require modern Node.js APIs
 */

// Ensure Blob is available first since File extends from it
if (!globalThis.Blob) {
    globalThis.Blob = require('node:buffer').Blob;
}

// Polyfill File for Node.js versions below 20
if (!globalThis.File) {
    class File extends Blob {
        constructor(bits, name, options = {}) {
            super(bits, options);
            this.name = name;
            this.lastModified = options.lastModified || Date.now();
        }
    }
    globalThis.File = File;
}

module.exports = {
    // Export any utility functions if needed
};
