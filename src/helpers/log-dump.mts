import { promises as fs } from 'fs';
import { logBuffer, formatEntry, formatTimestamp, LogBufferEntry } from './log-buffer.mjs';
import { isVerboseLogging, createLogger } from './logger.mjs';
import { settingsManager } from '../settings/settings-manager.mjs';

const log = createLogger('LOGDUMP', true);

/**
 * "Dump log" (Settings → Debug): write the redacted ring buffer to a file under
 * Homey's userdata volume and hand back its LAN URL. Homey serves an app's
 * userdata folder over plain HTTP (`/app/<id>/userdata/...` — the same mapping
 * reply audio already rides on), so the user opens the URL on a phone or laptop
 * and has a real file to attach to a forum post, an e-mail or a GitHub issue.
 *
 * The path is unauthenticated but LAN-only, and every dump is deleted after
 * `DUMP_TTL_MS` (and the whole folder is wiped at app start). Design notes:
 * TODO.md → "Getting a full log out of a user".
 */

/** How long a dump stays downloadable. */
export const DUMP_TTL_MS = 30 * 60_000;

/**
 * Where dumps are written. On a Homey this is the app's /userdata volume; the
 * emulator points it somewhere writable with HE_LOG_DIR. The URL path
 * (/app/<id>/userdata/log/...) is Homey's public mapping and is unaffected.
 */
export function logDumpDir(): string {
    return process.env.HE_LOG_DIR?.trim() || '/userdata/log';
}

export interface LogDumpResult {
    filename: string;
    /** LAN URL the settings page shows/links. */
    url: string;
    /** The dump itself, for the page's copy-to-clipboard fallback. */
    text: string;
    lines: number;
    /** Epoch ms when the file is deleted. */
    expiresAt: number;
}

/** Create/empty the dump folder. Dumps are ephemeral, so nothing survives a restart. */
export async function initLogDumpFolder(): Promise<void> {
    try {
        const dir = logDumpDir();
        await fs.mkdir(dir, { recursive: true });
        const files = await fs.readdir(dir);
        await Promise.all(files.map((f) => fs.unlink(`${dir}/${f}`).catch(() => { })));
    } catch (err) {
        log.warn('Could not initialize the log dump folder:', err);
    }
}

/** `2026-08-27_21-03-11` in the Homey's time zone — sorts, and is safe in a URL. */
export function dumpFilename(at: number, timeZone?: string): string {
    const stamp = formatTimestamp(at, timeZone).slice(0, 19).replace(' ', '_').replace(/:/g, '-');
    return `${stamp}.txt`;
}

// Settings worth a line in the header: what is selected, never any value that
// could be a secret. Keys are masked to presence only.
const HEADER_SETTINGS = [
    'voice_provider', 'language', 'voice',
    'local_stt_provider', 'local_llm_provider', 'local_tts_provider',
    'weather_enabled', 'web_search_provider', 'timers_enabled', 'bring_enabled', 'music_assistant_enabled', 'jev_enabled',
    'zone_fallback_enabled', 'allow_unlock_via_voice',
    'remote_log_enabled', 'debug_audio_enabled',
];
const HEADER_KEY_PRESENCE = ['openai_api_key', 'gemini_api_key', 'mistral_api_key', 'claude_api_key', 'typesafe_api_key'];

