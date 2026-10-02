import { buildRequests, selectDevices, formatRanked, JevCandidate } from './jev-device-selector.mjs';
import { TypeSafeClient } from './typesafe-client.mjs';

/**
 * Repeatable Jev measurements, shared by the app's POST /jev-bench route (runs
 * ON the Homey, so its network path is what gets measured) and the emulator's
 * jev-bench script (runs on a dev machine). Both call the same code, so their
 * numbers compare directly. Nothing here ever writes to a device.
 *
 *  - production: selectDevices() exactly as smart_home calls it — re-sends,
 *    deadline and all. Answers "how does the shipped path behave".
 *  - raw: every request once, no re-sends, long timeout. Answers "what does
 *    the service/network actually do" — a hang shows up as an error instead of
 *    being papered over by a re-send.
 */

export interface BenchCommand {
    target: string;
    room: string;
}

export interface ProductionRound {
    round: number;
    ok: boolean;
    ms: number;
    /** Per request: wall time and attempts (1 = no re-send). */
    requests?: { ms: number; attempts: number }[];
    selected?: string[];
    /** Best five with their scores — the same line smart_home logs. */
    top?: string;
    tokens?: number;
    error?: string;
}

export interface RawRound {
    round: number;
    /** Per request: wall time, and the error when it failed. */
    requests: { ms: number; error?: string }[];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function benchProduction(
    client: TypeSafeClient,
    candidates: JevCandidate[],
    cmd: BenchCommand,
    rounds: number,
    pauseMs: number,
): Promise<ProductionRound[]> {
    const out: ProductionRound[] = [];
    for (let round = 1; round <= rounds; round++) {
        const started = Date.now();
        try {
            const sel = await selectDevices(client, cmd.target, cmd.room, candidates);
            out.push({
                round, ok: true, ms: sel.elapsedMs,
                requests: sel.requestStats,
                selected: sel.selected.map(d => d.name).sort(),
                top: formatRanked(sel.ranked.slice(0, 5)),
                tokens: sel.inputTokens,
            });
        } catch (error: any) {
            out.push({ round, ok: false, ms: Date.now() - started, error: error?.message ?? String(error) });
        }
        if (round < rounds) await sleep(pauseMs);
    }
    return out;
}

export async function benchRaw(
    apiKey: string,
    candidates: JevCandidate[],
    cmd: BenchCommand,
    rounds: number,
    pauseMs: number,
    timeoutMs: number = 20_000,
): Promise<RawRound[]> {
    const client = new TypeSafeClient({ apiKey, maxAttempts: 1, timeoutMs, deadlineMs: timeoutMs + 1_000 });
    const requests = buildRequests(cmd.target, cmd.room, candidates);
    const out: RawRound[] = [];
    for (let round = 1; round <= rounds; round++) {
        const results = await Promise.all(requests.map(async (r) => {
            const started = Date.now();
            try {
                await client.systemOne(r);
                return { ms: Date.now() - started };
            } catch (error: any) {
                return { ms: Date.now() - started, error: error?.message ?? String(error) };
            }
        }));
        out.push({ round, requests: results });
        if (round < rounds) await sleep(pauseMs);
    }
    return out;
}

export function percentile(xs: number[], p: number): number | null {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
