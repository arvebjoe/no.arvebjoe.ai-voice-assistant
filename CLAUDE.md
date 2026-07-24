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

Running the app on a Homey requires the Homey CLI (not an npm script):
- `homey app run --remote` — **preferred for live debugging.** Runs the app on the real Homey and streams its log back to the terminal so you (and Claude) can follow `this.homey.log(...)` output live. Use this when investigating runtime behavior (e.g. pairing/discovery).
- `homey app run` — live-reload on a real Homey.
- `homey app install` — install the app onto the Homey.

`app.json` is **generated** from `.homeycompose/` by the CLI's build/compose step — edit files under `.homeycompose/` (app metadata, capabilities, flow cards, discovery), never `app.json` directly. The compose step also runs as part of `homey app run`, so changes under `.homeycompose/` (including `discovery/esphome.json`) take effect on the next run.

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
- **Pairing** (PE + TR drivers): a custom `onPair` flow — a `start` choice view, then either the system `list_devices` (mDNS, backed by `onPairListDevices`) or a **Bluetooth Wi-Fi setup wizard** (`pair/improv_setup.html`, identical copies per driver — keep in sync) that provisions un-networked devices via **Improv over BLE**. Protocol client: `src/ble/improv-ble-client.mts`; pair-socket wiring: `src/ble/improv-pair-handlers.mts` (unit-tested with fakes in `tests/mocks/mock-improv-ble.mts`). Needs the `homey:wireless:ble` permission. Reference: `docs/wifi-provisioning-improv-ble.md`. Manual IP entry (`pair/manual_entry.html`, also identical copies) is the mDNS-less fallback and collects the optional API encryption key. Encrypted devices (mDNS `txt.api_encryption`, or a probe hitting the Noise indicator) are listed marked "needs encryption key" without identity probing; `list_devices` navigates to the `encryption_check` loading view, whose showView handler routes encrypted selections to `manual_entry` with the address prefilled (`manual_get_prefill`) and everything else on to `add_devices`. Gated per driver by `supportsEncryptedPairing` (false for XiaoZhi — its pair flow has no manual_entry view).

### Voice pipeline (the core data flow)

```
ESP32 device  <--TCP/protobuf-->  EspVoiceAssistantClient  <-->  VoiceAssistantDevice  <--WebSocket-->  OpenAIRealtimeAgent
   (ESPHome)        port 6053       (src/voice_assistant/)        (src/homey/)              (src/llm/)        |
                                                                                                          ToolManager
```

