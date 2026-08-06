# Homey Emulator (HE)

Run the AI Voice Assistant app **without a Homey** — as a plain Node process. HE
shims the Homey runtime (`homey`, `homey-api`, `homey-log`) so the real app code
boots unchanged, backed by a list of dummy devices you define in `settings.json`.
The voice satellites (PE / XiaoZhi) point at their real IPs on the network.

Use it to:

- **Test LLM tool-calling** against the dummy devices from an interactive console
  (`ask <text>`) — no satellite and no microphone required.
- **Talk to the assistant with no hardware at all** — a *virtual satellite*
  borrows this computer's microphone and speaker through a page HE hosts
  (`http://localhost:8060/satellite`).
- **Talk to a real satellite** over the network (full voice round-trip) if it
  is reachable.
- **Replay recorded voice clips** through the whole pipeline (`mic <file>`) to
  reproduce test cases without speaking.
- **Find satellites on the LAN** and add them to the config (`discover`).
- **Inspect dummy device state** to confirm the assistant did what you asked.
- **Edit app settings in the real settings page** in a browser
  (`http://localhost:8060/`) — saves apply live and persist to `settings.json`.
- **Exercise the flow cards without building flows**: WHEN cards log to the
  console when the app fires them; AND/THEN cards run from the console
  (`and is-muted`, `then start-timer 90 pasta`) through the app's real
  run-listeners.

HE lives entirely under `emulator/` and is excluded from the app build
(`tsconfig.json` → `exclude`) and from app packaging (`.homeyignore`). It never
ships in the Homey app.

## Setup

```bash
npm install                                   # installs tsx (the only added dep)
cp emulator/settings.example.json emulator/settings.json
# edit emulator/settings.json: set openai_api_key (satellites can be added with `discover`)
npm run emulator
```

`emulator/settings.json` is git-ignored (it holds your API key). The committed
template is `settings.example.json`.

