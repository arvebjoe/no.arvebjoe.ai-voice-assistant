# COMPLETED — archive of finished work

Done items moved out of [`TODO.md`](./TODO.md). The full context is kept here **so we don't
re-investigate** — several of these were expensive diagnoses. Section numbers mirror TODO.md.

Items marked *(verify pending)* are implemented and believed correct, but still need a real-world
test before the store release — they are tracked in TODO.md §0 (release testing checklist).

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

---

## 3. Agent tools

- [x] **Follow-up / keep conversation alive (done 2026-06-26)** — answer follow-up questions without
  repeating the wake word (via `startConversation`). Single follow-up and chained multi-question
  conversations both work; the reply is delivered in-band on `TTS_END` and the PE auto-reopens the mic
  for each subsequent turn. The session ends on a silent turn (user has nothing to say) or after the
  context TTL. See §1 (follow-up audio bug, fixed) and branch `fix/followup-turn-audio`.

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
  **`voice_id`** (not `voice`), and **`model` is optional** — omitted, the server's default TTS
  model runs (we omit unless `mistral_tts_model` is set; a concrete pin would be
  `voxtral-mini-tts-2603`). The spec also exposes `GET /v1/audio/voices` (presets + customs) —
  candidate for a dynamic voice dropdown later. Voxtral TTS has 20 preset voices (+ OpenAI-name
  aliases) — the main Voice dropdown switches to them when the TTS backend is Mistral
  (`LocalPipelineProvider.getAvailableVoices(ttsBackend?)`, `/voices?provider=local&tts=…`).
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