- **`src/voice_assistant/esp-voice-assistant-client.mts`** — TCP client speaking the ESPHome native API (protobuf). It handles reconnect/health-check (ping timeout, health interval), emits `chunk` (16kHz PCM audio), `capabilities`, `volume`, `mute`, `started`/`starting` events. `esp-messages.mts` loads `api.proto` via protobufjs and varint-frames messages.
- **`src/homey/voice-assistant-device.mts`** — orchestrates a session: wires the ESP client to the OpenAI agent, resamples mic audio (`Pcm16kTo24k`), segments PCM (`PcmSegmenter`), encodes responses to FLAC (`audio-encoders.mts`) and serves them over LAN HTTP through `WebServer` so the device can play a URL.
- **`src/llm/providers/openai-realtime-agent.mts`** — WebSocket client for the OpenAI Realtime API. Supports audio↔audio, text↔audio, audio↔text, text↔text, and direct TTS. Emits granular streaming events (`audio.delta`, `text.delta`, `transcript.delta`, `tool.called`, etc.). Loads language-specific system prompts dynamically (`src/llm/instructions/agent-instructions.<code>.mts`, one per language in `settings/index.html`, English fallback).
- **Provider seam:** `src/llm/voice-provider.mts` defines `IVoiceProvider` (the contract the device consumes) and `voice-provider-factory.mts` constructs the provider selected by the `voice_provider` global setting: `openai-realtime`, `gemini-realtime` (`providers/gemini-live-provider.mts`), `mistral-realtime` (`providers/mistral-realtime-provider.mts`), or `local` (`providers/local-pipeline-provider.mts`). The local provider chains on-device energy VAD (`providers/local/simple-vad.mts` — there is no server VAD locally) → STT → LLM → TTS and speaks replies sentence-by-sentence while the LLM streams. The **Mistral provider** is a thin `LocalPipelineProvider` subclass (overrides `buildPipeline()`) hardwiring the Mistral-native chain — Voxtral Realtime STT + Mistral chat + Voxtral TTS — because Mistral has **no unified speech-to-speech realtime API** (only realtime transcription over websocket); it reads the SAME `mistral_*` settings as the custom pipeline's Mistral backends (the settings page mirrors the key/model inputs, `MIRRORED_INPUTS`). STT backends with `createStream()` (`ISttStream` in `stt-client.mts`) get fed live from VAD speech-start so the transcript is ready when the utterance ends, with automatic batch fallback. **All three stages are pluggable** behind per-stage seams in `providers/local/` (`stt-client.mts`/`llm-client.mts`/`tts-client.mts`), selected by the `local_stt_provider`/`local_llm_provider`/`local_tts_provider` settings: STT = Whisper over HTTP on the LAN (`whisper-client.mts`, `local_stt_host`/port), Wyoming-protocol faster-whisper (`wyoming-stt-client.mts` over `wyoming-protocol.mts` — raw TCP, NOT HTTP; `wyoming_stt_host`/port, default 10300 — the Home Assistant `rhasspy/wyoming-whisper` docker), Mistral Voxtral (`mistral-stt-client.mts`), Mistral Voxtral Realtime (`mistral-realtime-stt-client.mts`, websocket streaming), or any OpenAI-compatible server (`openai-stt-client.mts`); LLM = Ollama (`ollama-client.mts`, `local_llm_host`/port/model; `local_llm_num_ctx` sets the context window, always sent in `options.num_ctx` — default 8192 because Ollama's own default window silently truncates the system prompt; see `docs/cost-of-growth.md`), LM Studio (`lmstudio-client.mts`, `lmstudio_host`/port default 1234, model optional — auto-picked from `/v1/models`), Mistral chat completions (`mistral-client.mts`), or any OpenAI-compatible server (`openai-llm-client.mts` — also the base class `MistralClient` and `LmStudioClient` extend; Mistral additionally requires tool_call_id to be exactly 9 alphanumeric chars — see `sanitizeToolCallId`); TTS = Piper over HTTP (`piper-client.mts`, `local_tts_host`/port), Wyoming-protocol Piper (`wyoming-tts-client.mts`, `wyoming_tts_host`/port, default 10200 — the Home Assistant `rhasspy/wyoming-piper` docker), Mistral Voxtral TTS (`mistral-tts-client.mts`, WAV 24 kHz; `model` is required by the live server despite the spec, default `voxtral-mini-tts-2603`, and `voice_id` must be a UUID from `GET /v1/audio/voices` — the open-weights preset names 404), or any OpenAI-compatible server (`openai-tts-client.mts`, free-text voice override for non-OpenAI voices). The voice dropdown adapts to the TTS backend via `getAvailableVoices(ttsBackend)` (async — the Voxtral list is fetched live from Mistral with the saved key). The `openai` backends take per-stage base URL / optional key / model (`openai_stt_url` etc., helpers in `openai-compat.mts`) and cover Groq, OpenRouter, DeepSeek, LM Studio, llama.cpp, vLLM, speaches, kokoro-fastapi and OpenAI itself. All Mistral-backed stages share `mistral_api_key`; `hasApiKey()` is false when any selected Mistral stage lacks the key.
- **`src/llm/tool-manager.mts`** — registers the function-call tools the LLM can invoke (smart-home control via `DeviceManager`, weather via `WeatherHelper`, geo/time). Provides `getToolDefinitions()` (sent to OpenAI) and `getToolHandlers()` (executed locally on tool calls). **Every optional feature is gated** (docs/cost-of-growth.md rule 1): weather (`weather_enabled`), web search (`web_search_provider` = 'disabled' removes the tool), timers (`timers_enabled` AND a TimerManager; the instruction block additionally needs `esp.supportsTimers`), shopping (`bring_enabled` + creds), music (`music_assistant_enabled` + host). Each gate has a `refresh*Tools()` reconciler the device calls on settings changes, restarting the provider when a gate flips (the tool list is only sent at session config). `ToolManager.FEATURE_TOOLS` maps feature → tool names for the cost endpoint.

### Supporting helpers (`src/helpers/`)

`device-manager.mts` (queries/controls Homey devices and zones via `ApiHelper`, tracks voice-assistant devices, fires zone-change callbacks), `weather-helper.mts`, `geo-helper.mts`, `webserver.mts` (builds LAN audio URLs), `file-helper.mts` (audio folder + scheduled deletion), audio utilities (`Pcm16kTo24k`, `pcm-segmenter`, `audio-encoders`), `sound-urls.mts`, `logger.mts` (`createLogger(name, disabled?)` — colorized, routes to Homey log), `remote-log.mts` (opt-in RFC 5424 syslog forwarding over UDP/TCP, `remote_log_*` settings — every Logger mirrors into it: enabled loggers at INFO, `disabled: true` loggers at DEBUG so quieted subsystems still reach a collector, warn/error always; wired in `app.mts` via `settingsManager.onGlobals` → `configureRemoteLogFromSettings`).

### Settings page, Web API and feature costs

