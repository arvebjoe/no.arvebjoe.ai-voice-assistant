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
- **Provider seam:** `src/llm/voice-provider.mts` defines `IVoiceProvider` (the contract the device consumes) and `voice-provider-factory.mts` constructs the provider selected by the `voice_provider` global setting: `openai-realtime`, `gemini-realtime` (`providers/gemini-live-provider.mts`), `mistral-realtime` (`providers/mistral-realtime-provider.mts`), or `local` (`providers/local-pipeline-provider.mts`). The local provider chains on-device energy VAD (`providers/local/simple-vad.mts` — there is no server VAD locally) → STT → LLM → TTS and speaks replies sentence-by-sentence while the LLM streams. The **Mistral provider** is a thin `LocalPipelineProvider` subclass (overrides `buildPipeline()`) hardwiring the Mistral-native chain — Voxtral Realtime STT + Mistral chat + Voxtral TTS — because Mistral has **no unified speech-to-speech realtime API** (only realtime transcription over websocket); it reads the SAME `mistral_*` settings as the custom pipeline's Mistral backends (the settings page mirrors the key/model inputs, `MIRRORED_INPUTS`). STT backends with `createStream()` (`ISttStream` in `stt-client.mts`) get fed live from VAD speech-start so the transcript is ready when the utterance ends, with automatic batch fallback. **All three stages are pluggable** behind per-stage seams in `providers/local/` (`stt-client.mts`/`llm-client.mts`/`tts-client.mts`), selected by the `local_stt_provider`/`local_llm_provider`/`local_tts_provider` settings: STT = Whisper over HTTP on the LAN (`whisper-client.mts`, `local_stt_host`/port), Wyoming-protocol faster-whisper (`wyoming-stt-client.mts` over `wyoming-protocol.mts` — raw TCP, NOT HTTP; `wyoming_stt_host`/port, default 10300 — the Home Assistant `rhasspy/wyoming-whisper` docker), Mistral Voxtral (`mistral-stt-client.mts`), Mistral Voxtral Realtime (`mistral-realtime-stt-client.mts`, websocket streaming), or any OpenAI-compatible server (`openai-stt-client.mts` — besides `language` it sends the optional **transcription context** from `openai_stt_prompt`/`openai_stt_keywords`; `buildContextFields()` routes the keywords by model: `keywords[]` is a real field ONLY on the `gpt-*transcribe` family, so for `whisper-1` and everything else they are appended to `prompt`, which is how those models take spellings — never send `keywords[]` to whisper-1, it 400s); LLM = Ollama (`ollama-client.mts`, `local_llm_host`/port/model; `local_llm_num_ctx` sets the context window, always sent in `options.num_ctx` — default 8192 because Ollama's own default window silently truncates the system prompt; see `docs/cost-of-growth.md`), LM Studio (`lmstudio-client.mts`, `lmstudio_host`/port default 1234, model optional — auto-picked from `/v1/models`), Mistral chat completions (`mistral-client.mts`), Anthropic Claude (`claude-client.mts` — the ONLY LLM backend that is not an OpenAI-dialect client: it uses the official `@anthropic-ai/sdk` against the Messages API, with `toAnthropicMessages()` mapping the neutral seam to top-level `system` + `tool_use`/`tool_result` blocks; `claude_api_key`/`claude_model`, default `claude-opus-5`, `output_config.effort: 'low'` only on the model families that accept it; the settings page's model **dropdown** is filled live from `GET /v1/models` via `POST /claude-models` → `claudeModelOptions()`, which never throws and always keeps the `''`=default sentinel plus any already-saved id), or any OpenAI-compatible server (`openai-llm-client.mts` — also the base class `MistralClient` and `LmStudioClient` extend; Mistral additionally requires tool_call_id to be exactly 9 alphanumeric chars — see `sanitizeToolCallId`); TTS = Piper over HTTP (`piper-client.mts`, `local_tts_host`/port), Wyoming-protocol Piper (`wyoming-tts-client.mts`, `wyoming_tts_host`/port, default 10200 — the Home Assistant `rhasspy/wyoming-piper` docker), Mistral Voxtral TTS (`mistral-tts-client.mts`, WAV 24 kHz; `model` is required by the live server despite the spec, default `voxtral-mini-tts-2603`, and `voice_id` must be a UUID from `GET /v1/audio/voices` — the open-weights preset names 404), or any OpenAI-compatible server (`openai-tts-client.mts`, free-text voice override for non-OpenAI voices). The LLM and TTS stages also accept **`none`** (`providers/local/none-clients.mts`): stage seams that are always configured and always healthy but never reach the network, marked with `noOp` so the provider skips the stage entirely rather than calling it. `local_llm_provider: 'none'` ends the turn after STT — the transcript still goes out on `transcript.done`, which is what fires the device's `assistant-heard` Flow trigger, and a Flow can answer via the *Say* card; `local_tts_provider: 'none'` removes speech (and makes `textToSpeech()` throw, so *Say* reports an error instead of serving silence). A turn with no reply audio would otherwise HANG on the announce path — nothing is queued, so no `announce_finished` ever ends the run — hence `AudioOutputPipeline` reports `silent` on `reply-done` and the device closes the run itself, guarded on `turn.state !== 'idle'` so paths that already ended the run (empty transcript, abort, flow-initiated *say*) can't be closed twice. The voice dropdown adapts to the TTS backend via `getAvailableVoices(ttsBackend)` (async — the Voxtral list is fetched live from Mistral with the saved key). The `openai` backends take per-stage base URL / optional key / model (`openai_stt_url` etc., helpers in `openai-compat.mts`) and cover Groq, OpenRouter, DeepSeek, LM Studio, llama.cpp, vLLM, speaches, kokoro-fastapi and OpenAI itself. The settings page offers those cloud services as a per-stage **Server** dropdown (`OPENAI_COMPAT_PRESETS` in `openai-compat.mts`, served to the page by `GET /openai-presets`) which fills in the base URL and a known-good model; only the `custom` preset shows the URL field. The pick is **not** a stored setting — it is derived from the saved base URL, so nothing about the saved shape changed. `openAiCompatNeedsKey()` (the preset hosts that authenticate) drives `hasCredentials()` on all three openai clients, so a cloud stage without a key reports missing credentials instead of 401-ing mid-turn. All Mistral-backed stages share `mistral_api_key`; `hasApiKey()` is false when any selected Mistral stage lacks the key.
- **`src/llm/tool-manager.mts`** — registers the function-call tools the LLM can invoke (smart-home control via `DeviceManager`, weather via `WeatherHelper`, geo/time). Provides `getToolDefinitions()` (sent to OpenAI) and `getToolHandlers()` (executed locally on tool calls). **Every optional feature is gated** (docs/cost-of-growth.md rule 1): weather (`weather_enabled`), web search (`web_search_provider` = 'disabled' removes the tool), timers (`timers_enabled` AND a TimerManager; the instruction block additionally needs `esp.supportsTimers`), shopping (`bring_enabled` + creds), music (`music_assistant_enabled` + host). Each gate has a `refresh*Tools()` reconciler the device calls on settings changes, restarting the provider when a gate flips (the tool list is only sent at session config). `ToolManager.FEATURE_TOOLS` maps feature → tool names for the cost endpoint.

### Supporting helpers (`src/helpers/`)

`device-manager.mts` (queries/controls Homey devices and zones via `ApiHelper`, tracks voice-assistant devices, fires zone-change callbacks), `weather-helper.mts`, `geo-helper.mts`, `webserver.mts` (builds LAN audio URLs), `file-helper.mts` (audio folder + scheduled deletion), audio utilities (`Pcm16kTo24k`, `pcm-segmenter`, `audio-encoders`), `sound-urls.mts`, `logger.mts` (`createLogger(name, disabled?)` — colorized, routes to Homey log), `remote-log.mts` (opt-in RFC 5424 syslog forwarding over UDP/TCP, `remote_log_*` settings — every Logger mirrors into it: enabled loggers at INFO, `disabled: true` loggers at DEBUG so quieted subsystems still reach a collector, warn/error always; wired in `app.mts` via `settingsManager.onGlobals` → `configureRemoteLogFromSettings`).

### Debug tools (settings page → Debug)

Two always-available diagnostics, both fed from app-level singletons (see `COMPLETED.md` §16):

- **Last seen devices** — `seen-devices.mts` (bounded registry of every ESPHome device mDNS surfaced, with the fields pairing matches on + the probe outcome + paired/available state) fed by `discovery-watcher.mts` (app-level 60 s poll of the `esphome` discovery strategy; probes up to 3 never-probed, un-paired, unencrypted devices per round), by the drivers' pair-time probes, and by each device's own `markPaired`. The probe itself is `src/voice_assistant/esp-probe.mts` — **the single implementation** shared with `VoiceAssistantDriver.checkVoiceCapabilities`/`probeManualEntry`, so the list's star means exactly what pairing means. Routes: `GET /seen-devices`, `POST /probe-device`.
- **What did I just say?** — `recording-registry.mts` keeps each turn's `rx_*` FLAC for `debug_audio_retention_min` when `debug_audio_enabled` is on (off by default; the old `input_buffer_debug` flag stays emulator-only immediate playback), labelled with the STT transcript. Playback goes to the satellite that recorded it via a player callback each device registers, driven from the settings page only (`GET /recordings`, `POST /play-recording`). **There is deliberately no LLM tool for this** — the `play_voice_recording` tool was removed after testing showed asking "what did I just say?" out loud just plays that question back, which is useless; the page is the whole feature.

### Settings page, Web API and feature costs

`settings/index.html` is organized by a section dropdown (General / Custom pipeline / Debug / one section per feature) with a sticky footer: a live token-budget meter (tap = per-feature breakdown with toggles) + the global Save. The "Custom pipeline" section is the `local` provider (UI label only — the provider id and code names stay `local`) and its dropdown option is disabled unless that provider is selected. **The Voice and AI-instructions groups live in two places:** `refreshExtrasPlacement()` *moves* (never copies) `#voice_group` / `#ai_instructions_group` between `#general_extras_slot` in General and `#pipeline_voice_slot` / `#pipeline_instructions_slot` in the pipeline section, because a speech-to-speech provider is one box while the pipeline splits it into stages that own those settings (instructions ↔ LLM, voice ↔ TTS). Moving keeps every id, listener and the save handler pointing at the same elements — do not duplicate the markup. In the pipeline a stage set to `none` also hides its group. Costs come from `GET /feature-costs` (`api.mts` → `src/settings/feature-costs.mts`), computed live from the real instruction modules + a measurement ToolManager (`registerAllToolsForMeasurement()`), so they track the code; the budget verdict (green/amber/red) applies when the pipeline runs on Ollama (vs `local_llm_num_ctx`) or LM Studio (window read live from its REST API via `GET /lmstudio-context` → `src/llm/providers/local/lmstudio-context.mts`; prefers `loaded_context_length`, falls back to the model max). API routes are declared in `.homeycompose/app.json` under `api`. Background and design decisions: `docs/settings-redesign.md`, `docs/cost-of-growth.md`.

### Settings (`src/settings/settings-manager.mts`)

`settingsManager` is a singleton with a pub/sub for **global** app settings (OpenAI API key, language, voice, optional AI instructions). Devices subscribe via `settingsManager.onGlobals(...)` to rebuild the agent on the fly when settings change. Use this to read settings anywhere without a `this.homey` reference.

## ESPHome firmware compatibility (the ESP client must support both)

The ESPHome native API changed its connection handshake across firmware versions, and the client in `src/voice_assistant/esp-voice-assistant-client.mts` must stay compatible with **both** old and new satellites:

- **ESPHome 2026.1.0+ (Voice PE firmware 26.x)** removed native-API **password authentication**. `ConnectRequest`/`ConnectResponse` (message ids 3/4) are deprecated and **no longer processed by the server** — the device never replies with a `ConnectResponse`.
- The handshake therefore sends `ConnectRequest` (still required to authenticate **pre-2026.1** firmware) but **does not wait** for `ConnectResponse`; it proceeds to the connected state immediately in `onConnectionEstablished()`. TCP ordering guarantees an older server processes `ConnectRequest` before the `ListEntitiesRequest` that follows, so this works on both 25.x and 26.x. **Do not** re-introduce gating the connection on `ConnectResponse`.
- **`object_id` is no longer sent in the entity list, and the client derives it.** We advertise API **1.14** in `HelloRequest`. That number gates exactly one server behaviour we care about: ESPHome 2026.1.0–2026.6.x send `ListEntities*Response.object_id` **only to clients advertising < 1.14**, and **2026.7.0+ never send it at all**. Because the field is `(force) = true` it still arrives — as an **empty string** — so an `if (message.objectId)` guard fails silently and takes volume, mute and the media-player key with it. `resolveObjectId()` therefore falls back to `src/voice_assistant/entity-object-id.mts`, which recomputes the id from the entity **name** exactly as the firmware does (`to_sanitized_char(to_snake_case_char(c))` per UTF-8 byte, per `EntityBase::write_object_id_to()`). **Never re-add a bare `message.objectId` check**, and before raising the advertised version again, read the `client_supports_api_version` call sites in ESPHome's `api_connection.cpp` — that is where any new gate appears. Full timeline and evidence: `COMPLETED.md` §18.
- **The voice assistant has exactly ONE owner.** `VoiceAssistant::client_subscription()` keeps a single `api_client_`: the first subscriber wins and the second is rejected with only a device-side `ESP_LOGE`, after which every voice message we send is dropped by `check_voice_assistant_api_connection_()` — audio, pipeline events, timer events **and announces** — on a connection that still lists entities and answers pings. In practice the other client is Home Assistant, which the satellite is usually still added to (that is why it has an encryption key at all). The client detects this and emits `voice_assistant_owner` (`VaOwnerState`): `suspected` from an empty `VoiceAssistantConfigurationResponse` (ESPHome's non-owner reply — **log/diagnostics only**, since a satellite without `micro_wake_word` answers the same way), and `taken` from a mic-open that draws no reply within 8 s (**proof** — an accepted announce always completes, capped by the firmware's 2 s `start_playback_timeout_`), which sets a device warning, **a Homey timeline notification and a spoken clip on the satellite** (throttled together to once a day per device, reset on `ok`). The clip goes out through `playMediaUrl()` — `MediaPlayerCommandRequest` is an ordinary entity command with no ownership gate, unlike the announce path every other feedback sound uses, which this very condition discards; it is fire-and-forget, with no completion ack to sequence on. `ok` from anything the device sends back clears both, and the verdict is re-derived per connection. Full evidence: `COMPLETED.md` §35 (GitHub issue #54).
- **Noise encryption** (`Noise_NNpsk0_25519_ChaChaPoly_SHA256`) is supported when the device has an API encryption key set (`api: → encryption: → key:` — the default once a device has been adopted by Home Assistant). The crypto + framing live in `src/voice_assistant/noise-frame-codec.mts` (self-contained, node:crypto only, unit-tested with a loopback responder in `tests/noise-frame-codec.test.mts`); the client runs the handshake before `HelloRequest` when `encryptionKey` is set and stays byte-for-byte plaintext when it isn't. The key comes from the per-device `encryption_key` setting (fallback: pair-time `store.encryptionKey`, collected in the manual-IP pair view). A plaintext connect answered with the Noise indicator (`0x01`) emits `requires_encryption`; Noise-path failures emit `encryption_error` with a precise code (`wrong_key`, `plaintext_device`, `mac_mismatch`, `invalid_key`, `protocol_error`). Protocol reference: `docs/esphome-noise-encryption.md`.

## Testing

Vitest with `globals: true`, node environment. Tests live in `tests/**/*.test.mts`. Mocks for Homey, DeviceManager, GeoHelper, WeatherHelper are in `tests/mocks/`. Some tests hit the real OpenAI API (`openai-connection-test`, `openai-agent-behavior`, `smart-home-agent`) and require a key — they are integration tests, not pure unit tests. They read it from the environment (`OPENAI_API_KEY=sk-... npm test`, via `tests/mocks/openai-test-key.mts`) and are reported as skipped without it. Never put a test key in `env.json`: Homey bundles that file into every built and published app.

## Reference docs

`docs/home-assistant-voice-preview-edition/` contains protocol notes (ESPHome native API, Wyoming protocol, communication flow, hardware reference) useful when changing the ESP client.

## User-facing docs — keep in sync with feature changes

Two files describe the app to end users and **must be updated whenever a user-visible feature changes** (new provider/backend, new flow card, new setting, new supported device, changed behavior):

- `README.md` — the full GitHub-facing doc (features, hardware setup, engine choice, settings, flow cards, how-it-works overview).
- `README.txt` — the Homey App Store description. Plain text, no markdown, non-technical, and it must stay consistent with README.md. **Keep it very short: two paragraphs on the core value proposition, plus the smart-lock safety note (verbatim — voice-unlocking is off by default and limited to one lock per command) and a closing pointer to the GitHub repo and Community topic.** Do NOT grow it back into feature lists — no per-engine breakdown, supported-device list, pairing instructions, requirements, Flow cards or settings detail; all of that belongs in README.md. App Store certification rejected the app once for a README.txt that had accumulated exactly those sections (App Store Guidelines 1.3), so when a new feature lands, update README.md and leave README.txt alone unless the core pitch itself changed.

When finishing a feature, check both before committing — stale READMEs have already happened once (the local pipeline shipped without either file mentioning it).

## Branching workflow

**One branch: `main`. Commit all new work straight to `main`.** There is no `dev` branch any more.

### Why one branch is enough

Publishing is **versioned**: every `homey app publish` needs a version number that has not been published before, and each version carries its own changelog entry. The build that comes out is a **test** version — only people who have the link to that exact version can install it. Certifying that test version makes it **live**, which auto-updates everyone who has the app installed. **Every publication gets certified to live** — that is the whole point of publishing here.

Because each published version is separately addressable and separately certifiable, there is no scarce test slot to schedule around and no reason to keep an integration line apart from a release line. Two branches only bought merge conflicts in the hotspots below.

`feature/*` branches therefore need a good reason. Legitimate ones are narrow —

- work that must be **abandonable** (a spike / prototype that may never land), or
- a change so invasive it would leave `main` unpublishable for days.

If neither applies — and usually neither does — commit to `main`. When a feature branch genuinely is warranted: branch from `main`, merge back into `main`, and delete it as soon as it lands (`git branch -d`, which refuses anything unmerged — never `-D`). Do not let it outlive the reason it was created.

### If a feature branch is in flight

`.homeycompose/app.json`, `app.json`, `package.json` (all three version fields) and `.homeychangelog.json` conflict whenever two lines of work touch them, so keep version bumps and changelog entries on `main` only. And **never hand-merge `app.json`** — it is generated. Take either side and regenerate:

```bash
git checkout --theirs app.json   # --ours works equally well
homey app build
git add app.json
```

## Releasing

**Every publication needs a new version number.** The version lives in **three** places and they must be bumped together:

1. `.homeycompose/app.json` — the source of truth. Everything else follows this.
2. `app.json` — generated; refresh it with `homey app build` after step 1 and commit the regenerated file.
3. `package.json` — **purely cosmetic, keep it in sync by hand.** Nothing reads it: the Homey CLI only looks at `devDependencies.typescript`, `type: "module"` and the dependency list, and no app code reads a version. It drifted to `1.0.0` for 1.4.x once already because `homey app publish` bumps the manifest and never touches it. Edit the field directly — do NOT run `npm version`, which also makes a commit and a git tag.

Then add the release's entry to `.homeychangelog.json` (user-facing wording — what changed for the user, not the commit subjects; skip anything that only touches `emulator/` or docs) and run `homey app validate --level publish` before committing. The `homey:manager:api` permission warning it prints is expected and not an error.

Each published version stands on its own: `homey app publish` uploads it as a **test** version reachable only by its own link, and **certifying it promotes that version to live**, auto-updating every existing install. The standing plan is to certify every publication, so treat a publish as "this is going to all users shortly" rather than as a private build. Nothing is overwritten by publishing — an older version is superseded only when a newer one is certified.

## Outstanding work

**`TODO.md` (repo root) is the single source of truth for what's left to do** — check it at the start of each session. It indexes everything outstanding (release testing checklist, ESP client, OpenAI Realtime, agent tools, firmware, local AI, Phase 2) with status markers. Finished items are archived with their full context (root causes, gotchas, verification notes) in `COMPLETED.md` — check there before re-investigating anything that sounds familiar. Two detailed reference docs feed into the TODO list: `OPENAI_API_IMPROVEMENTS.md` (OpenAI Realtime audit) and `docs/home-assistant-voice-preview-edition/implementation-gap-analysis.md` (ESPHome native-API coverage).