**From Rider / WebStorm:** the **Emulator** run configuration
(`.run/Emulator.run.xml`) runs the same command as a Node.js configuration, so
**Debug** works — breakpoints in `src/` and `emulator/` hit, and the interactive
console takes its commands in the Run tool window. `.idea/` is git-ignored here,
which is why the profile lives in `.run/` (JetBrains' shared location).

## settings.json

| field          | meaning                                                            |
|----------------|--------------------------------------------------------------------|
| `global`       | App settings: `openai_api_key`, `selected_language_code`/`_name`, `selected_voice`, `ai_instructions`, `openweather_api_key`, `input_buffer_debug` (capture raw mic input and serve it back as a playback URL — debug only, defaults off). Seeded into the fake `homey.settings`. |
| `geolocation`  | Lat/long handed to GeoHelper (drives weather/time tools).          |
| `timezone`     | IANA timezone string returned by the fake `homey.clock`.           |
| `env`          | Emulator-only env vars (`HE_HOST_IP`, `ESP_LOG_LEVEL`) applied to `process.env` at load so you don't have to export them yourself. A real env var on the command line still wins. Leave a value empty/omit to ignore it. |
| `satellites`   | The voice satellites to boot: `name`, `type` (`pe` default, or `xiaozhi`), `mac`, `address`, `port`, `zone`, optional device `settings`, and `fake` (see [Virtual satellite](#virtual-satellite-fake-true) — no `address` needed). The `discover` command appends here. Each is auto-added to the device list so zone lookup resolves. (The old single-`pe` field still works as a fallback and is migrated into `satellites` on the first `discover` save.) |
| `zones`        | Dummy zones (`id`, `name`, `parent`).                              |
| `devices`      | Dummy devices (`id`, `name`, `zone`, `class`, `capabilities` map). |

## Console commands

```
ask <text>        Ask the assistant; prints the text reply (best for testing tool calls)
say <text>        Send text; the spoken reply plays on the satellite
speak <text>      Direct TTS to the satellite (no LLM)
mic <file>        Feed a recording (emulator/recordings/) into the mic pipeline, as if spoken
mic               List available recordings
wake [sat]        Start a turn — the stand-in for the wake word. On a virtual
                  satellite: speak into this computer's microphone
discover [sec]    Scan the LAN for ESPHome voice satellites and add them to settings.json
sats              List configured satellites; ▶ marks the one ask/say/speak/mic target
use <name|#>      Switch the active satellite
press <sat> [capability [value]]
                  Only a satellite given: list all its capability values (● = pressable).
                  With capability+value: drive the listener like the Homey app UI,
                  e.g. `press 1 volume_set 0.5`, `press living volume_mute true`.
                  Capability names match by unique prefix; the value is set only
                  if the listener succeeds (Homey semantics).
devices           List dummy devices + current capability values
zones             List zones
state <name|id>   Show one device's capabilities
flow              List the app's flow cards; WHEN cards log automatically when fired (⚡)
and <card>        Run an AND (condition) card on the active satellite; prints true/false
then <card> [..]  Run a THEN (action) card on the active satellite
set <key> <val>   Change a global setting on the fly (e.g. set selected_voice nova)
help / quit
```

## Flow cards (`flow`, `and`, `then`)

The last Homey-only surface — flow cards — is emulated end to end. The fake
`homey.flow` hands out real card objects, so the run-listeners
`VoiceAssistantDriver` registers are the ones that run:

- **WHEN (triggers)** are fired by the app itself (`timer-started/-finished/
  -cancelled`, `button-pressed`) and each firing is logged with its tokens:
  `⚡ WHEN [timer-finished] on 'Living Room PE'  tokens: {"name":"pasta","duration":90}`.
- **AND (conditions)** run from the console and print the listener's verdict:
  `and is-muted` → `→ false`.
- **THEN (actions)** run from the console with arguments — positional in the
  card's declared order, or `name=value`; the last text argument takes the
  rest of the line, so no quoting is needed:
  `then start-timer 90 pasta water` (a 90 s timer named "pasta water"),
  `then speak-text Dinner is ready`, `then ask-agent-output-as-text what time is it`
  (prints the returned flow tokens).

Card ids can be shortened to any unique prefix (`then cancel`,
`and timer`). `flow` lists every card with its arguments and tokens — the list
is read live from `.homeycompose/flow/`, so new cards appear automatically.
A full timer round-trip to try:

```
HE> then start-timer 5 pasta     ⚡ WHEN [timer-started] …
HE> and timer-is-running         → true
                                 ⚡ WHEN [timer-finished] …  (5 s later)
HE> then cancel                  ⚡ WHEN [timer-cancelled] …
```

## Virtual satellite (`fake: true`)

A satellite with `"fake": true` has no device on the network: it borrows the
**microphone and speaker of the machine running HE**, through a page HE hosts
next to the settings UI. Everything else is the real app — same driver, same
device class, same provider, tools, turn state machine and reply path. Only the
ESPHome TCP client is swapped for one wired to the browser page
(`VoiceAssistantDevice.createEspClient` is the seam; see
`runtime/virtual-satellite/`).

```json
{
  "name": "Desk (virtual)",
  "type": "pe",
  "fake": true,
  "mac": "AA:BB:CC:00:00:01",
  "zone": "z-living"
}
```

Then open the URL printed in the startup banner —
`http://localhost:8060/satellite` — click **Enable microphone**, and:

```
HE> wake                      # or press Wake on the page (or the space bar)
🎙  Desk (virtual) is listening — speak into the microphone.
```

Speak; server VAD ends the turn on its own, the reply plays through your
speakers, and the page shows the phase (`listening → hearing → thinking →
replying`), the transcript, the reply, volume/mute and any running timer.

**There is no wake word** — a wake-word model is out of scope, so a turn is
started explicitly: the page's **Wake** button, the space bar, or the console
`wake` command. Everything that follows is real firmware behaviour, reproduced
faithfully because the device code depends on it: a reply that ends in a
question reopens the mic for a follow-up, the listening chime plays on the
reopen, and the conversation closes on a final reply (see
`tests/emulator-virtual-satellite.test.mts`).

Notes:

- **Open the page on `localhost`.** Browsers only grant microphone access in a
  secure context, so `http://192.168.x.x:8060/satellite` from another machine
  will not get a mic (`HE_SETTINGS_HOST=0.0.0.0` still exposes the page itself).
- **Use headphones, or expect the odd self-trigger.** The page asks for echo
  cancellation and stops sending mic audio while a reply is playing, but open
  speakers next to an open mic remain open speakers next to an open mic.
- With no page open, the satellite still boots and `ask` / `say` / `speak` /
  `mic <file>` all work; playback is skipped (logged, not stalled) and a wake
  warns that nothing will be heard.
- Multiple virtual satellites are fine — the page has a picker, and
  `?sat=<mac>` opens a specific one, so you can put two tabs side by side.
- Reply audio is served to the page by HE itself (`/he/audio/...`), so a virtual
  satellite does **not** need the port-80 audio server (see the notes at the
  bottom).

## Settings web UI

HE hosts the app's **real** settings page (`settings/index.html`, unmodified)
on `http://localhost:8060/` — the URL is printed in the startup banner. The
page's `/homey.js` webview bridge (normally injected by Homey) is replaced by
an emulator shim that maps the same `Homey.get/set/api` calls onto the running
emulator:

- **Loads** show the current values from the fake `homey.settings` (seeded from
  `settings.json` → `global`).
- **Saves** fire the normal settings events — `SettingsManager` picks them up
  and the agent rebuilds live, exactly like a save on a real Homey — **and**
  write through to `settings.json` → `global`, so they survive a restart.
  (The console `set` command stays in-memory only, as before.)
- `Homey.api` calls (`/voices`, `/feature-costs`, `/test-local-stage` — the
  token-budget meter and the pipeline **Test** buttons) run against the app's
  real `api.mts` handlers, so stage tests really probe your LAN services.

By default the page is only reachable from the machine running HE — it hands
out your API keys to anyone who can load it. Set `HE_SETTINGS_HOST=0.0.0.0`
(e.g. in the `env` block) to expose it on the LAN, and `HE_SETTINGS_PORT` to
move it off 8060. If the port can't be bound, HE logs a warning and keeps
running without the web UI.

## Discovery (`discover`)

`discover` browses the LAN for `_esphomelib._tcp` services — the same mDNS-SD
service the Homey app's pairing flow watches (`.homeycompose/discovery/esphome.json`)
— using a small built-in mDNS client (no extra dependency). Every hit is then
probed over the ESPHome native API with the app's own discovery-mode client, so
the device is identified exactly like during real pairing ('pe' or 'xiaozhi').
You pick the devices to add (and the zone) in the terminal; they are saved to
`settings.json` → `satellites` and booted immediately in the running session.

Notes:

- Only identified voice satellites can be added. Devices with API encryption
  enabled fail the probe — the discover flow has no key to offer, so they are
  listed with a clear error and can't be added from the console. (The app's
  client itself supports Noise encryption; encrypted devices pair on a real
  Homey via manual IP entry with the key.)
- Re-discovering a known satellite refreshes its `address`/`port` in
  `settings.json` (DHCP moved it?) but keeps your tuned fields (zone, settings).
- If the scan finds nothing, check that the machine is on the same LAN/VLAN as
  the satellites and that the firewall allows UDP 5353.

## Recordings (`mic`)

Put `.flac` (or `.wav`) clips in `emulator/recordings/` and replay them as if
they were spoken into the satellite's microphone:

```
HE> mic                 # list clips
HE> mic turn-on-lights  # extension optional, unique prefix is enough
```

The clip is decoded, downmixed to mono and resampled to 16 kHz, then pushed
through the device's real wake path: a synthetic wake ('starting') followed by
real-time-paced mic chunks. Wake handling, the `initial_audio_skip` trim,
resampling, server VAD, tool calls and the reply path all run unchanged —
leading silence covers the skip budget and trailing silence lets server VAD
close the turn. The transcript and reply show up in the CONVO log as usual.

Notes:

- Clips must be 16-bit; any sample rate/channel count is fine.
- The agent must be connected (`Agent connection opened`) — the clip is speech
  for the LLM, not something played on the satellite's speaker.
- With a real satellite connected, the wake also opens its mic (exactly like a
  real wake), so room audio can mix into the clip. For deterministic test cases
  run without a reachable satellite, or in a quiet room.
- `input_buffer_debug` recordings (what the mic actually captured, saved as
  FLAC) can be copied into `emulator/recordings/` and replayed.

## Backend matrix runner (`matrix-runner.mts`)

Tests every custom-pipeline backend implementation IN ISOLATION against its
real endpoint — the repeatable way to verify all STT/LLM/TTS backends after a
change (TODO item 30). Uses the app's real clients through the same builders
as the settings page's Test buttons:

- **STT**: transcribes a known reference clip (`recordings/` + expected words
  in the config) and scores the transcript; backends with a streaming mode
  (`createStream`) get the streaming path tested too.
- **LLM**: one plain round ("Reply with exactly: PONG") and one two-round
  tool-call trip — the model must call `get_current_time` and then use the
  result we feed back.
- **TTS**: synthesizes a fixed sentence, sanity-checks the duration and saves
  the WAV under `emulator/matrix-out/` for listening.

```bash
cp emulator/matrix.example.json emulator/matrix.json   # git-ignored (holds keys)
node --import tsx --import ./emulator/register.mjs ./emulator/matrix-runner.mts            # all enabled entries
node --import tsx --import ./emulator/register.mjs ./emulator/matrix-runner.mts llm-ollama # a subset by id
```

The LAN services the default config expects (all disposable docker containers,
models download on first start/request):

```bash
docker run -d --name matrix-wyoming-whisper -p 10300:10300 rhasspy/wyoming-whisper --model base-int8 --language en
docker run -d --name matrix-wyoming-piper   -p 10200:10200 rhasspy/wyoming-piper --voice en_US-lessac-medium
docker run -d --name matrix-whisper-asr     -p 9000:9000 -e ASR_MODEL=base -e ASR_ENGINE=faster_whisper onerahmet/openai-whisper-asr-webservice:latest
docker run -d --name matrix-piper-http      -p 5000:5000 artibex/piper-http
docker run -d --name matrix-speaches        -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu
curl -X POST http://127.0.0.1:8000/v1/models/Systran%2Ffaster-whisper-small    # install its STT model
docker run -d --name matrix-kokoro          -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
```

Plus Ollama on the host with a tool-capable model (`ollama pull qwen2.5:3b`)
— the `llm-openai-compat` entry points at Ollama's `/v1` endpoint, so one
install covers both LLM backends. Mistral entries need `mistralApiKey` set.

## How it works

`npm run emulator` runs:

```
node --import tsx --import ./emulator/register.mjs ./emulator/main.mts
```

- `tsx` runs the TypeScript source directly and resolves the app's `./foo.mjs`
  imports to the `.mts` source files.
- `register.mjs` installs `loader.mjs`, an ESM resolve hook that redirects the
  bare specifiers `homey`, `homey-api`, and `homey-log` to the shims in
  `emulator/shims/`. It runs *after* tsx, so it wins for those specifiers.
- `main.mts` constructs the fake `homey` context, the `App`, and one `Driver` +
  `Device` per configured satellite, calls their `onInit()` in order, then
  starts the console. A `fake` satellite gets the same device class with
  `createEspClient()` overridden, so it drives the host mic/speaker instead of a
  device on the LAN.

## Environment variables

| var          | meaning                                                              |
|--------------|---------------------------------------------------------------------|
| `HE_SETTINGS`| Path to an alternate settings file (defaults to `emulator/settings.json`). |
| `HE_HOST_IP` | Override the host IP the app advertises in playback URLs. Set this when auto-detection picks the wrong interface (VPN/Docker/WSL/virtual adapter) and the satellite can't fetch the FLAC URL. Use the dev machine's LAN IP reachable by the satellite, e.g. `HE_HOST_IP=192.168.1.50 npm run emulator`. |
| `HE_SETTINGS_PORT` | Port for the settings web UI **and the virtual satellite page** (default `8060`). |
| `HE_SETTINGS_HOST` | Interface the settings web UI binds (default `127.0.0.1` — localhost only, since the page exposes your API keys; `0.0.0.0` opens it to the LAN). |
| `HE_AUDIO_DIR` | Where reply/chime audio is written. Defaults to `/userdata/audio` like a real Homey, falling back to `<tmp>/he-audio` when that can't be created (macOS/Linux without root). |
| `ESP_LOG_LEVEL` | Verbosity of the ESPHome native-API client log (e.g. `DEBUG`). |
| `AUDIO_FILE_TTL_MS` | How long (ms) a played audio file lingers before deletion. Defaults to `30000`; raise it (the emulator ships `999000`) so `input_buffer_debug` recordings stick around long enough to inspect. |

`HE_HOST_IP`, `ESP_LOG_LEVEL`, `AUDIO_FILE_TTL_MS`, `HE_SETTINGS_PORT`,
`HE_SETTINGS_HOST` and `HE_AUDIO_DIR` can instead be set under the `env` block in `settings.json`
(see above) so you don't have to export them on every run; an env var set on
the command line still takes precedence.

## Notes / limitations

- **Internet is required** — the app uses the OpenAI Realtime API (and open-meteo
  for weather). Put a valid `openai_api_key` in `settings.json`.
- **A REAL satellite's audio playback needs port 80.** The app builds playback
  URLs without a port (`http://<ip>/app/.../userdata/audio/<file>`), so HE serves
  the audio folder on `:80`. If binding `:80` fails HE logs the reason and
  **quits**: `EADDRINUSE` means another process holds the port (on Windows this
  is often IIS — stop it with `net stop w3svc` or `iisreset /stop`); `EACCES`
  means you need an elevated/Administrator terminal. **Virtual satellites don't
  need it** — they fetch their audio from the settings web server instead — so a
  session with only virtual satellites logs a warning and keeps running.
- Audio files are written to the OS-resolved `/userdata/audio` (e.g.
  `C:\userdata\audio` on Windows), matching what the app's file-helper uses.
  Creating that folder needs root on macOS and Linux; when it can't be created
  HE falls back to `<tmp>/he-audio` (override with `HE_AUDIO_DIR`).
- **Encrypted (Noise) satellites:** the `discover` probe is plaintext-only, so
  encrypted devices can't be identified or added from the console. The app's
  ESP client does support Noise, so a hand-written satellite entry with
  `"settings": { "encryption_key": "..." }` in settings.json passes the key
  through to the real device code. Discovery here is the emulator's own console
  flow, not Homey's pairing UI — but the real settings page IS hosted (see
  "Settings web UI").