`settings/index.html` is organized by a section dropdown (General / Custom pipeline / one section per feature) with a sticky footer: a live token-budget meter (tap = per-feature breakdown with toggles) + the global Save. The "Custom pipeline" section is the `local` provider (UI label only — the provider id and code names stay `local`) and its dropdown option is disabled unless that provider is selected. Costs come from `GET /feature-costs` (`api.mts` → `src/settings/feature-costs.mts`), computed live from the real instruction modules + a measurement ToolManager (`registerAllToolsForMeasurement()`), so they track the code; the budget verdict (green/amber/red) applies when the pipeline runs on Ollama (vs `local_llm_num_ctx`) or LM Studio (window read live from its REST API via `GET /lmstudio-context` → `src/llm/providers/local/lmstudio-context.mts`; prefers `loaded_context_length`, falls back to the model max). API routes are declared in `.homeycompose/app.json` under `api`. Background and design decisions: `docs/settings-redesign.md`, `docs/cost-of-growth.md`.

### Settings (`src/settings/settings-manager.mts`)

`settingsManager` is a singleton with a pub/sub for **global** app settings (OpenAI API key, language, voice, optional AI instructions). Devices subscribe via `settingsManager.onGlobals(...)` to rebuild the agent on the fly when settings change. Use this to read settings anywhere without a `this.homey` reference.

## ESPHome firmware compatibility (the ESP client must support both)

The ESPHome native API changed its connection handshake across firmware versions, and the client in `src/voice_assistant/esp-voice-assistant-client.mts` must stay compatible with **both** old and new satellites:

- **ESPHome 2026.1.0+ (Voice PE firmware 26.x)** removed native-API **password authentication**. `ConnectRequest`/`ConnectResponse` (message ids 3/4) are deprecated and **no longer processed by the server** — the device never replies with a `ConnectResponse`.
- The handshake therefore sends `ConnectRequest` (still required to authenticate **pre-2026.1** firmware) but **does not wait** for `ConnectResponse`; it proceeds to the connected state immediately in `onConnectionEstablished()`. TCP ordering guarantees an older server processes `ConnectRequest` before the `ListEntitiesRequest` that follows, so this works on both 25.x and 26.x. **Do not** re-introduce gating the connection on `ConnectResponse`.
- **Noise encryption** (`Noise_NNpsk0_25519_ChaChaPoly_SHA256`) is supported when the device has an API encryption key set (`api: → encryption: → key:` — the default once a device has been adopted by Home Assistant). The crypto + framing live in `src/voice_assistant/noise-frame-codec.mts` (self-contained, node:crypto only, unit-tested with a loopback responder in `tests/noise-frame-codec.test.mts`); the client runs the handshake before `HelloRequest` when `encryptionKey` is set and stays byte-for-byte plaintext when it isn't. The key comes from the per-device `encryption_key` setting (fallback: pair-time `store.encryptionKey`, collected in the manual-IP pair view). A plaintext connect answered with the Noise indicator (`0x01`) emits `requires_encryption`; Noise-path failures emit `encryption_error` with a precise code (`wrong_key`, `plaintext_device`, `mac_mismatch`, `invalid_key`, `protocol_error`). Protocol reference: `docs/esphome-noise-encryption.md`.

## Testing

Vitest with `globals: true`, node environment. Tests live in `tests/**/*.test.mts`. Mocks for Homey, DeviceManager, GeoHelper, WeatherHelper are in `tests/mocks/`. Some tests hit the real OpenAI API (`openai-connection-test`, `openai-agent-behavior`) and require a key — they are integration tests, not pure unit tests.

## Reference docs

`docs/home-assistant-voice-preview-edition/` contains protocol notes (ESPHome native API, Wyoming protocol, communication flow, hardware reference) useful when changing the ESP client.

## User-facing docs — keep in sync with feature changes

Two files describe the app to end users and **must be updated whenever a user-visible feature changes** (new provider/backend, new flow card, new setting, new supported device, changed behavior):

- `README.md` — the full GitHub-facing doc (features, hardware setup, engine choice, settings, flow cards, how-it-works overview).
- `README.txt` — the Homey App Store description. Plain text, no markdown, keep it short and non-technical; it must stay consistent with README.md.

When finishing a feature, check both before committing — stale READMEs have already happened once (the local pipeline shipped without either file mentioning it).

## Outstanding work

**`TODO.md` (repo root) is the single source of truth for what's left to do** — check it at the start of each session. It indexes everything outstanding (release testing checklist, ESP client, OpenAI Realtime, agent tools, firmware, local AI, Phase 2) with status markers. Finished items are archived with their full context (root causes, gotchas, verification notes) in `COMPLETED.md` — check there before re-investigating anything that sounds familiar. Two detailed reference docs feed into the TODO list: `OPENAI_API_IMPROVEMENTS.md` (OpenAI Realtime audit) and `docs/home-assistant-voice-preview-edition/implementation-gap-analysis.md` (ESPHome native-API coverage).
