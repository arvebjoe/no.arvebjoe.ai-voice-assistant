// Homey Emulator (HE) entry point.
//
// Boots the AI Voice Assistant app as a plain Node process: constructs the fake
// `homey` context, the App, the PE driver, and one PE device pointing at the IP
// in settings.json, then drops you into an interactive console to drive the LLM
// and inspect the dummy devices.
//
// Run via:  npm run emulator
// (which is: node --import tsx --import ./emulator/register.mjs ./emulator/main.mts)
import { createInterface } from 'node:readline';
import { getHomey } from './runtime/homey-context.mjs';
import { world } from './runtime/fake-world.mjs';
import { startAudioServer } from './runtime/audio-server.mjs';
import { config, settingsPath } from './config.mjs';

import App from '../app.mjs';
import PEDriver from '../drivers/home-assistant-voice-preview-edition/driver.mjs';
import PEDevice from '../drivers/home-assistant-voice-preview-edition/device.mjs';

// Capabilities the PE driver declares (drivers/.../driver.compose.json).
const PE_CAPABILITIES = [
  'volume_set', 'onoff', 'volume_mute', 'timer_active', 'timer_remaining', 'timer_name',
];

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

  // 2. Driver — registers the Flow-card run-listeners once.
  const driver: any = new (PEDriver as any)({
    discovery: { getDiscoveryResults: () => ({}) },
  });
  await driver.onInit();

  // 3. The PE device, pointing at the real satellite's IP.
  const pe = config.pe;
  const device: any = new (PEDevice as any)({
    driver,
    data: { id: pe.mac, name: pe.name },
    store: {
      address: pe.address,
      port: pe.port ?? 6053,
      mac: pe.mac,
      deviceType: 'pe',
      platform: 'esp32',
      serviceName: pe.name,
    },
    settings: pe.settings ?? {},
    capabilities: PE_CAPABILITIES,
  });
  await device.onInit();

  printBanner(pe);
  startRepl(device, homey);
}

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function printBanner(pe: any): void {
  console.log('\n---------------------------------------------------------------');
  console.log(`PE device  : ${pe.name}  @ ${pe.address}:${pe.port ?? 6053}  (mac ${pe.mac})`);
  console.log('The ESP client will keep retrying if the PE is unreachable.');
  console.log("Wait for 'Agent connection opened' before using ask/say.");
  console.log('---------------------------------------------------------------');
  printHelp();
}

function printHelp(): void {
  console.log(`
Commands:
  ask <text>        Ask the assistant; prints the text reply (tests tool calls, no PE/mic needed)
  say <text>        Send text to the assistant and play the spoken reply on the PE
  speak <text>      Direct TTS of <text> to the PE (no LLM)
  devices           List all dummy devices and their current capability values
  zones             List zones
  state <name|id>   Show one device's capabilities
  set <key> <val>   Change a global setting (e.g. set selected_voice nova) — rebuilds the agent
  help              Show this help
  quit              Exit
`);
}

function startRepl(device: any, homey: any): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'HE> ' });
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
          const reply = await device.askAgentOutputToText(arg);
          // askAgentOutputToText resolves on text.done, but a tool call produces
          // a final response.done ("Conversation completed") right after. Let it
          // flush so that trailing log lands above the reply, not under the prompt.
          await settle(400);
          console.log(`\n🤖 ${reply}\n`);
          break;
        }
        case 'say': {
          if (!arg) { console.log('usage: say <text>'); break; }
          await device.askAgentOutputToSpeaker(arg);
          console.log('(sent — reply will play on the PE)');
          break;
        }
        case 'speak': {
          if (!arg) { console.log('usage: speak <text>'); break; }
          await device.speakText(arg);
          console.log('(spoken on the PE)');
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
