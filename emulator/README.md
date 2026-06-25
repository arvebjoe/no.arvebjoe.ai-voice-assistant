# Homey Emulator (HE)

Run the AI Voice Assistant app **without a Homey** — as a plain Node process. HE
shims the Homey runtime (`homey`, `homey-api`, `homey-log`) so the real app code
boots unchanged, backed by a list of dummy devices you define in `settings.json`.
One of those devices is the PE satellite, pointing at its IP on the network.

Use it to:

- **Test LLM tool-calling** against the dummy devices from an interactive console
  (`ask <text>`) — no PE and no microphone required.
- **Talk to a real PE** over the network (full voice round-trip) if the satellite
  is reachable.
- **Inspect dummy device state** to confirm the assistant did what you asked.

HE lives entirely under `emulator/` and is excluded from the app build
(`tsconfig.json` → `exclude`) and from app packaging (`.homeyignore`). It never
ships in the Homey app.

## Setup

```bash
npm install                                   # installs tsx (the only added dep)
cp emulator/settings.example.json emulator/settings.json
# edit emulator/settings.json: set openai_api_key and the PE's mac/address
npm run emulator
```

`emulator/settings.json` is git-ignored (it holds your API key). The committed
template is `settings.example.json`.

## settings.json

| field          | meaning                                                            |
|----------------|--------------------------------------------------------------------|
| `global`       | App settings: `openai_api_key`, `selected_language_code`/`_name`, `selected_voice`, `ai_instructions`, `openweather_api_key`. Seeded into the fake `homey.settings`. |
| `geolocation`  | Lat/long handed to GeoHelper (drives weather/time tools).          |
| `timezone`     | IANA timezone string returned by the fake `homey.clock`.           |
| `pe`           | The PE satellite: `name`, `mac`, `address`, `port`, `zone`, optional device `settings`. Auto-added to the device list so zone lookup resolves. |
| `zones`        | Dummy zones (`id`, `name`, `parent`).                              |
| `devices`      | Dummy devices (`id`, `name`, `zone`, `class`, `capabilities` map). |

## Console commands

```
ask <text>        Ask the assistant; prints the text reply (best for testing tool calls)
say <text>        Send text; the spoken reply plays on the PE
speak <text>      Direct TTS to the PE (no LLM)
devices           List dummy devices + current capability values
zones             List zones
state <name|id>   Show one device's capabilities
set <key> <val>   Change a global setting on the fly (e.g. set selected_voice nova)
help / quit
```

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
- `main.mts` constructs the fake `homey` context, the `App`, the PE `Driver`, and
  one PE `Device`, calls their `onInit()` in order, then starts the console.

## Environment variables

| var          | meaning                                                              |
|--------------|---------------------------------------------------------------------|
| `HE_SETTINGS`| Path to an alternate settings file (defaults to `emulator/settings.json`). |
| `HE_HOST_IP` | Override the host IP the app advertises in playback URLs. Set this when auto-detection picks the wrong interface (VPN/Docker/WSL/virtual adapter) and the PE can't fetch the FLAC URL. Use the dev machine's LAN IP reachable by the PE, e.g. `HE_HOST_IP=192.168.1.50 npm run emulator`. |

## Notes / limitations

- **Internet is required** — the app uses the OpenAI Realtime API (and open-meteo
  for weather). Put a valid `openai_api_key` in `settings.json`.
- **PE audio playback needs port 80.** The app builds playback URLs without a
  port (`http://<ip>/app/.../userdata/audio/<file>`), so HE serves the audio
  folder on `:80`. If binding `:80` fails (`EACCES`/`EADDRINUSE`) HE logs a
  warning and continues — only audio *playback on the PE* is affected; `ask`,
  tool calls, and device state still work. On Windows/macOS you may need to run
  the terminal elevated for `:80`.
- Audio files are written to the OS-resolved `/userdata/audio` (e.g.
  `C:\userdata\audio` on Windows), matching what the app's file-helper uses.
- **Not supported:** Noise/encrypted ESPHome API (plaintext only, same as the
  app), device pairing/discovery, and the real Homey settings UI.
