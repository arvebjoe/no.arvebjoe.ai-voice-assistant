# COMPLETED — archive of finished work

Done items moved out of [`TODO.md`](./TODO.md). The full context is kept here **so we don't
re-investigate** — several of these were expensive diagnoses. Section numbers mirror TODO.md.

Items marked *(verify pending)* are implemented and believed correct, but never got a real-world
test — the release-testing checklist was dropped in the 2026-07-07 triage (§6 below), so verify
ad-hoc if one of them misbehaves.

---

## 1. ESPHome device client (`src/voice_assistant/`)

- [x] **BUG (FIXED 2026-06-26): follow-up turn produced no audio on the PE.** Root cause: in a
  `startConversation` follow-up the reply was sent as a standalone `VoiceAssistantAnnounceRequest`,
  which the PE acks (`AnnounceFinished`) but never fetches once it is in conversation mode → silence.
  Fix: deliver the reply **in-band** on the pipeline's `TTS_END` carrying the FLAC URL (`tts_end(url)`),
  and drive the single mic-reopen ourselves via a `peConversationActive` session flag in
  `src/homey/voice-assistant-device.mts`. A secondary chain-blocker (the PE's mic-open noise burst on
  auto-reopened turns tripping OpenAI's server VAD → ~0.5s dead window) was fixed with a per-turn
  follow-up skip (`followup_audio_skip` setting, default `DEFAULT_FOLLOWUP_SKIP_MS` = 150ms — decoupled
  from the wake-turn `initial_audio_skip` so a follow-up's first word isn't clipped). **Single follow-up
  AND chained multi-question conversations both confirmed on PE firmware 2026.6.2** (diagnosed using
  the `[PE]` device-log stream, below). See the follow-up item in §3 and branch `fix/followup-turn-audio`.

- [x] **Conversation-flow hardening — 2026-07-02 fix round (commits 77bd40c…94f94aa).** All confirmed
  on the real PE unless noted (remaining warts stay open in TODO §1):
  - Broadened pairing device-type sniff so self-compiled firmware (no "Nabu Casa"/"PE" identity
    strings) is listed again.
  - Always-on `[CONVO]` conversation trace (wake→VAD→STT→tools→LLM→TTS→continue/stop) + new
    `tool.completed` provider event.
  - Spurious-VAD-trip retry (PE auto-reopen catches TTS echo → empty transcript <2.5s → reopen
    instead of ending session).
  - Suppress `response.done` for function_call responses (tool-turn replies were routed to the
    announce path mid-conversation and silently dropped).
  - `continue_conversation` sent as INTENT_END event data so the PE closes after non-question
    replies (the firmware flag is sticky — verified in esphome voice_assistant.cpp).
  - Playback-aware `lastTurnEndedAt` (+pcmBytes/48 ms) so long in-band replies don't eat the 10s
    context TTL and wipe the LLM context mid-conversation *(verify pending — re-run the 3-question quiz)*.

  Details: memory `followup-turn-no-audio-rootcause.md`.

- [x] **Device-log streaming for diagnosis (2026-06-26)** — opt-in `SubscribeLogsRequest` (id 28) over
  the native API streams the PE's own ESPHome logs back (`SubscribeLogsResponse`, id 29), printed inline
  under `[PE]` alongside the `[ESP]`/app logs. Gated by `ESP_LOG_LEVEL` (env var) or the `logLevel` client
  option; off by default, no serial/USB needed, works for the emulator and a real device. This is what
  made the follow-up-audio diagnosis tractable.

- [x] **BUG: devices not appearing in the pairing dialog on repeat attempts** — _fixed 2026-06-20._
  Root cause was a **reconnect leak in the discovery capability probe**, not firmware version (the
  original "v25.7 vs v26.4" framing was a red herring — both firmwares advertise `platform=ESP32` and
  pass the `txt.platform` discovery condition fine; Homey's regex match is case-insensitive).
  - **Real mechanism (confirmed live with ESP-client logging):** during pairing, the driver opens a
    one-shot `EspVoiceAssistantClient` probe per discovered device. If a probe errored or finished,
    `handleDisconnect()` would `emit('Unhealthy')` (→ driver `finish()` → `disconnect()`, which clears
    the reconnect timer) and **then** call `scheduleReconnect()` — setting a *new* timer after cleanup
    that nothing ever cleared. That orphaned timer fired `start()` → error → `scheduleReconnect()` →
    an infinite zombie reconnect loop, one per failed probe. The zombies kept hammering the device and
    occupying ESPHome's limited API connection slots, so the next dialog open failed with
    `read ETIMEDOUT` and showed no devices. An app restart killed the zombies (sockets die with the
    process) — which is why restarting "fixed" it and the first attempt always worked.
  - **Fix** (`src/voice_assistant/esp-voice-assistant-client.mts`): (1) `autoReconnect` flag derived
    from `discoveryMode` at construction — probes never reconnect; (2) terminal `closed` flag set in
    `disconnect()` so no reconnect can be scheduled after close, even from a late socket event;
    (3) `scheduleReconnect()` bails on `closed || !autoReconnect`; (4) strip socket listeners
    (`removeAllListeners()`) before `destroy()` in `disconnect()`/`handleDisconnect()`/`start()` so a
    dead socket's late close/error can't re-enter the reconnect path. Verified: repeated dialog opens
    now probe cleanly (`Scheduling reconnection` count = 0), both devices reappear every time.
  - **Related latent risk surfaced during investigation:** the newer PE firmware advertises
    `api_encryption_supported` (`Noise_...`). Plaintext still works while no key is set, but if a user
    sets an API encryption key, `api_encryption` appears and the plaintext-only client fails — see the
    Noise item in TODO §1.

- [x] **Timer support — voice-driven timers + alarms (2026-06-23).** `set_timer` / `cancel_timer` /
  `get_timer` tools; new `TimerManager` owns the authoritative countdown and sends
  `VoiceAssistantTimerEventResponse` (STARTED/CANCELLED/FINISHED) to the PE for the LED ring + finish
  chime. **Alarms** ("Sett alarm til kl 11") are timers with a duration the LLM computes from
  `get_local_time`. Re-arms the ring on reconnect. See
  [`docs/.../timer-feature.md` §9](./docs/home-assistant-voice-preview-edition/timer-feature.md).
  *(Single-timer-only limitation stays open in TODO §1.)*
  - **Resolved (verified on hardware 2026-06-23):**
    - A **finished/ringing** timer no longer blocks a new one — `startTimer` silently sends
      CANCELLED to stop the ring and starts the new timer (no "replace?" prompt). Only a *running*
      countdown triggers the TIMER_ALREADY_ACTIVE replace flow.
    - **LED ring re-arms on reconnect.** `reissue()` is fired from the `capabilities` event
      (handshake complete), NOT `Healthy` (which fires right after TCP connect, before the device
      subscribes to the voice assistant — a timer event sent then is dropped and the ring never shows).
    - **By design:** if a timer elapses while the device is disconnected, it does NOT ring on
      reconnect (`reissue` skips finished timers). Intended — a stale alarm shouldn't fire late.
    - **No device→host timer events to handle:** pressing the device button just triggers the mic
      (like the wake word); it does not dismiss the timer, so there's nothing to receive/clear.
  - [x] **Flow cards (done, hardware-verified 2026-06-23):** triggers (started/finished/cancelled),
    condition (timer-is-running), actions (start/cancel).
  - [x] **Tile capabilities (done, hardware-verified 2026-06-23):** read-only
    `timer_active` / `timer_remaining` (seconds, 1 Hz tick) / `timer_name` on the device card,
    on both drivers; the device mirrors the TimerManager lifecycle onto them.
  - [x] **LED-drift resync (done 2026-06-23) *(hardware verify pending)*:** `TimerManager` re-issues a
    quiet `UPDATED` with the authoritative `seconds_left` every 30 s while a timer counts down, so the
    PE's locally-ticked LED ring can't drift on long/alarm-length countdowns (skipped while
    disconnected; `reissue()` still re-arms on reconnect). _(gap analysis #5)_
  - (Timers are intentionally **not** persisted across an app restart — an in-flight timer is dropped,
    which is the expected, least-surprising behavior.)

- [x] **2026.1 handshake fix** — ESPHome 2026.1.0 (PE firmware 26.x) removed password auth;
  client no longer waits for `ConnectResponse`, stays backward compatible with 25.x. Verified on
  firmware 26.4.0. See `CLAUDE.md` → "ESPHome firmware compatibility".
  (The encryption item in TODO §1 is the remaining piece of the same area.)

- [x] Done in gap analysis: `WAKE_WORD_END`, `ERROR` events, `INTENT_PROGRESS`, version-check,
  `SubscribeStates`, extra entity-type handlers.

- [x] **Wake-word selection (2026-07-07, gap analysis #7).** The ESP client parses the wake-word
  data already present in `VoiceAssistantConfigurationResponse` (`available_wake_words`,
  `active_wake_words`, `max_active_wake_words`), stores it, and emits a `wake_words` event on every
  config response (fires on each connect and after a change). New client methods
  `getAvailableWakeWords()` / `getActiveWakeWords()` / `setActiveWakeWords(ids)` — the setter sends
  `VoiceAssistantSetConfiguration` (id 123, the same call Home Assistant uses) then re-requests the
  config so the cached state reflects what the device applied. PE device settings gained a read-only
  **Available wake words** label (kept in sync from the device, active one marked) and a **Wake word**
  text field; `onSettings` resolves the typed name/id case-and-separator-insensitively against the
  reported list and activates it, rejecting an unknown word with the available list in the error
  (which the SDK surfaces to the user). No new proto — the fields were always in `api.proto`.

---

## 2. OpenAI Realtime API (`src/llm/providers/openai-realtime-agent.mts`)

Audit items 1–7, 10, 12 are done — see [`OPENAI_API_IMPROVEMENTS.md`](./OPENAI_API_IMPROVEMENTS.md).
Sub-items of the still-open "Improve STT accuracy" work:

- [x] Switched the sidecar transcription model `gpt-realtime-whisper` → **`gpt-4o-transcribe`**
  (2026-07-02; `delay` removed — only supported by gpt-realtime-whisper). *(verify pending on real speech)*
- [x] **Text-anchored replies (2026-07-02)** *(verify pending on real speech)* — proven necessary same
  day: "Fortell meg en vits" transcribed perfectly but the model answered the *audio* with the local
  time. The agent now replaces the committed audio item with the transcript
  (`conversation.item.delete` + `sendUserText` + `createResponse`), so the model answers what
  `gpt-4o-transcribe` heard. Near-zero latency cost since we already waited for
  `transcription.completed`.
- [x] **#9 Model quality setting (2026-07-07).** New `openai_model` global setting (`full` |
  `mini`) with a "Model quality" dropdown in the OpenAI section of the settings page. `full` =
  `gpt-realtime-2025-08-28` (the previous hardcode), `mini` = `gpt-realtime-mini`. The model rides
  in the websocket URL, so the URL is resolved fresh in `start()` (`realtimeUrl()`) and the device
  forces a provider restart when the setting changes (`handleSettingsChange`). An explicit
  `options.url` still wins (tests / overrides).
- [x] **#11 Act on `rate_limits.updated` (2026-07-07).** `checkRateLimits()` in the agent: log
  warning when any quota window drops below 20% remaining; Homey notification below 5%, throttled
  to one per hour (`lastQuotaNotificationAt`) since the event arrives after every response.
- [x] **STT vocabulary prompt (2026-07-07).** The sidecar transcription now carries a `prompt`
  with the device/zone names: `DeviceManager.getVocabularyNames()` (unique zones + device names)
  → `ToolManager.getSttVocabulary()` → `sttVocabularyPrompt()` in `sendSessionUpdate`, capped at
  800 chars. Empty until the catalog loads — the next session.update (reconnect, settings change,
  30 s idle-timeout reopen) picks it up. *(Real-speech Norwegian verification never happened —
  dropped with the rest of the hardware checklist in the 2026-07-07 triage, test ad-hoc.)*
- [x] **#8 Simplify VAD response trigger — closed as won't-do (2026-07-07).** `create_response:
  true` would make the model answer the *audio*, undoing the text-anchored-replies fix above
  (the whole point is answering the far-more-accurate sidecar transcript). Rationale recorded in
  OPENAI_API_IMPROVEMENTS.md §8. Barge-in (`interrupt_response`) could be a separate future item.

---

## 3. Agent tools

- [x] **Follow-up / keep conversation alive (done 2026-06-26)** — answer follow-up questions without
  repeating the wake word (via `startConversation`). Single follow-up and chained multi-question
  conversations both work; the reply is delivered in-band on `TTS_END` and the PE auto-reopens the mic
  for each subsequent turn. The session ends on a silent turn (user has nothing to say) or after the
  context TTL. See §1 (follow-up audio bug, fixed) and branch `fix/followup-turn-audio`.

- [x] **Help! (2026-07-07)** — new `get_assistant_capabilities` tool: "what can you do?" returns a
  summary plus the live registered tool list (name + description), built from `ToolManager.tools`
  so it stays correct as tools come and go (timer tools only listed when the device supports them).
  The tool description instructs the model to summarize conversationally in the user's language.

- [x] **Web search (2026-07-07)** — new `web_search` tool for current/local info ("what's on at the
  cinema today?", "when does the next bus leave?"). Backend chosen by the `web_search_provider`
  setting (`src/helpers/web-search.mts`):
  - `openai` (default): OpenAI Responses API with the hosted `web_search` tool, reusing
    `openai_api_key`. The model searches AND summarizes; the tool returns `{ answer, sources }`.
    The device's IANA timezone is passed as `user_location.approximate` (Homey exposes no
    city/country) so "the local cinema" resolves. Model `gpt-5-mini`.
  - `brave`: Brave Search API (`brave_api_key`, free tier) — returns raw `{ results[] }` snippets;
    the voice agent's own LLM summarizes.
  - `disabled`: the tool returns a WEB_SEARCH_DISABLED error the model relays.
  Settings page: a "Web search" dropdown + a Brave key field shown only for the Brave backend.

- [x] **Music via Music Assistant (2026-07-09)** *(live verify pending — checklist in TODO.md)* —
  voice-controlled music on the PE and TR through a [Music Assistant](https://www.music-assistant.io/)
  server. **The audio never touches this app**: both devices are native Sendspin players (PE stock
  26.x firmware — see `sendspin:` in `.esp_home/home-assistant-voice.yaml`, merged upstream in
  ESPHome 2026.5; TR ships `sendspin-client`), and MA ≥ 2.7 streams to them directly. We are the
  control plane only:
  - `src/helpers/music-assistant-client.mts` — minimal client for MA's WebSocket JSON API
    (`ws://<host>:8095/ws`; command/result with `message_id` correlation, `partial` list-chunk
    accumulation, error mapping, lazy connect + reconnect-on-next-command). One shared instance
    app-wide (`getMusicAssistantClient()`). Commands used: `players/all`, `music/search`,
    `player_queues/get_active_queue`, `player_queues/play_media`, `player_queues/<transport>`,
    `player_queues/shuffle`. Protocol source: `music-assistant/models` api.py + the python/TS
    reference clients.
  - Four tools in `ToolManager` (Bring!-style opt-in gating on `music_assistant_enabled` +
    `music_assistant_host`): `search_music`, `play_music` (query or uri; media_type;
    play/next/add; radio_mode), `music_control` (pause/resume/stop/next/previous/shuffle_on/off;
    resume maps to `play` when paused, `resume` otherwise), `get_music_state`. Transport goes to
    the **active queue** (`get_active_queue`), so group playback is steered at the group leader.
  - Satellite→player mapping: the device passes a hint callback (IP from the store, Homey device
    name, zone); `resolveMusicPlayer` matches MA players by IP → device name → zone name, so
    "play X" targets the speaker being spoken to; explicit `player` arg (fuzzy name match) wins;
    failures return the available player names for the model to ask with.
  - Prompt block in `src/llm/instructions/music-instructions.mts` (12 languages, one shared file
    like the shopping-list block), gated by `supportsMusic` through `InstructionState` and
    `updateMusicSupport` on all three providers; device reconciles on settings change and
    restarts the provider when the active state flips (same dance as Bring!).
  - Tests: `tests/music-assistant-client.test.mts` (scripted in-process WS server: handshake,
    correlation, partials, errors, reconnect) and `tests/tool-manager-music.test.mts` (gating +
    handlers with a fake client). READMEs updated (music section + the previously missing
    ThirdReality hardware section).
  - Deliberately out of scope: XiaoZhi as a music target (no Sendspin client), MA volume tools
    (device volume already handled over ESPHome), event subscriptions (player/queue state is
    fetched on demand). The Homey MA app (`com.cyrilhendriks.musicassistant`) coexists fine —
    same MA API, different consumer.

---

## 4. Custom ESPHome / PE firmware

- [x] **Custom wake word "Hey Homey"** — done via [microwakeword.com](https://microwakeword.com/).
  Gotcha that cost hours: it must be **microWakeWord** (runs on-device), NOT **openWakeWord**
  (server-side) — they have near-identical names but an openWakeWord `.tflite` flashes fine then
  crash-loops the PE (`Failed to get registration from op code SHAPE` → LoadProhibited). Model lives
  in `.esp_home/wake_words/`, referenced from the config via a **`raw.githubusercontent.com`** URL
  (the `github.com/.../raw/` redirect form fails ESPHome's model validation). See
  [`.esp_home/CUSTOMIZATIONS.md`](./.esp_home/CUSTOMIZATIONS.md).

---

## 5. Local / offline AI

First round of the locally-hosted stack shipped 2026-07-05 (branch
`claude/local-stt-llm-tts-provider-oc0cng`, merged in PR #12). New `local` voice provider
(`src/llm/providers/local-pipeline-provider.mts`) selectable in app settings, with per-service
host/port boxes. Pipeline: on-device energy VAD (`local/simple-vad.mts` — the cloud providers'
server VAD has no local equivalent) → STT → LLM (full ToolManager tool loop) → TTS,
sentence-by-sentence while the LLM streams, resampled to the 24 kHz seam contract. Health probes +
reconnect campaign + 60 s idle re-probe drive device availability. *(End-to-end verification against
real services is still open — TODO §5.)* Backends delivered:

- [x] **Whisper STT over HTTP** (`local/whisper-client.mts`) — auto-detects `/asr` =
  whisper-asr-webservice, `/v1/audio/transcriptions` = speaches/faster-whisper-server,
  `/inference` = whisper.cpp. `local_stt_host`/port settings.
- [x] **Ollama LLM** (`local/ollama-client.mts`) — `/api/chat` streaming with the full ToolManager
  tool loop, strips `<think>` blocks from reasoning models. `local_llm_host`/port/model (model
  defaults to the first installed one).
- [x] **Piper TTS over HTTP** (`local/piper-client.mts`) — `POST /synthesize` with `POST /` fallback.
  `local_tts_host`/port settings.
- [x] **Mistral as an alternative LLM backend (2026-07-05).** Mistral has no unified realtime
  speech-to-speech API (their docs compose voice agents as STT→LLM→TTS). So the pipeline's
  LLM stage is pluggable behind `ILlmClient` (`local/llm-client.mts`, backend-neutral
  messages/tool calls): `local_llm_provider` setting = `ollama` (default) or `mistral`
  (`local/mistral-client.mts`, `/v1/chat/completions` SSE streaming + tool calling; gotcha:
  Mistral validates `tool_call_id` as EXACTLY 9 chars `[a-zA-Z0-9]`, hence
  `sanitizeToolCallId`/`generateToolCallId`). Settings page: LLM backend pulldown — Ollama shows
  host/port/model, Mistral shows API key (`mistral_api_key`) + model (`mistral_model`, default
  `mistral-small-latest`).
- [x] **Mistral Voxtral as alternative STT and TTS backends (2026-07-05)** *(verify pending against
  the real API)*. Same seam treatment for the other two stages (`ISttClient`/`ITtsClient` in
  `local/stt-client.mts`/`tts-client.mts`): `local_stt_provider` = `whisper` (default) or
  `mistral` (`local/mistral-stt-client.mts`, `POST /v1/audio/transcriptions` multipart, default
  model `voxtral-mini-latest`, override `mistral_stt_model`); `local_tts_provider` = `piper`
  (default) or `mistral` (`local/mistral-tts-client.mts`, `POST /v1/audio/speech` →
  WAV 24 kHz mono = the seam contract exactly). TTS request shape verified 2026-07-05 against
  Mistral's official Python SDK (generated from their OpenAPI spec): the voice field is
  **`voice_id`** (not `voice`). Two spec-vs-live-server gaps surfaced on a real device
  2026-07-06: `model` is marked optional but the server 422s without one ("No model provided
  for speech") — the client now always sends `voxtral-mini-tts-2603` unless
  `mistral_tts_model` overrides it; and the "20 preset voices" from the open-weights model
  card (`neutral_female` etc.) don't exist on the hosted platform (404 "Voice not found") —
  the platform serves its own library via `GET /v1/audio/voices` (30 voices, UUID ids +
  slugs like `en_paul_neutral`). The Voice dropdown is now populated live from that endpoint
  (`LocalPipelineProvider.getAvailableVoices(ttsBackend?)` went async,
  `/voices?provider=local&tts=…`), the stored value is the voice UUID, and a non-library
  `selected_voice` (legacy OpenAI/Gemini names) resolves to a neutral voice at synthesis.
  One shared `mistral_api_key` for all Mistral-backed stages; the settings page shows the key
  field when any stage picks Mistral, and each stage independently shows LAN host/port vs
  cloud model boxes. Any keyless Mistral stage → `missing_api_key`/`hasApiKey()=false`.
- [x] **Generic OpenAI-compatible backend for every stage (2026-07-05)** *(verify pending against
  real services)*. Third option (`openai`) in each stage's dropdown, with per-stage base URL /
  optional API key / model settings (`openai_stt_*`, `openai_llm_*`, `openai_tts_*` — stages
  may point at different servers). One implementation covers OpenAI itself, Groq
  (https://api.groq.com/openai/v1 — fastest tokens + dirt-cheap Whisper), OpenRouter, DeepSeek,
  LM Studio / llama.cpp / vLLM / LocalAI / Ollama's `/v1` shim (LLM), speaches (STT), and
  kokoro-fastapi (TTS). `local/openai-compat.mts` has the shared URL normalizer (bare host →
  `http://…/v1`; explicit paths kept verbatim) + `/models` health probe (401/403 → key error,
  404 tolerated); `openai-llm-client.mts` is the SSE chat client base class that
  `MistralClient` now subclasses (Mistral = same dialect + pinned endpoint + 9-char id
  sanitization); `openai-stt-client.mts`/`openai-tts-client.mts` mirror the audio endpoints.
  TTS voice: the Voice dropdown offers OpenAI's standard voices; the free-text
  `openai_tts_voice` override wins for custom servers (e.g. Kokoro's `af_heart`). API key is
  optional (LAN servers) — a keyed server rejecting shows up in the health probe.
- [x] **Wyoming-protocol STT backend (2026-07-05) — for `rhasspy/wyoming-faster-whisper` on
  TCP port 10300.** Real-world testing showed the user's "faster-whisper" docker is the Home
  Assistant Wyoming build — raw TCP with newline-JSON events + binary PCM payloads, NOT HTTP,
  so the HTTP `WhisperClient` can never reach it (that was the connect failure in the log).
  New `local/wyoming-protocol.mts` (framing per
  `docs/home-assistant-voice-preview-edition/wyoming-protocol.md`: header line with optional
  `data_length` side-band JSON + `payload_length` binary) and `local/wyoming-stt-client.mts`
  (`transcribe`→`audio-start`/`audio-chunk`×N/`audio-stop`→`transcript`, streaming
  transcript-chunk/-stop also handled; health check = `describe`→`info` with an `asr` entry).
  Fourth STT dropdown option "Wyoming — faster-whisper (local)" with its own
  `wyoming_stt_host`/`wyoming_stt_port` settings (default 10300); Test button supported.
- [x] **Wyoming-protocol TTS backend (2026-07-05) — for `rhasspy/wyoming-piper` on TCP port
  10200** (the user's Piper turned out to be the Wyoming build too).
  `local/wyoming-tts-client.mts` on the same protocol module: `synthesize {text}` →
  `audio-start`/`audio-chunk`×N/`audio-stop` collected into PCM at the announced rate; health
  check = `describe`→`info` with a `tts` entry. TTS dropdown option "Wyoming — Piper (local)"
  with `wyoming_tts_host`/`wyoming_tts_port` (default 10200); voice is server-side like HTTP
  Piper; Test button supported.
- [x] **LM Studio as a first-class LLM backend (2026-07-05).** It already worked through the
  generic OpenAI-compatible backend, but as a desktop app it gets the Ollama treatment:
  dropdown option "LM Studio (local)" with `lmstudio_host`/`lmstudio_port` (default 1234) and
  an OPTIONAL `lmstudio_model` (empty = auto-pick the first model from `GET /v1/models`,
  cached). `local/lmstudio-client.mts` is a thin `OpenAiLlmClient` subclass (keyless, host/port
  → base URL, `resolveModel()` named like Ollama's so the provider's health flow calls it).
- [x] **Per-stage "Test" buttons in the settings page (2026-07-05).** Each stage section has a
  Test button that POSTs the CURRENT (unsaved) form values to the app's new
  `POST /test-local-stage` endpoint (route in `.homeycompose/app.json`; handler in `api.mts` →
  `local/stage-tester.mts`) — the webview can't reach LAN services itself, so the test runs
  from the Homey box. Not just a ping: one real mini-request per stage (STT transcribes 0.5 s
  of silence, LLM answers "Reply with exactly: OK", TTS synthesizes "OK"), so wrong model ids,
  rejected keys and bad voices surface, with latency and the underlying cause (ECONNREFUSED …)
  shown inline. 30 s bound per test.
- [x] **Per-request Piper voice selection (2026-07-07).** `PiperClient` now sends the app's
  `selected_voice` as `/synthesize {voice}` (piper1-gpl supports it), but only after confirming
  the id against the server's own `GET /voices` dict (fetched once, cached) — so a stale
  cross-backend `selected_voice` (an OpenAI name / Voxtral UUID left over from a backend switch)
  falls back to the server default instead of 4xx-ing every synthesis; a server without `/voices`
  disables voice selection entirely. The Voice dropdown for the Piper backend lists the server's
  installed voices behind a "Server default voice" entry (`listPiperVoices` +
  `getAvailableVoices('piper')`). Sentinel `server-default` = no voice sent.
- [x] **Mistral Voxtral Realtime — streaming STT backend (2026-07-07).** Fifth STT dropdown option
  "Mistral Voxtral Realtime (cloud, streaming)" using Mistral's websocket transcription endpoint
  (`wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=…`), much lower latency than the
  batch upload. `local/mistral-realtime-stt-client.mts` — the wire protocol was reverse-engineered
  from the official `mistralai` Python SDK v2.6.0 (`mistralai/extra/realtime/`), since the docs
  pages are behind a bot wall: on `session.created` send `session.update` with
  `audio_format {encoding:pcm_s16le, sample_rate:16000}` + `target_streaming_delay_ms:480`, then
  base64 `input_audio.append` chunks (kept under the 256 KiB decoded cap), then `input_audio.flush`
  + `input_audio.end`; collect `transcription.text.delta`, resolve on `transcription.done`. Shares
  `mistral_api_key`; optional `mistral_stt_realtime_model` override (default
  `voxtral-mini-transcribe-realtime-2602`). No language param — the model detects it. Test button
  supported. *(Verify against the live Mistral API — like the other Voxtral stages, only unit-tested
  so far with a fake websocket.)*

---

## 6. 2026-07-07 triage — dropped items

The old TODO list was emptied on 2026-07-07: every item was either completed (archived in the
sections above) or explicitly dropped by the owner. Dropped items and their context, in case any
come back:

- **§0 release-testing checklist** (3-question quiz re-run, LED-phase fidelity on the PE, fresh
  `[CONVO]` trace, STT changes on real speech, timer LED-drift resync, local pipeline against real
  services, README image refresh) — all needed real hardware; owner chose to test ad-hoc instead
  of tracking them. The README images (`.resources/settings.jpg` predates the provider redesign)
  are still stale — remember them before a store release.
- **§1 conversation-flow warts** — the multi-segment announce race (short first segment's ack
  arrives before segment 2 exists → premature turn-complete, self-heals by luck) and the
  keepOpen-with-no-audio edge (`peConversationActive=true` but no TTS URL → PE may not reopen).
  Details survive in memory `followup-turn-no-audio-rootcause.md` if the bugs resurface.
- **§1 multiple concurrent timers** — single-timer limitation stays; the agent asks to replace.
- **§1 ESPHome Noise encryption** — plaintext-only client stays; revisit when a user asks
  (a satellite with an API encryption key set cannot connect at all).
- **§2 #8 simplify VAD response trigger** — closed as won't-do (see §2 above).
- **§3 start flows by voice / change settings by voice / unchunked flow-triggered replies** —
  dropped; the unchunked-replies idea touches the announce queue with the known race, riskier
  than it looks.
- **§4 LED thinking-phase bug** (old white pulse despite `Cold Rainbow` in the config; suspected
  stale flash) — hardware-only diagnosis, dropped from tracking. The debug steps if it returns:
  confirm the running build via boot-log `compiled on` timestamp, verify the editor config,
  watch device LOGS during the thinking phase.
- **§5 SimpleVad threshold tuning / wake-word→reply latency measurement / optional auth on the
  LAN endpoints** — dropped.
- **§6 image analysis** — dropped (web search survived and was implemented).

---

## 7. Code review 2 fixes — 2026-07-12 (branch `claude/code-review-issues-4bi8d4`)

External review of `main` @ `0a64afa` archived in [`docs/code_review_2.md`](./docs/code_review_2.md);
every finding was verified against the code before fixing. The items below are FIXED with
regression tests; the review's remaining items (M2 Noise encryption, M5 stage-test validation,
M6 npm-audit chains, M7 start() semantics, L1/L3/L4/L5) stay open in TODO.md.

- [x] **H1 + L2 — settings save raced provider rebuilds/restarts.** One settings-page Save wrote
  ~20 keys; Homey fires one `set` event per key and `SettingsManager` emitted a full snapshot for
  each, so every subscriber (device rebuild/restart, local pipeline health re-probe) ran ~20×
  concurrently — a late `close→delay→start` continuation could act on a provider another update
  had already destroyed. Fixes: (1) `SettingsManager` debounces subscriber emits by 300 ms
  (`getGlobal` readers still see fresh values synchronously; `flushGlobalsEmit()` is the test
  hook); (2) the device serializes `handleSettingsChange` through a per-device promise queue and
  awaits `provider.restart()`; (3) the zone-change restart and the local pipeline's health
  re-probe no longer discard rejections; (4) the settings page (L2) promisifies all `Homey.set`
  calls, awaits them together, disables Save while in flight, shows one final error, and
  refreshes the voice list after the writes actually land (was a fixed 500 ms timer). Tests:
  burst-coalescing + final-snapshot + reset-cancels-pending in the pub/sub suite.

- [x] **H2 — concurrent "ask as text" Flow calls cross-wired answers.** `askAgentOutputToText`
  resolved via a shared `once('text.done')` with no request id, so two in-flight requests both
  consumed the FIRST answer. Now serialized through a per-device FIFO queue (exactly one pending
  listener); a failed entry doesn't wedge the queue. Bonus fix: an async
  `sendTextForTextResponse` rejection used to be discarded (request waited out the full 30 s
  timeout) — it now rejects immediately. Harness tests cover both.

- [x] **H3 — weather fetches could hang forever.** The three Open-Meteo `fetch()` calls had no
  `AbortSignal`; a stalled (not failing) connection would hang the awaiting caller — including
  `WeatherHelper.init()`'s diagnostic prefetch, which `app.mts` awaits during startup (a hang
  there kept every voice device offline), and any weather tool call holding a voice turn open.
  All three now use `AbortSignal.timeout(15 s)`.

- [x] **H4 (mitigation) — web search output marked untrusted.** Brave snippets / OpenAI-summarized
  answers went to the model verbatim: an indirect prompt-injection channel into a session holding
  `set_device_capability`. Both backends now wrap results with an explicit untrusted-content
  notice (data only; ignore embedded instructions; never operate devices because web content says
  so), and the tool description repeats the rule. Chosen over per-language prompt blocks because
  it appears at the moment the model consumes the data, works in every language, and costs no
  context when search is off. The one-device unlock cap stays the code-enforced backstop
  (deliberately not a confirmation prompt — see the S3 comment in tool-manager.mts); an
  `allow_unlock_via_voice` setting remains an open product question in TODO.md.

- [x] **M1 — Wyoming framing/queue unbounded.** `drainBuffer` trusted `data_length`/
  `payload_length` verbatim (huge frame → unbounded buffering; negative/fractional/non-numeric →
  parser desync) and the event queue had no cap. Lengths must now be non-negative bounded
  integers (1 MB extra JSON / 32 MB payload), header line capped at 64 KB, queue at 1024 events;
  violations fail the connection and destroy the socket. Tests: huge/negative/fractional/
  non-numeric lengths, newline-less header, queue flood, legit-frame still parses.

- [x] **M3 — stale Music Assistant socket failed the new socket's commands.** The old socket's
  delayed `close` handler called `failAllPending()` unconditionally, so after a config change
  opened a replacement it rejected commands pending on the NEW socket. Pending commands are now
  only failed when the closing socket is still current (`this.ws === ws`); `disconnect()` still
  fails the old socket's own pending commands explicitly. Regression test reproduces the
  stale-close-after-reconnect ordering (confirmed red on the old code).

- [x] **M4 — audio-folder init raced first playback.** `app.mts` fired `initAudioFolder()`
  without awaiting; its cleanup deletes EVERY file in `/userdata/audio`, so an early reply-audio
  write could be deleted mid-startup (valid URL → 404 on the satellite). Now awaited before any
  device comes online.

## 8. TR + PE pairing live verification & fixes — 2026-07-18/19

Live session with a factory-reset TR and PE. Verified the Improv BLE wizard end-to-end on both
devices (TODO §Wi-Fi setup) and root-caused two long-standing pairing complaints.

- [x] **TR invisible in "Find it on my network" — mDNS discovery condition.** The shared
  discovery config (`.homeycompose/discovery/esphome.json`) only accepted `txt.platform`
  matching `esp32|ESP32`; the TR is a Linux box advertising `platform=ThirdReality` (verified
  live with the emulator's `dns-sd` browser). The TR README's "discovery works as-is" claim had
  only checked the `_esphomelib._tcp` service name. Regex broadened to
  `esp32|ESP32|ThirdReality|thirdreality`. **When adding any non-ESP32 satellite, check its TXT
  `platform` value first.**
- [x] **Intermittently blank pairing dialog — Firefox, not us.** Breadcrumb logging proved the
  pair session always reached `onPair` while the first custom view never rendered (`showView`
  event never fired; backend-forced `session.showView()` ignored; the Homey served the view
  HTML 15/15 over the CLI). Chrome and the iPhone app: 100% reliable. Root cause confirmed by
  the owner: **Firefox's Enhanced Tracking Protection blocks the cross-origin `homeylocal.com`
  pair-view iframe** on my.homey.app; a normal `homey app install` (vs dev `homey app run`)
  also reduces the failure rate. Kept as permanent diagnostics: `[Pair]` session breadcrumb,
  `Pair view shown:` log, and a 2.5 s warn-only blank-view detector (a showView auto-nudge was
  tried and removed — the dead client ignores it).
- [x] **BLE wizard: per-driver device filter.** Both satellites in setup mode appeared in both
  drivers' Bluetooth lists. Added `deviceNameFilter` (improv-pair-handlers) driven by a new
  `VoiceAssistantDriver.improvNameFilter`: TR = `/3rspk|thirdreality/i`, PE =
  `/home[-\s]?assistan|ha[-\s]?voice/i`. **Gotchas that shaped the PE pattern:** the BLE
  advertisement name is NOT the mDNS/HA-app name — a factory 26.x PE advertises
  `ha-voice-pe-093b27` while the HA app displays `home-assistan-093b27` (GATT-read, truncated
  full name); BLE truncates to fit the 31-byte advertisement. Devices discovered WITHOUT a
  localName are always kept (ESPHome alternates name/service advertisements) — only
  positively-identified foreign devices are hidden, and the scan logs every advertisement's
  localName (`Improv adv:`) so future name mismatches are a ten-second diagnosis.
- [x] **"Press the button" prompt never showed (PE authorization).** The Improv client emitted
  'status' only on state TRANSITIONS, but an authorizer device is already in
  AwaitingAuthorization when provision() starts waiting → no event → the wizard stayed on
  "Sending Wi-Fi credentials…". `provision()` now emits the current state when entering the
  wait. Verified live: PE shows the center-button prompt; **TR needs no authorization at all**
  (connects already-Authorized).
- [x] **Post-BLE network search raced the device's Wi-Fi join.** Clicking "find it on the
  network" quickly showed an empty list (satellite takes up to ~1 min to join + announce).
  `list_devices` now holds its promise open (template shows its native "Searching…" spinner)
  re-scanning every 5 s until a device is found or a 2-min deadline passes — resolving empty
  early and emitting later leaves the template's "No new devices" text on screen (glitch is
  specific to the empty→found transition; appending to a populated list renders fine).
  Per-session probe cache distinguishes **definitive** rejections (device answered, wrong
  model — never re-probed) from **transient** failures (mDNS up, API not yet — retried every
  round); `checkVoiceCapabilities` now returns `{ device, definitive }`.
- [x] **Spurious "WebSocket was closed before the connection was established".** Adding a
  device fires its zone-resolve callback which calls `provider.restart()` while the OpenAI
  websocket is still CONNECTING; `ws` emits a synthetic error for close-during-connect that we
  logged + homey-log captured as an exception on every fresh pair. The error handler now
  swallows exactly that case while `isManuallyClosing` (one info line instead).
