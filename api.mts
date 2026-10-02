import { getVoicesForProvider, DEFAULT_VOICE_PROVIDER } from './src/llm/voice-provider-factory.mjs';
import { testLocalStage, StageTestRequest, StageTestResult } from './src/llm/providers/local/stage-tester.mjs';
import { getLmStudioContext, LmStudioContextResult } from './src/llm/providers/local/lmstudio-context.mjs';
import { claudeModelOptions, ClaudeModelOption } from './src/llm/providers/local/claude-client.mjs';
import { OPENAI_COMPAT_PRESETS, OpenAiCompatPreset } from './src/llm/providers/local/openai-compat.mjs';
import { computeFeatureCosts, FeatureCostReport } from './src/settings/feature-costs.mjs';
import { sendTestLogLine, RemoteLogTestRequest, RemoteLogTestResult } from './src/helpers/remote-log.mjs';
import { seenDevices, SeenDeviceView } from './src/helpers/seen-devices.mjs';
import { probeEspDevice } from './src/voice_assistant/esp-probe.mjs';
import { recordingRegistry, Recording } from './src/helpers/recording-registry.mjs';
import { writeLogDump, LogDumpResult } from './src/helpers/log-dump.mjs';
import { settingsManager } from './src/settings/settings-manager.mjs';
import { TypeSafeClient } from './src/llm/jev/typesafe-client.mjs';
import { JEV_ACTIONS, jevCandidates } from './src/llm/jev/jev-actions.mjs';
import { benchProduction, benchRaw, ProductionRound, RawRound } from './src/llm/jev/jev-benchmark.mjs';

/**
 * App Web API — called from the settings page via `Homey.api(...)`.
 *
 * Routes are declared in `.homeycompose/app.json` under `api`; each key of the
 * default-exported object matches a route key. Handlers receive
 * `{ homey, query, params, body }`. (Homey's ESM loader expects a default-export
 * object of handlers, not named function exports.)
 */
