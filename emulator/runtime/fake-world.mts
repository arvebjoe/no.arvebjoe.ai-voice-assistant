// In-memory smart-home backing the `homey-api` shim. Loads the dummy zones and
// devices from settings.json, exposes them in the raw shape HomeyAPI returns,
// and lets the LLM mutate capability values via setCapabilityValue (kept in
// memory + logged so you can confirm the assistant did what you asked).
import { EventEmitter } from 'node:events';
import { config, getSatellites, EmulatorSatellite } from '../config.mjs';
import { createLogger } from '../../src/helpers/logger.mjs';

const log = createLogger('EMU-World', false);

interface RawDevice {
  id: string;
  name: string;
  zone: string; // zone id
  class: string;
  virtualClass?: string;
  capabilities: string[];
  capabilitiesObj: Record<string, { value: any }>;
  data: { id: string };
}

class FakeWorld {
  private zones: Record<string, { id: string; name: string; parent: string | null }> = {};
  private devices: Record<string, RawDevice> = {};
  private emitter = new EventEmitter();

  constructor() {
    for (const z of config.zones ?? []) {
      this.zones[z.id] = { id: z.id, name: z.name, parent: z.parent ?? null };
    }
    for (const d of config.devices ?? []) this.addDevice(d);

    // Auto-inject every satellite as a Homey device so the device manager's
    // zone registration (find by data.id === mac) resolves to a real zone.
    for (const sat of getSatellites()) {
      this.registerSatellite(sat);
    }
  }

  /**
   * Make a satellite visible to the fake HomeyAPI (zone lookup by mac). Also
   * called at runtime when `discover` adds a satellite to a live session.
   */
  registerSatellite(sat: EmulatorSatellite): void {
    this.addDevice({
      id: sat.mac,
      name: sat.name ?? 'Voice Satellite',
      zone: sat.zone,
      class: 'other',
      capabilities: { onoff: false, volume_set: 0.5, volume_mute: false },
      dataId: sat.mac,
    });
  }

  private addDevice(d: any): void {
    const caps: Record<string, any> = d.capabilities ?? {};
    const capabilities = Object.keys(caps);
    const capabilitiesObj: Record<string, { value: any }> = {};
    for (const c of capabilities) capabilitiesObj[c] = { value: caps[c] };
    this.devices[d.id] = {
      id: d.id,
      name: d.name,
      zone: d.zone,
      class: d.class,
      virtualClass: d.virtualClass,
      capabilities,
      capabilitiesObj,
      data: { id: d.dataId ?? d.id },
    };
  }

  /** The object ApiHelper expects back from HomeyAPI.createAppAPI(). */
  createApi(): any {
    const self = this;
    return {
      devices: {
        async connect() {},
        on(evt: string, cb: (...a: any[]) => void) { self.emitter.on(evt, cb); },
        async getDevices() { return self.devices; },
        async getDevice({ id }: { id: string }) { return self.devices[id]; },
        async setCapabilityValue({ deviceId, capabilityId, value }: any) {
          const dev = self.devices[deviceId];
          if (!dev) throw new Error(`Unknown device '${deviceId}'`);
          if (!dev.capabilitiesObj[capabilityId]) {
            dev.capabilitiesObj[capabilityId] = { value };
            if (!dev.capabilities.includes(capabilityId)) dev.capabilities.push(capabilityId);
          } else {
            dev.capabilitiesObj[capabilityId].value = value;
          }
          log.info(`${dev.name}  ${capabilityId} = ${JSON.stringify(value)}`, 'CONTROL');
          self.emitter.emit('device.update', { id: deviceId, zone: dev.zone });
        },
      },
      zones: {
        async getZones() { return self.zones; },
      },
    };
  }

  // ---- REPL inspection helpers ----------------------------------------------

  private zoneName(zoneId: string): string { return this.zones[zoneId]?.name ?? '(no zone)'; }

  renderZones(): string {
    const lines = Object.values(this.zones).map((z) => {
      const parent = z.parent ? `  ← ${this.zoneName(z.parent)}` : '';
      return `  ${z.name}${parent}`;
    });
    return `Zones:\n${lines.join('\n')}`;
  }

  renderDevices(): string {
    const lines = Object.values(this.devices).map((d) => {
      const caps = d.capabilities
        .map((c) => `${c}=${JSON.stringify(d.capabilitiesObj[c]?.value)}`)
        .join(', ');
      return `  [${d.class}] ${d.name}  @ ${this.zoneName(d.zone)}\n      ${caps}`;
    });
    return `Devices (${Object.keys(this.devices).length}):\n${lines.join('\n')}`;
  }

  renderDevice(query: string): string {
    const q = query.trim().toLowerCase();
    const dev = Object.values(this.devices).find(
      (d) => d.id.toLowerCase() === q || d.name.toLowerCase().includes(q),
    );
    if (!dev) return `No device matching '${query}'`;
    const caps = dev.capabilities
      .map((c) => `    ${c} = ${JSON.stringify(dev.capabilitiesObj[c]?.value)}`)
      .join('\n');
    return `${dev.name} [${dev.class}] @ ${this.zoneName(dev.zone)}  (id: ${dev.id})\n${caps}`;
  }
}

export const world = new FakeWorld();
