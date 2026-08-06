// Turns a real driver Device class into a virtual satellite: the ONLY thing
// that changes is which client it talks to. VoiceAssistantDevice builds its ESP
// client through a `createEspClient` seam, so overriding that swaps the ESPHome
// TCP client for one whose mic and speaker are this computer's (see
// local-audio-esp-client.mts). Everything else — driver, capabilities, provider,
// tools, turn state machine, reply/announce sequencing — is untouched app code.
import { satelliteHub } from './hub.mjs';
import { LocalAudioEspClient } from './local-audio-esp-client.mjs';
import { config, type EmulatorSatellite } from '../../config.mjs';

export function createVirtualDeviceClass(DeviceClass: any, sat: EmulatorSatellite): any {
  return class VirtualSatelliteDevice extends DeviceClass {
    createEspClient(_options: any): any {
      const client = new LocalAudioEspClient({
        id: sat.mac,
        name: sat.name,
        // The page shows the zone the assistant thinks it is in — the name, not
        // the settings.json id.
        zone: config.zones?.find((z) => z.id === sat.zone)?.name ?? sat.zone,
      });
      satelliteHub.register(client);
      return client;
    }
  };
}
