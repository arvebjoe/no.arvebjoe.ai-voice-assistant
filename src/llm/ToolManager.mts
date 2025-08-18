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

export class ToolManager {
    private deviceManager: DeviceManager;
    private tools: Map<string, ToolDefinition> = new Map();
    private logger = createLogger("ToolManager");

    constructor(deviceManager: DeviceManager) {
        this.deviceManager = deviceManager; 
        this.registerDefaultTools();
    }

    /**
     * Register a new tool with both its definition and handler
     */
    registerTool(definition: ToolDefinition): void {
        this.logger.info(definition.name, "REGISTER TOOL");
        this.tools.set(definition.name, definition);
    }

    /**
     * Get all tool handlers for execution
     */
    getToolHandlers(): Record<string, ToolHandler> {
        const handlers: Record<string, ToolHandler> = {};
        for (const [name, tool] of this.tools) {
            handlers[name] = tool.handler;
        }
        return handlers;
    }

    /**
     * Get tool definitions in OpenAI format (without handlers)
     */
    getToolDefinitions(): Array<Omit<ToolDefinition, 'handler'>> {
        return Array.from(this.tools.values()).map(tool => ({
            type: tool.type,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        }));
    }

    /**
     * Get a specific tool definition by name
     */
    getToolDefinition(name: string): Omit<ToolDefinition, 'handler'> | undefined {
        const tool = this.tools.get(name);
        if (!tool) return undefined;
        
        return {
            type: tool.type,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        };
    }

    /**
     * Check if a tool exists
     */
    hasTool(name: string): boolean {
        return this.tools.has(name);
    }

    /**
     * Get all tool names
     */
    getToolNames(): string[] {
        return Array.from(this.tools.keys());
    }

    private registerDefaultTools(): void {
        // get_local_time tool
        this.registerTool({
            type: "function",
            name: "get_local_time",
            description: "Get the local time for a given IANA timezone or city name (default Europe/Oslo). Respond in concise Norwegian.",
            parameters: {
                type: "object",
                properties: {
                    timezone: {
                        type: "string",
                        description: "IANA timezone like 'Europe/Oslo'. If omitted, use Europe/Oslo.",
                    },
                    locale: {
                        type: "string",
                        description: "BCP-47 locale, default 'nb-NO'.",
                    },
                },
                required: [],
                additionalProperties: false,
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
                        year: "numeric",
                    });
                    const s = fmt.format(now);
                    this.logger.info('get_local_time', 'TOOL', `Klokken er ${s} i ${tz}.`);
                    return { text: `Klokken er ${s} i ${tz}.` };
                } catch {
                    const s = now.toLocaleString("nb-NO", { timeZone: "Europe/Oslo" });
                    this.logger.info('get_local_time', 'TOOL', `Klarte ikke å tolke tidssone '${tz}'. I Norge er klokken nå ${s}.`);
                    return {
                        text: `Klarte ikke å tolke tidssone '${tz}'. I Norge er klokken nå ${s}.`,
                    };
                }
            }
        });

        // ping_simple tool
        this.registerTool({
            type: "function",
            name: "ping_simple",
            description: "Enkel test: returnerer bare strengen 'pong'. Bruk når brukeren sier 'ping'.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
            },
            handler: () => {
                const out = "pong";
                this.logger.info("ping_simple", "TOOL", out);
                // Return *string* (not an object) to exercise the string path
                return out;
            }
        });

        // demo_list_kv tool
        this.registerTool({
            type: "function",
            name: "demo_list_kv",
            description: "Testverktøy: returnerer en kort liste med nøkkel=verdi-objekter. Bruk når brukeren spør om en testliste.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
            },
            handler: () => {
                // Example static list. You can randomize if you want.
                const items = [
                    { key: "build", value: "ok" },
                    { key: "version", value: "1.2.3" },
                    { key: "uptime", value: "42m" },
                ];
                this.logger.info("demo_list_kv", "TOOL");
                // Return an array of objects (will be JSON-stringified by sendFunctionResult)
                return items;
            }
        });
    }
}