export default {
    /**
     * GET /voices?provider=<id>[&tts=<backend>] — the voices the given provider
     * offers, so the settings UI can repopulate the voice dropdown when the
     * provider (or, for the local provider, its TTS backend) changes. Each
     * provider owns its own list (see getVoicesForProvider).
     */
    async getVoices({ query }: { query: Record<string, string> }): Promise<{ value: string; name: string }[]> {
        const provider = query?.provider || DEFAULT_VOICE_PROVIDER;
        return getVoicesForProvider(provider, query?.tts || undefined);
    },

    /**
     * GET /openai-presets — the ready-made servers for the OpenAI-compatible
     * pipeline backends, per stage, so the settings page can offer a "Server"
     * dropdown that fills in the base URL instead of making the user type
     * `https://api.openai.com/v1` from memory. Served from the app so the
     * page and the pipeline agree on which hosts need an API key.
     */
    async getOpenAiPresets(): Promise<Record<string, OpenAiCompatPreset[]>> {
        return OPENAI_COMPAT_PRESETS;
    },

    /**
     * POST /test-local-stage — test one local-pipeline stage (stt/llm/tts)
     * against the CURRENT (possibly unsaved) settings-form values. Runs from
     * the Homey box because the settings webview can't reach LAN services
     * itself. Never throws — failures come back as { ok:false, message }.
     */
    async testLocalStage({ body }: { body: StageTestRequest }): Promise<StageTestResult> {
        return testLocalStage(body);
    },

    /**
     * GET /lmstudio-context?host=<h>&port=<p>&model=<id> — the context window
     * of the LM Studio model the pipeline would use, read live from LM
     * Studio's REST API with the CURRENT (possibly unsaved) settings-form
     * values, so the budget meter can give a real verdict for the lmstudio
     * backend. Never throws — failures come back as { ok:false, message }.
     */
    async getLmStudioContext({ query }: { query: Record<string, string> }): Promise<LmStudioContextResult> {
        return getLmStudioContext({ host: query?.host, port: query?.port, model: query?.model });
    },

    /**
     * POST /claude-models { key } — the models the given Anthropic key can
     * use (GET /v1/models), so the settings page can offer a dropdown instead
     * of a free-text model id. POST rather than GET because the key would
     * otherwise ride in a URL; it comes from the CURRENT (possibly unsaved)
     * form value, like the Test buttons. Never throws — a missing or rejected
     * key comes back as the lone "" default option plus a `message`.
     */
    async getClaudeModels({ body }: { body: { key?: string } }): Promise<{ options: ClaudeModelOption[]; message: string }> {
        return claudeModelOptions(body?.key ?? '');
    },

    /**
     * GET /feature-costs?language=<code>&name=<language name> — per-feature
     * LLM context costs (approximate tokens) computed live from the real
     * instruction modules and tool definitions, for the settings page's
     * budget panel. See docs/cost-of-growth.md.
     */
    async getFeatureCosts({ homey, query }: { homey: any; query: Record<string, string> }): Promise<FeatureCostReport> {
        const app = homey.app as any;
        return computeFeatureCosts(
            {
                homey,
                deviceManager: app.deviceManager,
                geoHelper: app.geoHelper,
                weatherHelper: app.weatherHelper,
            },
            query?.language || 'en',
            query?.name || 'English',
        );
    },

    /**
     * POST /test-remote-log — send one syslog test line with the CURRENT
     * (possibly unsaved) settings-form values, so the user can verify the
     * collector address before saving. Never throws — failures come back
     * as { ok:false, message }.
     */
    async testRemoteLog({ body }: { body: RemoteLogTestRequest }): Promise<RemoteLogTestResult> {
        return sendTestLogLine(body);
    },

    /**
     * GET /seen-devices — every ESPHome device Homey's mDNS discovery has
     * surfaced (see DiscoveryWatcher), with the fields the pair flow matches on
     * and the outcome of the capability probe. Backs the Debug page's
     * "Last seen devices" list.
     */
    async getSeenDevices(): Promise<{ devices: SeenDeviceView[]; now: number }> {
        return { devices: seenDevices.list(), now: Date.now() };
    },

    /**
     * POST /probe-device — re-run the capability probe for one entry in that
     * list (the "Probe" button), so a device that was booting when the
     * background probe ran can be re-checked without a pair session. Never
     * throws: an unreachable device comes back as a probe status.
     */
    async probeSeenDevice({ homey, body }: { homey: any; body: { id?: string; encryptionKey?: string } }): Promise<{ ok: boolean; message: string; device?: SeenDeviceView }> {
        const id = (body?.id ?? '').trim();
        const entry = id ? seenDevices.get(id) : undefined;
        if (!entry) {
            return { ok: false, message: 'Unknown device' };
        }
        if (!entry.address) {
            return { ok: false, message: 'No address known for this device' };
        }

        const result = await probeEspDevice(homey, {
            host: entry.address,
            port: entry.port,
            encryptionKey: (body?.encryptionKey ?? '').trim() || undefined,
            timeoutMs: 6000,
        });
        seenDevices.recordProbe(id, result, 'manual');

        return {
            ok: result.status === 'accessible',
            message: result.message || result.status,
            device: seenDevices.list().find((d) => d.id === id),
        };
    },

    /**
     * GET /recordings — the retained microphone recordings ("what did I just
     * say?"), newest first, with what speech-to-text made of each one.
     */
    /**
     * POST /dump-log — write the redacted in-memory log buffer to
     * /userdata/log/<datetime>.txt and return its LAN URL (plus the text, for
     * the page's copy button). The file is deleted after DUMP_TTL_MS.
     */
    async dumpLog({ homey }: { homey: any }): Promise<{ ok: boolean; message: string; dump?: LogDumpResult }> {
        try {
            const webServer = homey.app?.webServer;
            const buildUrl = webServer
                ? (f: string) => webServer.buildUserdataUrl('log', f)
                : (f: string) => `/app/${homey.manifest.id}/userdata/log/${encodeURIComponent(f)}`;
            const dump = await writeLogDump(homey, buildUrl);
            return { ok: true, message: `Wrote ${dump.lines} lines`, dump };
        } catch (err: any) {
            return { ok: false, message: `Could not write the log dump: ${err?.message ?? err}` };
        }
    },

    async getRecordings(): Promise<{ recordings: Recording[]; now: number }> {
        return { recordings: recordingRegistry.list(), now: Date.now() };
    },

    /**
     * POST /play-recording — play one retained recording back on the satellite
     * that recorded it. The settings webview can't play the LAN audio URL
     * itself (it is served over plain http), so playback goes to the device.
     */
    async playRecording({ body }: { body: { id?: string } }): Promise<{ ok: boolean; message: string }> {
        const id = (body?.id ?? '').trim();
        const recording = id ? recordingRegistry.get(id) : undefined;
        if (!recording) {
            return { ok: false, message: 'That recording is gone (retention window passed)' };
        }
        const result = await recordingRegistry.play([recording]);
        return { ok: result.played > 0, message: result.message };
    },

    /**
     * POST /jev-bench — measure the Jev (TypeSafe) device lookup FROM THE
     * HOMEY, without voice: the same code the smart_home tool runs, against
     * the live device catalog, repeated. Never writes to a device. Debug only;
     * it spends TypeSafe tokens, so rounds are capped.
     *
     * Body: { mode: 'run' | 'raw', target, action?, value?, room?, rounds?, pauseMs? }
     * (see src/llm/jev/jev-benchmark.mts for what the two modes measure).
     */
    async jevBench({ homey, body }: { homey: any; body: any }): Promise<{
        ok: boolean; message: string; mode?: string; candidates?: number;
        production?: ProductionRound[]; raw?: RawRound[];
    }> {
        const apiKey = (settingsManager.getGlobal<string>('typesafe_api_key', '') || '').trim();
        if (!apiKey) return { ok: false, message: 'No TypeSafe API key in the app settings' };
        const mode = body?.mode === 'raw' ? 'raw' : 'run';
        const action = body?.action ?? 'turn_on';
        const target = String(body?.target ?? '').trim();
        if (!JEV_ACTIONS.includes(action) || !target) {
            return { ok: false, message: `Need a target and an action (one of ${JEV_ACTIONS.join(', ')})` };
        }
        const value = body?.value !== undefined ? Number(body.value) : undefined;
        const rounds = Math.min(20, Math.max(1, Number(body?.rounds) || 5));
        const pauseMs = Math.min(10_000, Math.max(0, Number(body?.pauseMs) || 1_000));
        const room = String(body?.room ?? '');

        const deviceManager = homey.app?.deviceManager;
        await deviceManager.fetchData();
        const all: any[] = [];
        let token: string | null = null;
        do {
            const page: { devices: any[]; next_page_token: string | null } = deviceManager.getSmartHomeDevices(undefined, undefined, 100, token);
            all.push(...page.devices);
            token = page.next_page_token;
        } while (token);
        const candidates = jevCandidates(action, all, value);

        const cmd = { target, room };
        if (mode === 'raw') {
            const raw = await benchRaw(apiKey, candidates, cmd, rounds, pauseMs);
            return { ok: true, message: 'done', mode, candidates: candidates.length, raw };
        }
        const production = await benchProduction(new TypeSafeClient({ apiKey }), candidates, cmd, rounds, pauseMs);
        return { ok: true, message: 'done', mode, candidates: candidates.length, production };
    },

    /**
     * POST /agent-bench — time a TYPED command through the live voice provider
     * (no audio): the whole agent turn, every tool call, and the provider's
     * token usage. Compares the classic device tools with Jev when called with
     * `jev: false` and `jev: true`: the route flips `jev_enabled` for the run,
     * waits for the provider to restart with the new tool set, and restores
     * the user's setting afterwards. Real tools run — a control command really
     * switches devices; a status question is read-only. Debug only.
     *
     * Body: { text, rounds?, pauseMs?, jev?: boolean, device?: <name substring> }
     */
    async agentBench({ homey, body }: { homey: any; body: any }): Promise<any> {
        const text = String(body?.text ?? '').trim();
        if (!text) return { ok: false, message: 'Need text' };
        const rounds = Math.min(10, Math.max(1, Number(body?.rounds) || 3));
        const pauseMs = Math.min(10_000, Math.max(0, Number(body?.pauseMs) || 1_500));

        const wanted = String(body?.device ?? '').toLowerCase();
        const device = Object.values<any>(homey.drivers.getDrivers())
            .flatMap((driver: any) => driver.getDevices())
            .find((d: any) => typeof d.benchAsk === 'function' && d.benchState().connected
                && (!wanted || d.getName().toLowerCase().includes(wanted)));
        if (!device) return { ok: false, message: 'No voice assistant device with a connected provider' };

        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        const waitFor = async (jev: boolean) => {
            for (let i = 0; i < 60; i++) {
                const st = device.benchState();
                if (st.jev === jev && st.connected) { await sleep(2_000); return true; }
                await sleep(500);
            }
            return false;
        };
        const original = homey.settings.get('jev_enabled');
        const wantJev = typeof body?.jev === 'boolean' ? body.jev : undefined;
        try {
            if (wantJev !== undefined && device.benchState().jev !== wantJev) {
                homey.settings.set('jev_enabled', wantJev);
                // Give the settings pub/sub a moment to start the restart, so
                // waitFor doesn't see the OLD connection as ready.
                await sleep(1_000);
                if (!(await waitFor(wantJev))) {
                    return { ok: false, message: `Provider did not come back with jev=${wantJev} within 30 s`, state: device.benchState() };
                }
            }
            const state = device.benchState();
            const results: any[] = [];
            for (let round = 1; round <= rounds; round++) {
                try {
                    results.push({ round, ...(await device.benchAsk(text)) });
                } catch (error: any) {
                    results.push({ round, error: error?.message ?? String(error) });
                }
                if (round < rounds) await sleep(pauseMs);
            }
            return { ok: true, message: 'done', device: device.getName(), state, results };
        } finally {
            if (wantJev !== undefined && homey.settings.get('jev_enabled') !== original) {
                homey.settings.set('jev_enabled', original);
            }
        }
    },
};