export function buildDumpText(homey: any, entries: LogBufferEntry[], now: number, timeZone?: string): string {
    const manifest = homey?.manifest ?? {};
    const head: string[] = [
        `AI Voice Assistant — log dump`,
        `Created:      ${formatTimestamp(now, timeZone)}${timeZone ? ` (${timeZone})` : ''}`,
        `App:          ${manifest.id ?? '?'} ${manifest.version ?? '?'}`,
        `Homey:        ${safe(() => homey.version) ?? '?'} (${safe(() => homey.platform) ?? '?'} ${safe(() => homey.platformVersion) ?? ''})`.trimEnd(),
        `Node:         ${process.version}`,
        `Verbose log:  ${isVerboseLogging() ? 'on' : 'off'} (this dump always includes the quieted subsystems)`,
        `Lines:        ${entries.length}${logBuffer.droppedCount() ? ` (${logBuffer.droppedCount()} older lines fell off the buffer)` : ''}`,
        ``,
        `Settings (selection only — no secrets):`,
    ];
    for (const key of HEADER_SETTINGS) {
        const v = safe(() => settingsManager.getGlobal(key));
        if (v !== undefined && v !== null && v !== '') head.push(`  ${key} = ${String(v)}`);
    }
    for (const key of HEADER_KEY_PRESENCE) {
        const v = safe(() => settingsManager.getGlobal<string>(key));
        head.push(`  ${key} = ${v ? 'set' : 'not set'}`);
    }
    head.push('', 'Devices:');
    const devices = listDeviceSummaries(homey);
    if (devices.length === 0) head.push('  (no voice satellites paired)');
    for (const line of devices) head.push(`  ${line}`);
    head.push('',
        'Redacted before writing: API keys and tokens, what was said (transcripts and replies are',
        'replaced by "<N chars redacted>"), and coordinates (rounded to ~10 km). Private LAN addresses',
        'are kept on purpose.',
        '', '---', '');
    const body = entries.map((e) => formatEntry(e, timeZone));
    return `${head.join('\n')}${body.join('\n')}\n`;
}

/**
 * Write the dump and schedule its deletion. `buildUrl(filename)` is the
 * webserver's userdata URL builder (LAN IP re-resolved per call).
 */
export async function writeLogDump(homey: any, buildUrl: (filename: string) => string, now: number = Date.now()): Promise<LogDumpResult> {
    const timeZone = safe(() => homey.clock.getTimezone()) as string | undefined;
    const entries = logBuffer.snapshot();
    const text = buildDumpText(homey, entries, now, timeZone);
    const dir = logDumpDir();
    await fs.mkdir(dir, { recursive: true });
    let filename = dumpFilename(now, timeZone);
    let filepath = `${dir}/${filename}`;
    // Two dumps in the same second would collide; suffix rather than overwrite.
    if (await exists(filepath)) {
        filename = filename.replace(/\.txt$/, `-${now % 1000}.txt`);
        filepath = `${dir}/${filename}`;
    }
    await fs.writeFile(filepath, text, 'utf8');

    const timer = homey?.setTimeout ? homey.setTimeout.bind(homey) : setTimeout;
    timer(() => {
        fs.unlink(filepath).catch(() => { });
    }, DUMP_TTL_MS);

    const url = buildUrl(filename);
    log.info(`Log dump written: ${filepath} (${entries.length} lines) → ${url}`);
    return { filename, url, text, lines: entries.length, expiresAt: now + DUMP_TTL_MS };
}

/**
 * One line per paired satellite, via each device's `diagnosticSummary()`. Any
 * failure degrades to a note — the dump must never fail because of this.
 */
export function listDeviceSummaries(homey: any): string[] {
    const out: string[] = [];
    try {
        const drivers = homey?.drivers?.getDrivers?.() ?? {};
        for (const driver of Object.values(drivers) as any[]) {
            let devices: any[] = [];
            try { devices = driver?.getDevices?.() ?? []; } catch { continue; }
            for (const device of devices) {
                try {
                    out.push(typeof device?.diagnosticSummary === 'function'
                        ? device.diagnosticSummary()
                        : `${driver?.id ?? '?'} "${device?.getName?.() ?? '?'}"`);
                } catch (err: any) {
                    out.push(`${driver?.id ?? '?'}: summary failed (${err?.message ?? err})`);
                }
            }
        }
    } catch (err: any) {
        out.push(`(device list unavailable: ${err?.message ?? err})`);
    }
    return out;
}

async function exists(p: string): Promise<boolean> {
    try { await fs.access(p); return true; } catch { return false; }
}

function safe<T>(fn: () => T): T | undefined {
    try { return fn(); } catch { return undefined; }
}
