import { EventEmitter } from "events";
import { TypedEmitter } from "tiny-typed-emitter";
import { DeviceManager } from '../helpers/device-manager.mjs';
import { createLogger } from '../helpers/logger.mjs';

type ToolHandler = (args: any) => Promise<any> | any;

interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required: string[];
    additionalProperties: boolean;
  };
  handler: ToolHandler;
}

type ToolManagerEvents = { /* Reserved for future events */ };

// Helper: wrap all tool responses in a uniform envelope
function ok(data: any, extra?: Record<string, any>) {
  return { ok: true, data, ...(extra || {}) };
}
function err(message: string, code = "ERROR", extra?: Record<string, any>) {
  return { ok: false, error: { code, message }, ...(extra || {}) };
}

export class ToolManager extends (EventEmitter as new () => TypedEmitter<ToolManagerEvents>) {
  private homey: any;
  private deviceManager: DeviceManager;
  private tools: Map<string, ToolDefinition> = new Map();
  private logger = createLogger('ToolManager', true);

  constructor(homey: any, deviceManager: DeviceManager) {
    super();
    this.homey = homey;
    this.deviceManager = deviceManager;
    this.registerDefaultTools();
  }

  registerTool(definition: ToolDefinition): void {
    this.logger.info(definition.name, "REGISTER TOOL");
    this.tools.set(definition.name, definition);
  }

  getToolHandlers(): Record<string, ToolHandler> {
    const handlers: Record<string, ToolHandler> = {};
    for (const [name, tool] of this.tools) handlers[name] = tool.handler;
    return handlers;
  }

