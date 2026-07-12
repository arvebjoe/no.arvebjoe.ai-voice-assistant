// Homey Emulator (HE) entry point.
//
// Boots the AI Voice Assistant app as a plain Node process: constructs the fake
// `homey` context, the App, and one driver + device per satellite configured in
// settings.json, then drops you into an interactive console to drive the LLM
// and inspect the dummy devices. Satellites can also be found on the LAN and
// added from the console (`discover`).
//
// Run via:  npm run emulator
// (which is: node --import tsx --import ./emulator/register.mjs ./emulator/main.mts)
import { createInterface } from 'node:readline';
import { getHomey } from './runtime/homey-context.mjs';
import { world } from './runtime/fake-world.mjs';
import { startAudioServer } from './runtime/audio-server.mjs';
import { startSettingsWeb } from './runtime/settings-web.mjs';
import { config, getSatellites, settingsPath, EmulatorSatellite } from './config.mjs';
import { runDiscovery } from './runtime/discovery.mjs';
import { listRecordings, loadRecording, resolveRecording, recordingsDir } from './runtime/recordings.mjs';
import { injectRecording } from './runtime/mic-injector.mjs';
import { flowCards } from './runtime/flow-cards.mjs';

import App from '../app.mjs';
import PEDriver from '../drivers/home-assistant-voice-preview-edition/driver.mjs';
import PEDevice from '../drivers/home-assistant-voice-preview-edition/device.mjs';
import XiaozhiDriver from '../drivers/xiaozhi-ai/driver.mjs';
import XiaozhiDevice from '../drivers/xiaozhi-ai/device.mjs';

// Capabilities the drivers declare (drivers/.../driver.compose.json).
const SAT_CAPABILITIES = [
  'volume_set', 'onoff', 'volume_mute', 'timer_active', 'timer_remaining', 'timer_name',
];

interface BootedSatellite {
  sat: EmulatorSatellite;
  device: any;
}

// One driver instance per assistant type (mirrors the app: the flow-card
// listeners are registered once, guarded inside VoiceAssistantDriver).
const driverCache: Record<string, any> = {};

async function getDriver(type: string): Promise<any> {
  if (!driverCache[type]) {
    const DriverClass: any = type === 'xiaozhi' ? XiaozhiDriver : PEDriver;
    const driver = new DriverClass({ discovery: { getDiscoveryResults: () => ({}) } });
    await driver.onInit();
    driverCache[type] = driver;
  }
  return driverCache[type];
}

async function bootSatellite(sat: EmulatorSatellite): Promise<BootedSatellite> {
  const type = sat.type ?? 'pe';
  const driver = await getDriver(type);
  const DeviceClass: any = type === 'xiaozhi' ? XiaozhiDevice : PEDevice;

  const device = new DeviceClass({
    driver,
    data: { id: sat.mac, name: sat.name },
    store: {
      address: sat.address,
      port: sat.port ?? 6053,
      mac: sat.mac,
      deviceType: type,
      platform: 'esp32',
      serviceName: sat.name,
    },
    settings: sat.settings ?? {},
    capabilities: SAT_CAPABILITIES,
  });
  await device.onInit();
  console.log(`Booted satellite: ${sat.name} (${type}) @ ${sat.address}:${sat.port ?? 6053}`);
  return { sat, device };
}

async function main(): Promise<void> {
  const homey = getHomey();

  console.log('\n=== Homey Emulator (HE) ===');
  console.log(`Settings: ${settingsPath}`);

  if (!config.global?.openai_api_key) {
    console.warn('⚠  No openai_api_key in settings.json — the agent will not connect.');
  }

  await startAudioServer();

  // 1. App — builds settingsManager, GeoHelper, WeatherHelper, WebServer,
  //    ApiHelper and DeviceManager onto the instance.
  const app: any = new (App as any)();
  homey.app = app;
  await app.onInit();

  // 2. The settings web UI — the app's real settings page in a browser,
  //    saving through to the fake homey.settings AND settings.json.
  const settingsWebUrl = await startSettingsWeb(homey);

  // 3. One driver + device per configured satellite.
  const booted: BootedSatellite[] = [];
  for (const sat of getSatellites()) {
    booted.push(await bootSatellite(sat));
  }

  printBanner(booted, settingsWebUrl);
  startRepl(booted, homey);
}

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function printBanner(booted: BootedSatellite[], settingsWebUrl: string | null): void {
  console.log('\n---------------------------------------------------------------');
  if (settingsWebUrl) {
    console.log(`Settings UI: ${settingsWebUrl}  (saves write back to settings.json)`);
  }
  if (booted.length === 0) {
    console.log('No satellites configured — run `discover` to find and add one.');
  } else {
    for (const { sat } of booted) {
      console.log(`Satellite  : ${sat.name} (${sat.type})  @ ${sat.address}:${sat.port ?? 6053}  (mac ${sat.mac})`);
    }
    console.log('The ESP client will keep retrying if a satellite is unreachable.');
    console.log("Wait for 'Agent connection opened' before using ask/say/mic.");
  }
  console.log('---------------------------------------------------------------');
  printHelp();
}

