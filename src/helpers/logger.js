const util = require('util');

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

function formatTime() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

class Logger {
    constructor(from) {
        this.from = from.toUpperCase();
        this.useColors = true; // Set to false to disable colors
    }

    info(message, subFrom = '', details = null) {
        const time = formatTime();
        const subFromStr = subFrom ? `[${subFrom}]` : '';
        
        if (this.useColors) {
            // Colorized output
            const timeStr = `${colors.dim}${time}${colors.reset}`;
            const fromStr = `${colors.cyan}[${this.from}]${colors.reset}`;
            const subFromColor = subFrom === 'ERROR' ? colors.red : 
                               subFrom === 'WARN' ? colors.yellow : colors.magenta;
            const subFromStr2 = subFrom ? `${subFromColor}[${subFrom}]${colors.reset}` : '';
            
            console.log(`${timeStr} ${fromStr}${subFromStr2} - ${message}`);
        } else {
            // Plain output without colors
            console.log(`${time} [${this.from}]${subFromStr} - ${message}`);
        }
        
        // Only output details if they exist and aren't empty
        if (details && Object.keys(details).length > 0) {
            // Add indentation for details
            const indent = '  ';
            
            // Handle different types of details
            if (typeof details === 'object') {
                if (this.useColors) {
                    // Convert object to string with indentation for each line
                    const detailsLines = util.inspect(details, {
                        colors: true,
                        depth: null,
                        compact: false
                    }).split('\n');
                    
                    // Output each line with indentation
                    for (const line of detailsLines) {
                        console.log(`${indent}${line}`);
                    }
                } else {
                    // Format JSON with indentation
                    const detailsLines = JSON.stringify(details, null, 2).split('\n');
                    for (const line of detailsLines) {
                        console.log(`${indent}${line}`);
                    }
                }
            } else {
                // For non-object types
                console.log(`${indent}${details}`);
            }
        }
    }


    error(message, details = null) {
        this.info(message, 'ERROR', details);
    }

    warn(message, details = null) {
        this.info(message, 'WARN', details);
    }
    
    log(message, subFrom = '', details = null) {
        this.info(message, subFrom, details);
    }
    
    // Method to enable/disable colors
    setColorMode(enabled) {
        this.useColors = enabled;
    }
}

// Export the createLogger function using CommonJS
module.exports = {
    createLogger: function(from) {
        return new Logger(from);
    }
};
