// Jev (TypeSafe) device-selection benchmark — repeatable, no voice, no Homey.
//
// Runs the smart_home tool's Jev path against a REAL device catalog exported
// from a Homey, using the app's own code end to end: DeviceManager builds the
// device list from the export (same order, same zone hierarchy, same
// capability strings), jevCandidates() applies the smart_home capability
// filter, buildRequests()/selectDevices() build and send the exact requests.
// Nothing is ever written to a device — it only asks Jev.
//
//   # 1) export the catalog from the selected Homey (read-only)
//   npm run jev-bench -- export
//
//   # 2) production path (hedging/re-sends as shipped), 10 rounds per command
//   npm run jev-bench -- run --room Kjøkkenet --rounds 10 --cmd "turn_on:lysene på kjøkkenet"
//
//   # 3) raw latency: every request once, no re-sends, long timeout — shows
//   #    whether one request index is consistently slow or hangs
//   npm run jev-bench -- raw --room Kjøkkenet --rounds 10 --cmd "turn_on:lysene på kjøkkenet"
//
//   # 4) size of every request (chars, ~tokens, devices, biggest question)
//   npm run jev-bench -- sizes --room Kjøkkenet --cmd "turn_on:lysene på kjøkkenet"
//
//   # 5) bisect one request (1-based) to find the questions that make it slow
//   npm run jev-bench -- bisect --request 2 --room Kjøkkenet --cmd "turn_on:lysene på kjøkkenet"
//
// --cmd is "<action>:<target>" or "<action>:<target>:<value>" and may repeat.
// Key: TYPESAFE_API_KEY, else emulator/settings.json → global.typesafe_api_key.
// Catalog: emulator/jev-catalog/{devices,zones}.json (git-ignored — it is a
// map of the user's home), or --catalog <dir>.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DeviceManager } from '../src/helpers/device-manager.mjs';
import type { Device } from '../src/helpers/interfaces.mjs';
import { jevCandidates, JEV_ACTIONS } from '../src/llm/jev/jev-actions.mjs';
import { buildRequests } from '../src/llm/jev/jev-device-selector.mjs';
import { benchProduction, benchRaw } from '../src/llm/jev/jev-benchmark.mjs';
import { TypeSafeClient, SystemOneRequest } from '../src/llm/jev/typesafe-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const mode = argv[0] && !argv[0].startsWith('--') ? argv.shift()! : 'run';
function flag(name: string): string | undefined {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
}
function flags(name: string): string[] {
    const out: string[] = [];
    argv.forEach((a, i) => { if (a === `--${name}` && argv[i + 1]) out.push(argv[i + 1]); });
    return out;
}
const catalogDir = resolve(flag('catalog') ?? resolve(__dirname, 'jev-catalog'));
const rounds = Number(flag('rounds') ?? 5);
const pauseMs = Number(flag('pause') ?? 1500);
const room = flag('room') ?? '';

type Command = { action: string; target: string; value?: number };
function parseCommand(spec: string): Command {
    const [action, target, value] = spec.split(':');
    if (!JEV_ACTIONS.includes(action) || !target) {
        throw new Error(`bad --cmd "${spec}" — use "<action>:<target>[:<value>]", action one of ${JEV_ACTIONS.join(', ')}`);
    }
    return { action, target, value: value !== undefined ? Number(value) : undefined };
}