function printHelp(): void {
  console.log(`
Commands:
  ask <text>        Ask the assistant; prints the text reply (tests tool calls, no satellite/mic needed)
  say <text>        Send text to the assistant and play the spoken reply on the satellite
  speak <text>      Direct TTS of <text> to the satellite (no LLM)
  mic <file>        Feed a recording (emulator/recordings/*.flac|wav) into the mic pipeline, as if spoken
  mic               List available recordings
  discover [sec]    Scan the LAN for ESPHome voice satellites and add them to settings.json
  sats              List configured satellites; the ▶ marks the one ask/say/speak/mic target
  use <name|#>      Switch the active satellite
  devices           List all dummy devices and their current capability values
  zones             List zones
  state <name|id>   Show one device's capabilities
  flow              List the app's flow cards; WHEN cards log automatically when fired (⚡)
  and <card>        Run an AND (condition) card on the active satellite; prints true/false
  then <card> [..]  Run a THEN (action) card on the active satellite (args: in order, or name=value)
  set <key> <val>   Change a global setting (e.g. set selected_voice nova) — rebuilds the agent
  help              Show this help
  quit              Exit
`);
}

function startRepl(booted: BootedSatellite[], homey: any): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'HE> ' });
  let activeIndex = 0;

  const active = (): BootedSatellite | null => booted[activeIndex] ?? null;
  const requireActive = (): BootedSatellite | null => {
    const a = active();
    if (!a) console.log('No satellite configured — run `discover` first.');
    return a;
  };

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    const sp = input.indexOf(' ');
    const cmd = (sp === -1 ? input : input.slice(0, sp)).toLowerCase();
    const arg = sp === -1 ? '' : input.slice(sp + 1).trim();

    try {
      switch (cmd) {
        case '':
          break;
        case 'help':
          printHelp();
          break;
        case 'ask': {
          if (!arg) { console.log('usage: ask <text>'); break; }
          const a = requireActive();
          if (!a) break;
          const reply = await a.device.askAgentOutputToText(arg);
          // askAgentOutputToText resolves on text.done, but a tool call produces
          // a final response.done ("Conversation completed") right after. Let it
          // flush so that trailing log lands above the reply, not under the prompt.
          await settle(400);
          console.log(`\n🤖 ${reply}\n`);
          break;
        }
        case 'say': {
          if (!arg) { console.log('usage: say <text>'); break; }
          const a = requireActive();
          if (!a) break;
          await a.device.askAgentOutputToSpeaker(arg);
          console.log('(sent — reply will play on the satellite)');
          break;
        }
        case 'speak': {
          if (!arg) { console.log('usage: speak <text>'); break; }
          const a = requireActive();
          if (!a) break;
          await a.device.speakText(arg);
          console.log('(spoken on the satellite)');
          break;
        }
        case 'mic': {
          if (!arg) {
            const files = listRecordings();
            console.log(files.length
              ? `Recordings in ${recordingsDir}:\n  ${files.join('\n  ')}`
              : `No recordings found. Drop .flac/.wav files into ${recordingsDir}`);
            break;
          }
          const a = requireActive();
          if (!a) break;
          const path = resolveRecording(arg);
          if (!path) { console.log(`No recording matching '${arg}' (try 'mic' to list them)`); break; }
          const rec = await loadRecording(path);
          console.log(`Injecting ${arg}: ${rec.durationMs} ms (source ${rec.sourceRate} Hz, ${rec.sourceChannels} ch) — streaming as mic audio...`);
          const result = await injectRecording(a.device, rec.pcm);
          console.log(result.ok
            ? `(recording sent, ${result.sentMs} ms incl. padding — transcript and reply follow in the log)`
            : `Cannot inject: ${result.reason}`);
          break;
        }
        case 'discover':
        case 'discovery': {
          const seconds = arg ? Number(arg) : 4;
          if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
            console.log('usage: discover [seconds 1-60]');
            break;
          }
          const added = await runDiscovery(rl, homey, seconds);
          const norm = (m: string) => m.replace(/[^0-9a-f]/gi, '').toLowerCase();
          const fresh = added.filter((sat) => {
            const running = booted.some((b) => norm(b.sat.mac) === norm(sat.mac));
            if (running) console.log(`${sat.name} is already running — settings.json updated only.`);
            return !running;
          });
          if (fresh.length > 0) {
            // Make the new satellites visible to the fake HomeyAPI and refresh
            // the DeviceManager catalog so zone registration resolves at boot.
            for (const sat of fresh) world.registerSatellite(sat);
            await homey.app?.deviceManager?.fetchData?.();
            for (const sat of fresh) booted.push(await bootSatellite(sat));
          }
          break;
        }
        case 'sats':
        case 'satellites': {
          if (booted.length === 0) { console.log('No satellites configured — run `discover`.'); break; }
          booted.forEach((b, i) => {
            const mark = i === activeIndex ? '▶' : ' ';
            const avail = b.device.getAvailable?.() ? 'online' : 'offline';
            console.log(` ${mark} [${i + 1}] ${b.sat.name} (${b.sat.type})  @ ${b.sat.address}:${b.sat.port ?? 6053}  — ${avail}`);
          });
          break;
        }
        case 'use': {
          if (!arg) { console.log('usage: use <name|#>'); break; }
          const byIndex = Number(arg);
          let idx = Number.isInteger(byIndex) ? byIndex - 1 : -1;
          if (idx < 0 || idx >= booted.length) {
            idx = booted.findIndex((b) => b.sat.name.toLowerCase().includes(arg.toLowerCase()));
          }
          if (idx < 0 || idx >= booted.length) { console.log(`No satellite matching '${arg}' (see 'sats')`); break; }
          activeIndex = idx;
          console.log(`Active satellite: ${booted[idx].sat.name}`);
          break;
        }
        case 'devices':
          console.log(world.renderDevices());
          break;
        case 'zones':
          console.log(world.renderZones());
          break;
        case 'state': {
          if (!arg) { console.log('usage: state <name|id>'); break; }
          console.log(world.renderDevice(arg));
          break;
        }
        case 'flow':
        case 'flows':
          console.log(flowCards.renderList());
          break;
        case 'and':
        case 'then': {
          const kind = cmd === 'and' ? 'condition' as const : 'action' as const;
          if (!arg) {
            console.log(`usage: ${cmd} <card>${cmd === 'then' ? ' [args]' : ''}   (see 'flow' for the cards)`);
            break;
          }
          const a = requireActive();
          if (!a) break;
          const sp2 = arg.indexOf(' ');
          const cardQuery = sp2 === -1 ? arg : arg.slice(0, sp2);
          const argLine = sp2 === -1 ? '' : arg.slice(sp2 + 1);
          const outcome = await flowCards.runCard(kind, cardQuery, a.device, argLine);
          if (!outcome.ok) {
            console.log(outcome.error);
          } else if (kind === 'condition') {
            console.log(`→ ${outcome.result === true}`);
          } else {
            // Actions usually return nothing; ask-agent-output-as-text returns
            // its flow tokens — show them.
            await settle(400);
            console.log(outcome.result !== undefined ? `→ ${JSON.stringify(outcome.result)}` : '(done)');
          }
          break;
        }
        case 'set': {
          const k = arg.indexOf(' ');
          if (k === -1) { console.log('usage: set <key> <value>'); break; }
          const key = arg.slice(0, k);
          let value: any = arg.slice(k + 1).trim();
          if (value === 'true') value = true;
          else if (value === 'false') value = false;
          else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
          await homey.settings.set(key, value);
          console.log(`set ${key} = ${JSON.stringify(value)}`);
          break;
        }
        case 'quit':
        case 'exit':
          rl.close();
          return;
        default:
          console.log(`Unknown command: ${cmd}  (type 'help')`);
      }
    } catch (e: any) {
      console.error('Error:', e?.message ?? e);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nShutting down.');
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('[EMULATOR] Fatal error during startup:', e);
  process.exit(1);
});
