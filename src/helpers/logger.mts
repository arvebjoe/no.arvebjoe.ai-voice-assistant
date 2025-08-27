import Homey from 'homey/lib/Homey.js';
import util from 'util';

// Type definitions
interface Colors {
    reset: string;
    bright: string;
    dim: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    bgBlack: string;
    bgRed: string;
    bgGreen: string;
    bgYellow: string;
    bgBlue: string;
    bgMagenta: string;
    bgCyan: string;
    bgWhite: string;
}

// ANSI color codes
const colors: Colors = {
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



type Details = Record<string, any> | string | any | null;

class Logger {
    private from: string;
    private disabled: boolean;
    private static homey: Homey | null = null;

    constructor(from: string, disabled: boolean = false) {
        this.from = from.toUpperCase();
        this.disabled = disabled;
    }

    info(message: string, subFrom: string = '', details: Details = null) {
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
                const detailsLines = util.inspect(details, {
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


    error(message: string, details: Details = null) {
        this.info(message, 'ERROR', details);
    }

    warn(message: string, details: Details = null) {
        this.info(message, 'WARN', details);
    }

    log(message: string, subFrom: string = '', details: Details = null) {
        this.info(message, subFrom, details);
    }


    private output(message: string) {
        if (Logger.homey) {
            Logger.homey.log(message);
        } else {
            console.log(message);
        }
    }

    setHomey(homey: Homey) {
        Logger.homey = homey;
    }

}

// Export the createLogger function using ES modules
export function createLogger(from: string, disabled: boolean = false): Logger {
    return new Logger(from, disabled);
}