  getToolDefinitions(): Array<Omit<ToolDefinition, 'handler'>> {
    return Array.from(this.tools.values()).map(tool => ({
      type: tool.type,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }

  getToolDefinition(name: string): Omit<ToolDefinition, 'handler'> | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    const { handler, ...def } = tool;
    return def;
  }

  hasTool(name: string): boolean { return this.tools.has(name); }
  getToolNames(): string[] { return Array.from(this.tools.keys()); }

  private registerDefaultTools(): void {
    // get_local_time — returns structured data only (no English sentence)
    this.registerTool({
      type: "function",
      name: "get_local_time",
      description: "Get the local time for a given IANA timezone or BCP-47 locale. Returns structured data suitable for rendering in the user’s language.",
      parameters: {
        type: "object",
        properties: {
          timezone: { type: "string", description: "IANA timezone like 'Europe/Oslo'. If omitted, defaults to Europe/Oslo." },
          locale: { type: "string", description: "BCP-47 locale, defaults to 'nb-NO'." }
        },
        required: [],
        additionalProperties: false
      },
      handler: ({ timezone, locale }) => {
        const tz = (timezone as string) || "Europe/Oslo";
        const loc = (locale as string) || "nb-NO";
        const now = new Date();
        try {
          const fmt = new Intl.DateTimeFormat(loc, {
            timeZone: tz,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            weekday: "long",
            day: "2-digit",
            month: "long",
            year: "numeric"
          });
          const formatted = fmt.format(now);
          return { ok: true, data: { iso: now.toISOString(), formatted, timezone: tz, locale: loc } };
        } catch (error: any) {
          return { ok: false, error: { code: "INVALID_TIMEZONE", message: `Could not interpret timezone '${tz}'.` } };
        }
      }
    });

    // get_zones
    this.registerTool({
      type: "function",
      name: "get_zones",
      description: "Get a list of all zones.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      },
      handler: async () => {
        this.logger.info('get_zones', 'TOOL', 'Executing get_zones...');
        try {
          const data = await this.deviceManager.getZones();
          return { ok: true, data };
        } catch (error: any) {
          this.logger.error(`Error executing get_zones`, error);
          return { ok: false, error: { code: "ZONES_UNAVAILABLE", message: "Could not retrieve zones." } };
        }
      }
    });

    // get_all_device_types
    this.registerTool({
      type: "function",
      name: "get_all_device_types",
      description: "Get all device types available.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      },
      handler: async () => {
        this.logger.info('get_all_device_types', 'TOOL', 'Executing get_all_device_types...');
        try {
          const data = await this.deviceManager.getAllDeviceTypes();
          return { ok: true, data };
        } catch (error: any) {
          this.logger.error(`Error executing get_all_device_types`, error);
          return { ok: false, error: { code: "DEVICE_TYPES_UNAVAILABLE", message: "Could not retrieve device types." } };
        }
      }
    });

    // get_smart_home_devices
    this.registerTool({
      type: "function",
      name: "get_smart_home_devices",
      description: "Get smart home devices in a specific zone and/or type (with pagination).",
      parameters: {
        type: "object",
        properties: {
          zone: { type: "string", description: "Zone name to filter devices (optional)." },
          type: { type: "string", description: "Device type to filter devices (optional)." },
          page_size: { type: "integer", description: "Number of devices to return per page (default 50, max 100).", minimum: 1, maximum: 100 },
          page_token: { type: "string", description: "Token for pagination (optional)." }
        },
        required: [],
        additionalProperties: false
      },
      handler: async ({ zone, type, page_size, page_token }) => {
        this.logger.info('get_smart_home_devices', 'TOOL', `zone=${zone}, type=${type}, page_size=${page_size}, page_token=${page_token}`);
        const zoneSafe = zone || undefined;
        const typeSafe = type || undefined;
        const pageSizeSafe = page_size || undefined;
        const pageTokenSafe = page_token || null;
        try {
          const data = await this.deviceManager.getSmartHomeDevices(zoneSafe, typeSafe, pageSizeSafe, pageTokenSafe);
          return { ok: true, data };
        } catch (error: any) {
          this.logger.error(`Error executing get_smart_home_devices`, error);
          return { ok: false, error: { code: "DEVICES_UNAVAILABLE", message: "Could not retrieve smart home devices." } };
        }
      }
    });

    // set_device_capability
    this.registerTool({
      type: "function",
      name: "set_device_capability",
      description: "Set a capability value for a single device. Use for one-device changes only.",
      parameters: {
        type: "object",
        properties: {
          deviceId: { type: "string", description: "The ID of the device to control." },
          capabilityId: { type: "string", description: "Capability to set.", enum: ["onoff", "dim", "target_temperature"] },
          newValue: {
            oneOf: [
              { type: "boolean", description: "For 'onoff'." },
              { type: "number", description: "For 'dim' (0..1) and 'target_temperature' (°C)." }
            ],
            description: "New value for the capability."
          },
          expected_zone: { type: "string", description: "Zone the agent expects this device to be in (defense-in-depth)." },
          allow_cross_zone: { type: "boolean", description: "Must be true to allow cross-zone writes.", default: false },
          confirmed: { type: "boolean", description: "Must be true for security-sensitive actions." }
        },
        required: ["deviceId", "capabilityId", "newValue"],
        additionalProperties: false
      },
      handler: async ({ deviceId, capabilityId, newValue, expected_zone, allow_cross_zone, confirmed }) => {
        this.logger.info('set_device_capability', 'TOOL', `device=${deviceId}, cap=${capabilityId}, value=${newValue}`);
        try {
          const data = await this.deviceManager.setDeviceCapability(deviceId, capabilityId, newValue, { expected_zone, allow_cross_zone, confirmed });
          return { ok: true, data };
        } catch (error: any) {
          this.logger.error(`Error executing set_device_capability`, error);
          return { ok: false, error: { code: "SET_CAPABILITY_FAILED", message: "Could not set device capability." } };
        }
      }
    });

    // set_device_capability_bulk
    this.registerTool({
      type: "function",
      name: "set_device_capability_bulk",
      description: "Set a capability value for MANY devices at once. Use when 2+ devices need the same change.",
      parameters: {
        type: "object",
        properties: {
          deviceIds: { type: "array", items: { type: "string" }, description: "Array of device IDs to control.", minItems: 1 },
          capabilityId: { type: "string", description: "Capability to set.", enum: ["onoff", "dim", "target_temperature"] },
          newValue: {
            oneOf: [
              { type: "boolean", description: "For 'onoff'." },
              { type: "number", description: "For 'dim' (0..1) and 'target_temperature' (°C)." }
            ],
            description: "New value for the capability."
          },
          expected_zone: { type: "string", description: "Zone the agent expects these devices to be in (defense-in-depth)." },
          allow_cross_zone: { type: "boolean", description: "Must be true to allow cross-zone writes.", default: false },
          confirmed: { type: "boolean", description: "Must be true if >10 devices or security-sensitive actions." }
        },
        required: ["deviceIds", "capabilityId", "newValue"],
        additionalProperties: false
      },
      handler: async ({ deviceIds, capabilityId, newValue, expected_zone, allow_cross_zone, confirmed }) => {
        
        const originalCount = Array.isArray(deviceIds) ? deviceIds.length : 0;
        const uniqueIds: string[] = Array.from(new Set((deviceIds || []).filter(Boolean) as string[]));
        const deduped = uniqueIds.length;
        
        if (deduped > 10 && confirmed !== true) {
          return { ok: false, error: { code: "CONFIRMATION_REQUIRED", message: `Refusing to change ${deduped} devices without explicit confirmation.` } };
        }

        this.logger.info('set_device_capability_bulk', 'TOOL', `devices=${deduped}/${originalCount}, cap=${capabilityId}, value=${newValue}`);

        try {
          const data = await this.deviceManager.setDeviceCapabilityBulk(uniqueIds, capabilityId, newValue, { expected_zone, allow_cross_zone, confirmed });
          return { ok: true, data, meta: { requested: originalCount, deduplicated: deduped } };
        } catch (error: any) {
          this.logger.error(`Error executing set_device_capability_bulk`, error);
          return { ok: false, error: { code: "BULK_SET_CAPABILITY_FAILED", message: "Could not set capability for multiple devices." } };
        }
      }
    });
  }
}
