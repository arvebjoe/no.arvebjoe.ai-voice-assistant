# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Homey (Athom) SDK v3 app that connects ESP32-based voice devices (Home Assistant Voice PE, XiaoZhi AI) running ESPHome firmware to OpenAI's Realtime API. It bridges on-device mic/speaker with cloud STT/LLM/TTS and lets the LLM control the Homey smart home via tool calls.

## Commands

```bash
npm run build          # tsc -> compiles .mts to .homeybuild/
npm run lint           # eslint (config: athom/homey-app)
npm test               # vitest run (one-shot)
npm run test:watch     # vitest watch mode
npm run test:coverage  # vitest with coverage
npx vitest run tests/weather-helper.test.mts   # run a single test file
```

Running the app on a Homey requires the Homey CLI (not an npm script): `homey app run` (live-reload on a real Homey) or `homey app install`. `app.json` is **generated** from `.homeycompose/` by the CLI's build/compose step — edit files under `.homeycompose/` (app metadata, capabilities, flow cards, discovery), never `app.json` directly.

## Module system gotcha

Source files are `.mts` (ESM TypeScript) compiled by `tsc` to `.homeybuild/`. Imports reference the **compiled** extension, so a file `foo.mts` is imported as `from './foo.mjs'`. Match this convention in every import.

## Architecture

### App bootstrap and singletons (`app.mts`)

`AiVoiceAssistantApp` (the `Homey.App` entry point) constructs the shared services in order and stores them on the app instance: `settingsManager` (init), `GeoHelper`, `WeatherHelper`, `WebServer`, `ApiHelper`, `DeviceManager`. Devices reach these via `(this.homey as any).app.deviceManager` etc. — they are not re-instantiated per device.

### Driver/device inheritance

Both drivers are thin subclasses of shared base classes in `src/homey/`:
- `drivers/home-assistant-voice-preview-edition/` and `drivers/xiaozhi-ai/` each have a `device.mts` + `driver.mts` that extend `VoiceAssistantDevice` / `VoiceAssistantDriver`.
- All real logic lives in `src/homey/voice-assistant-device.mts` and `voice-assistant-driver.mts`. Subclasses only set per-model flags like `needDelayedPlayback` and `thisAssistantType`.
- Flow card run-listeners are registered **once** across all driver instances (guarded by a static `flowCardsInitialized` flag in `VoiceAssistantDriver`).

### Voice pipeline (the core data flow)

```
ESP32 device  <--TCP/protobuf-->  EspVoiceAssistantClient  <-->  VoiceAssistantDevice  <--WebSocket-->  OpenAIRealtimeAgent
   (ESPHome)        port 6053       (src/voice_assistant/)        (src/homey/)              (src/llm/)        |
                                                                                                          ToolManager
```

- **`src/voice_assistant/esp-voice-assistant-client.mts`** — TCP client speaking the ESPHome native API (protobuf). It handles reconnect/health-check (ping timeout, health interval), emits `chunk` (16kHz PCM audio), `capabilities`, `volume`, `mute`, `started`/`starting` events. `esp-messages.mts` loads `api.proto` via protobufjs and varint-frames messages.
- **`src/homey/voice-assistant-device.mts`** — orchestrates a session: wires the ESP client to the OpenAI agent, resamples mic audio (`Pcm16kTo24k`), segments PCM (`PcmSegmenter`), encodes responses to FLAC (`audio-encoders.mts`) and serves them over LAN HTTP through `WebServer` so the device can play a URL.
- **`src/llm/openai-realtime-agent.mts`** — WebSocket client for the OpenAI Realtime API. Supports audio↔audio, text↔audio, audio↔text, text↔text, and direct TTS. Emits granular streaming events (`audio.delta`, `text.delta`, `transcript.delta`, `tool.called`, etc.). Loads language-specific system prompts dynamically (`agent-instructions.{en,no}.mts`).
- **`src/llm/tool-manager.mts`** — registers the function-call tools the LLM can invoke (smart-home control via `DeviceManager`, weather via `WeatherHelper`, geo/time). Provides `getToolDefinitions()` (sent to OpenAI) and `getToolHandlers()` (executed locally on tool calls).

### Supporting helpers (`src/helpers/`)

`device-manager.mts` (queries/controls Homey devices and zones via `ApiHelper`, tracks voice-assistant devices, fires zone-change callbacks), `weather-helper.mts`, `geo-helper.mts`, `webserver.mts` (builds LAN audio URLs), `file-helper.mts` (audio folder + scheduled deletion), audio utilities (`Pcm16kTo24k`, `pcm-segmenter`, `audio-encoders`), `sound-urls.mts`, `logger.mts` (`createLogger(name, disabled?)` — colorized, routes to Homey log).

### Settings (`src/settings/settings-manager.mts`)

`settingsManager` is a singleton with a pub/sub for **global** app settings (OpenAI API key, language, voice, optional AI instructions). Devices subscribe via `settingsManager.onGlobals(...)` to rebuild the agent on the fly when settings change. Use this to read settings anywhere without a `this.homey` reference.

## Testing

Vitest with `globals: true`, node environment. Tests live in `tests/**/*.test.mts`. Mocks for Homey, DeviceManager, GeoHelper, WeatherHelper are in `tests/mocks/`. Some tests hit the real OpenAI API (`openai-connection-test`, `openai-agent-behavior`) and require a key — they are integration tests, not pure unit tests.

## Reference docs

`docs/home-assistant-voice-preview-edition/` contains protocol notes (ESPHome native API, Wyoming protocol, communication flow, hardware reference) useful when changing the ESP client. `OPENAI_API_IMPROVEMENTS.md` and `TODO.md` track planned work.
