import Homey from 'homey/lib/Homey.js';
import util from 'util';

// ANSI color codes
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    bgBlack: '\x1b[40m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
    bgWhite: '\x1b[47m'
};


// Field names whose string values are secrets and must never appear in logs.
const SECRET_KEY_RE = /(api[_-]?key|access[_-]?key|secret|token|password|passwd|_key$|^key$)/i;

// Mask a secret string as first-4 + "...." + last-4 (e.g. "sk-p....8AA").
// Values too short to partially reveal are fully masked.
function maskSecretValue(value: string): string {
    if (value.length <= 8) {
        return '....';
    }
    return `${value.slice(0, 4)}....${value.slice(-4)}`;
}

// Return a copy of `details` with any secret-looking string fields masked.
// Only plain objects/arrays are traversed; Buffers, Errors and class instances
// pass through untouched so util.inspect still renders them normally.
function maskSecrets(details: any): any {
    if (Array.isArray(details)) {
        return details.map(maskSecrets);
    }
    if (details && typeof details === 'object' &&
        (details.constructor === Object || details.constructor === undefined)) {
        const out: Record<string, any> = {};
        for (const [key, value] of Object.entries(details)) {
            if (typeof value === 'string' && value && SECRET_KEY_RE.test(key)) {
                out[key] = maskSecretValue(value);
            } else {
                out[key] = maskSecrets(value);
            }
        }
        return out;
    }
    return details;
}


class Logger {
    private from: string;
    private disabled: boolean;
    private static homey: Homey | null = null;
    private static homeyLog: any;

    constructor(from: string, disabled: boolean = false) {
        this.from = from.toUpperCase();
        this.disabled = disabled;
    }

    setHomey(homey: Homey, homeyLog: any = null) {
        Logger.homey = homey;
        Logger.homeyLog = homeyLog;
    }

    info(message: string, subFrom: string = '', details: any = null) {
        if (this.disabled) {
            return;
        }

        const fromStr = `${colors.cyan}[${this.from}]${colors.reset}`;
        const subColor = subFrom === 'ERROR' ? colors.red : subFrom === 'WARN' ? colors.yellow : colors.magenta;
        const subStr = subFrom ? `${subColor}[${subFrom}]${colors.reset}` : '';

        this.output(`${fromStr}${subStr} - ${message}`);

        // Only output details if they exist and aren't empty
        if (details && Object.keys(details).length > 0) {
            // Add indentation for details
            const indent = '  ';

            // Handle different types of details
            if (typeof details === 'object') {

                // Convert object to string with indentation for each line
                // (secret-looking fields masked first so keys never hit the log).
                const detailsLines = util.inspect(maskSecrets(details), {
                    colors: true,
                    depth: null,
                    compact: false
                }).split('\n');

                // Output each line with indentation
                for (const line of detailsLines) {
                    this.output(`${indent}${line}`);
                }

            } else {
                // For non-object types
                this.output(`${indent}${details}`);
            }
        }
    }


    error(message: string, details: any = null) {

        try {
            this.reportError(details instanceof Error ? details : new Error(String(details)), message);

            if (Logger.homey) {
                Logger.homey.error(message, details);
            } else {
                this.info(message, 'ERROR', details);
            }
        } catch (_) {
            // Ignore it, will be fine
        }

    }

    warn(message: string, details: any = null) {
        this.info(message, 'WARN', details);
    }

    log(message: string, subFrom: string = '', details: any = null) {
        this.info(message, subFrom, details);
    }

    private output(message: string) {
        if (Logger.homey) {
            Logger.homey.log(message);
        } else {
            console.log(message);
        }
    }


    /**
     * Report an error to Sentry if homey-log is available
     * This provides a centralized way to report errors throughout your app
     */
    reportError(error: Error, context?: string) {
        const homeyLog = Logger.homeyLog;
        if (homeyLog && homeyLog.captureException) {            
            (error as any).context = context;
            homeyLog.captureException(error).catch((_: Error) => { });
        }
    }

    /**
     * Report a message to Sentry if homey-log is available
     */
    reportMessage(message: string) {
        const homeyLog = Logger.homeyLog;
        if (homeyLog && homeyLog.captureMessage) {
            homeyLog.captureMessage(message).catch((_: Error) => { });
        }
    }

}

// Export the createLogger function using ES modules
export function createLogger(from: string, disabled: boolean = false): Logger {
    return new Logger(from, disabled);
}
