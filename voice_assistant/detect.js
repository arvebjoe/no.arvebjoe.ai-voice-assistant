const pkg = require('bonjour-service');
const { createLogger } = require('../logger');
const EventEmitter = require('events');

const log = createLogger('DETECT');
const bonjourInstance = new pkg.Bonjour();

/**
 * Scans the network for ESPHome devices and emits events when devices are found
 * @param {number} scanTimeout - Time in ms to scan before completing (default: 10000)
 * @returns {EventEmitter} - EventEmitter that emits 'device-found' and 'scan-complete' events
 */
function findEsphomeDevices(scanTimeout = 10000) {
    const emitter = new EventEmitter();
    log.log('Scanning for ESPHome devices on the network...', 'DETECT');
    
    // Start discovery
    const browser = bonjourInstance.find(
        { type: 'esphomelib', protocol: 'tcp' },
        (service) => {
            //console.log(service);
            const info = {
                name: service.txt?.friendly_name || service.name || 'Unknown',
                address: service.addresses?.find(addr => addr.includes('.')) || 'Unknown', // Prefer IPv4
                port: service.port || 6053,
                mac: service.txt?.mac || 'Unknown',
                id: service.txt?.mac || service.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
                project: service.txt?.project_name || 'Unknown',
                serviceName: service.name
            };
            
            // TODO: Add more filtering here
            const isVoice = info.name.toLowerCase().includes('voice') || info.project.toLowerCase().includes('voice') || info.serviceName.toLowerCase().includes('voice');

            // Emit the device info
            if(isVoice){
                emitter.emit('device-found', info);
                log.log(`Device found`, 'MDNS', info);
            }
        }
    );

    // Stop after specified time and emit scan-complete
    const timer = setTimeout(() => {
        log.log('Scan completed');
        emitter.emit('scan-complete');
        browser.stop(); // Stop the browser
        
        // Don't destroy the Bonjour instance if we might use it again
        // bonjourInstance.destroy();
    }, scanTimeout);
    
    // Add method to manually stop scanning
    emitter.stopScanning = () => {
        clearTimeout(timer);
        browser.stop();
        emitter.emit('scan-complete');
        log.log('Scan stopped manually');
    };
    
    return emitter;
}



module.exports = {
    findEsphomeDevices
};