// ---------------------------------------------------------------- helpers
const pct = (xs: number[], p: number) => {
    if (xs.length === 0) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const fmt = (xs: number[]) => xs.length
    ? `p50 ${pct(xs, 0.5)}  p90 ${pct(xs, 0.9)}  max ${Math.max(...xs)} ms`
    : 'no successes';

function apiKey(): string {
    const env = process.env.TYPESAFE_API_KEY?.trim();
    if (env) return env;
    const settingsPath = resolve(__dirname, 'settings.json');
    if (existsSync(settingsPath)) {
        const key = JSON.parse(readFileSync(settingsPath, 'utf8'))?.global?.typesafe_api_key?.trim();
        if (key) return key;
    }
    throw new Error('No TypeSafe key: set TYPESAFE_API_KEY or emulator/settings.json → global.typesafe_api_key');
}

async function loadDevices(): Promise<Device[]> {
    const devicesPath = resolve(catalogDir, 'devices.json');
    const zonesPath = resolve(catalogDir, 'zones.json');
    if (!existsSync(devicesPath) || !existsSync(zonesPath)) {
        throw new Error(`No catalog in ${catalogDir} — run "npm run jev-bench -- export" first`);
    }
    const devices = JSON.parse(readFileSync(devicesPath, 'utf8'));
    const zones = JSON.parse(readFileSync(zonesPath, 'utf8'));
    // The real DeviceManager transform, fed from the export instead of the API.
    const fakeApi = {
        zones: { getZones: async () => zones },
        devices: { getDevices: async () => devices },
    };
    const dm = new DeviceManager({} as any, fakeApi as any);
    await dm.fetchData();
    const all: Device[] = [];
    let token: string | null = null;
    do {
        const page = dm.getSmartHomeDevices(undefined, undefined, 100, token);
        all.push(...page.devices);
        token = page.next_page_token;
    } while (token);
    return all;
}

function requestSize(r: SystemOneRequest) {
    const json = JSON.stringify(r);
    const ids = Object.keys(r.questions);
    const devices = new Set(ids.map(id => id.split('__')[0])).size;
    let biggest = { id: '', chars: 0 };
    for (const id of ids) {
        const chars = JSON.stringify(r.questions[id]).length;
        if (chars > biggest.chars) biggest = { id, chars };
    }
    return { chars: json.length, approxTokens: Math.round(json.length / 4), devices, questions: ids.length, biggest };
}

// ---------------------------------------------------------------- modes
async function doExport() {
    mkdirSync(catalogDir, { recursive: true });
    for (const [manager, op, file] of [['devices', 'get-devices', 'devices.json'], ['zones', 'get-zones', 'zones.json']]) {
        const out = execFileSync('homey', ['api', manager, op, '--json'], { maxBuffer: 64 * 1024 * 1024 }).toString();
        JSON.parse(out); // fail loudly on anything that is not JSON
        writeFileSync(resolve(catalogDir, file), out);
        console.log(`wrote ${resolve(catalogDir, file)} (${out.length} bytes)`);
    }
}

async function doSizes(devices: Device[], cmd: Command) {
    const candidates = jevCandidates(cmd.action, devices, cmd.value);
    const requests = buildRequests(cmd.target, room, candidates);
    console.log(`${cmd.action} "${cmd.target}": ${candidates.length} candidates, ${requests.length} requests`);
    requests.forEach((r, i) => {
        const s = requestSize(r);
        const firstIdx = Number(Object.keys(r.questions)[0].slice(1).split('__')[0]);
        const names = candidates.slice(firstIdx, firstIdx + s.devices).map(d => d.name);
        console.log(`  #${i + 1}: ${s.devices} devices, ${s.questions} questions, ${s.chars} chars (~${s.approxTokens} tokens), biggest ${s.biggest.id} ${s.biggest.chars} chars`);
        console.log(`       ${names.join(' | ')}`);
    });
}

async function doRun(client: TypeSafeClient, devices: Device[], cmd: Command) {
    const candidates = jevCandidates(cmd.action, devices, cmd.value);
    console.log(`\n== run: ${cmd.action} "${cmd.target}" (room ${room || '—'}), ${candidates.length} candidates, ${rounds} rounds`);
    const results = await benchProduction(client, candidates, { target: cmd.target, room }, rounds, pauseMs);
    const selections = new Map<string, number>();
    for (const r of results) {
        if (!r.ok) { console.log(`  ${r.round}: FAILED after ${r.ms} ms: ${r.error}`); continue; }
        const key = r.selected!.join(', ') || '(none)';
        selections.set(key, (selections.get(key) ?? 0) + 1);
        console.log(`  ${r.round}: ${r.ms} ms  [${r.requests!.map(q => `${q.ms}${'*'.repeat(q.attempts - 1)}`).join('/')}]  → ${key}`);
        console.log(`       top: ${r.top}`);
    }
    const ok = results.filter(r => r.ok);
    const resends = ok.reduce((n, r) => n + r.requests!.reduce((m, q) => m + q.attempts - 1, 0), 0);
    const tokens = ok.reduce((n, r) => n + (r.tokens ?? 0), 0);
    console.log(`  total: ${fmt(ok.map(r => r.ms))}; failures ${results.length - ok.length}/${results.length}; re-sends ${resends}; ~${Math.round(tokens / Math.max(1, ok.length))} tokens/command`);
    console.log(`  selections:`);
    for (const [k, n] of selections) console.log(`    ${n}× ${k}`);
}

async function doRaw(devices: Device[], cmd: Command, key: string) {
    const candidates = jevCandidates(cmd.action, devices, cmd.value);
    const requests = buildRequests(cmd.target, room, candidates);
    console.log(`\n== raw: ${cmd.action} "${cmd.target}", ${requests.length} requests × ${rounds} rounds (no re-sends, 20 s timeout)`);
    const results = await benchRaw(key, candidates, { target: cmd.target, room }, rounds, pauseMs);
    for (const r of results) {
        console.log(`  ${r.round}: [${r.requests.map(q => q.error ? `ERR(${q.ms})` : `${q.ms}`).join(' / ')}]`);
    }
    requests.forEach((req, i) => {
        const s = requestSize(req);
        const ok = results.map(r => r.requests[i]).filter(q => !q.error).map(q => q.ms);
        console.log(`  #${i + 1} (${s.devices} devices, ~${s.approxTokens} tokens): ${fmt(ok)}; errors ${results.length - ok.length}/${results.length}`);
    });
}

async function doBisect(devices: Device[], cmd: Command, key: string) {
    const n = Number(flag('request') ?? 1);
    const tries = Number(flag('tries') ?? 3);
    const client = new TypeSafeClient({ apiKey: key, maxAttempts: 1, timeoutMs: 15_000, deadlineMs: 20_000 });
    const candidates = jevCandidates(cmd.action, devices, cmd.value);
    const requests = buildRequests(cmd.target, room, candidates);
    const request = requests[n - 1];
    if (!request) throw new Error(`no request #${n} (there are ${requests.length})`);

    // Split by DEVICE (all of a device's questions stay together) and keep each
    // question byte-identical to production — only the grouping changes.
    const byDevice = new Map<string, string[]>();
    for (const id of Object.keys(request.questions)) {
        const dev = id.split('__')[0];
        byDevice.set(dev, [...(byDevice.get(dev) ?? []), id]);
    }
    const nameOf = (dev: string) => candidates[Number(dev.slice(1))]?.name ?? dev;
    const time = async (devs: string[]) => {
        const questions = Object.fromEntries(devs.flatMap(d => byDevice.get(d)!).map(id => [id, request.questions[id]]));
        const samples: number[] = [];
        for (let t = 0; t < tries; t++) {
            const t0 = Date.now();
            try { await client.systemOne({ state: request.state, questions }); samples.push(Date.now() - t0); }
            catch { samples.push(Infinity); }
        }
        return samples;
    };

    let group = [...byDevice.keys()];
    console.log(`\n== bisect request #${n}: ${group.length} devices, ${tries} tries per half`);
    console.log(`  whole: ${(await time(group)).join(' / ')} ms`);
    while (group.length > 1) {
        const half = Math.ceil(group.length / 2);
        const [a, b] = [group.slice(0, half), group.slice(half)];
        const [ta, tb] = [await time(a), await time(b)];
        const worst = (xs: number[]) => Math.max(...xs);
        console.log(`  A (${a.length}): ${ta.join(' / ')}   B (${b.length}): ${tb.join(' / ')}`);
        group = worst(ta) >= worst(tb) ? a : b;
    }
    const dev = group[0];
    console.log(`  slowest single device: ${nameOf(dev)} (${dev})`);
    for (const id of byDevice.get(dev)!) {
        console.log(`    ${id}: ${JSON.stringify(request.questions[id]).length} chars`);
    }
    console.log(JSON.stringify(Object.fromEntries(byDevice.get(dev)!.map(id => [id, request.questions[id]])), null, 2));
}

// ---------------------------------------------------------------- main
async function main() {
    if (mode === 'export') return doExport();
    const commands = flags('cmd').map(parseCommand);
    if (commands.length === 0) commands.push({ action: 'turn_on', target: 'lysene på kjøkkenet' });
    const devices = await loadDevices();
    console.log(`catalog: ${devices.length} devices from ${catalogDir}`);
    if (mode === 'sizes') { for (const c of commands) await doSizes(devices, c); return; }
    const key = apiKey();
    for (const c of commands) {
        if (mode === 'run') await doRun(new TypeSafeClient({ apiKey: key }), devices, c);
        else if (mode === 'raw') await doRaw(devices, c, key);
        else if (mode === 'bisect') await doBisect(devices, c, key);
        else throw new Error(`unknown mode "${mode}" — export | sizes | run | raw | bisect`);
    }
}

main().then(() => process.exit(0), (error) => {
    console.error(error?.message ?? error);
    process.exit(1);
});
