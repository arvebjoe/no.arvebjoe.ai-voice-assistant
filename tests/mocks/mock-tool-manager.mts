/**
 * Minimal ToolManager stand-in for provider tests. Providers need tool
 * definitions (for the session config), execute() (to run a tool call), and
 * setStandardZone (called from updateZone). execute() mirrors the real
 * ToolManager.execute contract: never throws, `failed` true only when the
 * handler threw.
 */
export function fakeToolManager(
    handlers: Record<string, (args: any) => any> = {},
    defs: any[] = [],
) {
    return {
        getToolDefinitions: () => defs,
        getToolHandlers: () => handlers,
        setStandardZone: () => { },
        execute: async (name: string, args: any): Promise<{ output: any; failed: boolean }> => {
            const fn = handlers[name];
            if (!fn) {
                return { output: { error: `Unknown tool: ${name}` }, failed: false };
            }
            try {
                return { output: await fn(args ?? {}), failed: false };
            } catch (err: any) {
                return { output: { error: String(err?.message ?? err) }, failed: true };
            }
        },
    };
}
