# Release testing checklist — changes since v1.4.0

Everything on `main` since the v1.4.0 release commit (`7c37f17`, 118 commits) that needs
verification on physical hardware, split by **where** it can be tested:

- **List A** — testable from the emulator (`npm run emulator`), no Homey Pro needed.
  A real satellite (PE / ThirdReality / XiaoZhi) on the LAN is still required for the
  voice items; the emulator drives it directly.
- **List B** — must run on the Homey Pro (`homey app run --remote` or install), because
  it exercises Homey's own stack: pairing UI, flow editor, settings webview, device
  tiles, homey-log/Sentry, ApiHelper against real devices, or Homey-hosted audio.

What shipped since 1.4.0, grouped: **custom local pipeline** (pluggable STT/LLM/TTS:
Whisper, Wyoming, Voxtral, OpenAI-compat / Ollama, LM Studio, Mistral / Piper, Wyoming,
Voxtral TTS, OpenAI-compat + local VAD + stage tester), **Music Assistant** control
plane (PE + TR), **Bring! shopping list**, **ThirdReality driver** (new device type,
button-pressed trigger), **web search tool**, **settings redesign** (section dropdown,
token-budget meter, `/feature-costs`, `/test-local-stage`), **conversation-flow
hardening** (turn state machine, follow-up turns, gpt-4o-transcribe, audio-skip
defaults changed 350→0 + new `followup_audio_skip`), **wake-word selection device
setting**, **PE firmware** (new Hey Homey model @ 0.98 cutoff, mic auto_gain 6 dBFS,
voice-phase rainbow LEDs), **discovery fixes** (`esp32|ESP32` regex, HA Voice vs Nabu
Casa detection), **code-review-2 fixes**, **Sentry throttling**, **reconnect policy**.

---

## List A — test with the emulator

### Custom pipeline (biggest new feature)

- [ ] Each pipeline stage against the real LAN services you run, via the settings web
      UI Test buttons (`/test-local-stage`) and `ask` / `mic`:
  - [ ] STT: Wyoming faster-whisper (port 10300 docker), Whisper HTTP, Mistral
        Voxtral, OpenAI-compat.
  - [ ] LLM: Ollama (check `local_llm_num_ctx` actually applied), LM Studio
        (model auto-pick from `/v1/models`), Mistral (9-char tool_call_id),
        OpenAI-compat. _LM Studio + Mistral verified live 2026-07-19 (on the Homey,
        full spoken turns with tool calls; LM Studio auto-pick chose from a list that
        included an embedding model and picked a chat model). Ollama + OpenAI-compat
        still untested._
  - [ ] TTS: Wyoming Piper (port 10200 docker), Piper HTTP, Voxtral TTS (live voice
        list fetched with the Mistral key; preset names must NOT be offered),
        OpenAI-compat free-text voice.
- [ ] Local VAD turn-taking with `mic <recording>` replays — deterministic; check the
      turn closes on trailing silence and doesn't clip speech.
- [ ] Sentence-by-sentence speaking while the LLM streams (latency feel on a real
      satellite speaker).
- [ ] Kill a stage mid-turn (stop Ollama/Piper) — graceful error, next turn recovers.

### Voice behavior with a real satellite (emulator-driven, no Homey)

- [ ] **New wake-word model** (0.98 cutoff): wake reliability at distance / with TV on,
      and false-accept rate. Firmware must be reflashed first (`.esp_home/`).
- [ ] **Mic auto_gain 6 dBFS**: transcription accuracy vs distortion (this flip-flopped
      during development — verify the final value on real hardware).
- [ ] **Audio-skip defaults changed**: `initial_audio_skip` default went 350 → 0 and
      `followup_audio_skip` is new — confirm the wake-word sound is not transcribed and
      follow-up turns don't lose the first word.
- [ ] **Conversation-flow hardening**: multi-turn follow-ups, spurious follow-up turns,
      asking time/date, interrupting; transcripts now come from gpt-4o-transcribe with
      text-anchored replies — check replies match what was actually said.
      _Partially verified 2026-07-19 on the custom pipeline (real PE + Homey Pro):
      question-ending reply → mic reopened → follow-up turn with context → closing
      reply in-band, conversation closed; sentence-by-sentence speaking while the LLM
      streamed also confirmed. The OpenAI-specific parts (gpt-4o-transcribe
      text-anchored replies, spurious-follow-up suppression) still need a pass._
- [ ] **LED voice-phase rainbows** (PE firmware): distinct listening/thinking/replying
      phases, seamless position handoff, dark-level looks right.
- [ ] Timer round-trip on the satellite: chime + LED ring countdown (`then start-timer`
      from the console, or by voice).

### Tools & features (console `ask`, dummy devices are fine)

- [ ] Smart-home tool calls against dummy devices (on/off, dim, zone targeting) — the
      tool-manager grew ~900 lines, regression-check the basics.
- [ ] **Bring! shopping list** with real credentials: add / remove / read items; verify
      the SSO-account gotcha message if applicable.
- [ ] **Web search**: each provider value works; setting it to `disabled` removes the
      tool (agent should say it can't search).
- [ ] **Music Assistant control plane** against the real MA server (≥ 2.7) — the TODO.md
      checklist: MA discovers PE + TR as Sendspin players, `resolveMusicPlayer`
      auto-matching (IP → device name → zone), play/pause/next/shuffle/"what's
      playing"/room targeting, resume on a long-idle queue, partial-result accumulation
      against the full real library.
- [ ] Wake word while music plays (PE XMOS AEC / TR WebRTC AEC) and announcement
      ducking + music resume after the reply.

### Providers, settings & gates

- [ ] Live provider switching: openai-realtime ↔ gemini-realtime ↔ local; save in the
      settings web UI and confirm the agent rebuilds without restart.
      _Partially verified 2026-07-19 (on the Homey Pro, not the emulator): openai-realtime
      → local → mistral-realtime all rebuilt live on save, no restart; language change
      (en→no) applied on the very next turn. Gemini not yet exercised._
- [ ] Feature-gate flips restart the provider and change the tool list: weather,
      web search, timers, Bring!, Music Assistant on/off.
      _Weather verified both directions 2026-07-19 (live on the Homey, LM Studio
      pipeline): gate off → tool absent, agent says it can't; gate on → provider
      rebuilt, `get_weather_summary` called again. Other gates not yet flipped._
- [ ] Token-budget meter / `GET /feature-costs`: per-feature breakdown, AI-instructions
      contribution, green/amber/red verdict vs `local_llm_num_ctx` (Ollama only).
- [ ] Settings save hardening (code review H1/L2): rapid repeated saves — no torn
      state, last save wins.
- [ ] Reconnect policy: drop the internet mid-session (cloud providers) and power-cycle
      the satellite (ESP client health-check/reconnect) — both recover.
      _Satellite power-cycle verified 2026-07-19 on the Homey Pro: TCP `read ETIMEDOUT` →
      turn aborted cleanly → reconnect campaign → wake events flowing again after boot;
      a wake while the agent was down played the error sound (C1 path) instead of dying.
      Also observed: a transient OpenAI websocket drop self-healed in ~19 s mid-session.
      Internet-drop-mid-session case still untested._
- [ ] Flow-card run-listeners from the console: `then speak-text`, `then
      ask-agent-output-as-text` (tokens printed), `and is-muted`, timer cards; physical
      TR button press logs the `button-pressed` WHEN card.
- [ ] Emulator `discover` finds and correctly types PE vs Nabu Casa vs TR satellites
      (device-type detection changed).

---

## List B — must test on the Homey Pro

### Pairing & drivers

- [ ] **Pair all three device types through Homey's real pairing UI**: PE ✓ and TR ✓
      (verified live 2026-07-18/19, incl. the full BLE Wi-Fi wizard — see
      `COMPLETED.md` §8; the `txt.platform` regex needed broadening to
      `esp32|ESP32|ThirdReality|thirdreality`, the TR advertises `platform=ThirdReality`).
      **XiaoZhi still untested.**
- [x] ThirdReality appears in the add-device list with the new icon/images and pairs to
      the correct driver (not swallowed by the PE driver). _Verified 2026-07-18 after the
      discovery-condition fix._
- [x] Re-pairing of an existing device still works. _Verified 2026-07-19: PE removed +
      re-added through the real pairing UI, reconnected and handled voice turns
      immediately (which also exercised Homey-hosted FLAC audio). "Try to repair" is
      N/A — our drivers define no repair flow (that maintenance action is built-in for
      Z-Wave/Zigbee only), and there are no per-device credentials to repair._
- [ ] M2 store-release criterion: a satellite **with API encryption enabled** fails
      pairing *gracefully* (clear failure, no crash) — the client is plaintext-only.

### Upgrade path

- [ ] Install this build **over a real 1.4.0 install**: devices survive without
      re-pairing, all new settings keys get sane defaults (especially
      `initial_audio_skip` 350→0 on *existing* devices — check what value upgraded
      devices actually end up with), provider still connects.

### Homey UI surfaces

- [ ] **Settings app page in the real webview** (mobile app + web): the redesigned page
      renders correctly, section dropdown, sticky footer, budget-meter tap breakdown,
      and the pipeline Test buttons work through Homey's real API routing (new routes
      `/test-local-stage` and `/feature-costs` must be in the composed `app.json`).
      _Verified 2026-07-19: rendering/section dropdown/sticky footer good; saves persist
      (incl. all pipeline-stage keys — one unreproduced no-save session, see TODO.md);
      `/voices`, budget-meter tap breakdown (`/feature-costs`) and the stage Test buttons
      (`/test-local-stage`) all work through Homey's real API routing._
- [x] **Device settings on Homey**: `available_wake_words` label populates when the
      device connects; typing a name/id in `wake_word` actually switches the wake word
      on the device; the new `followup_audio_skip` field saves and applies.
      _Verified 2026-07-19 on the PE: all three work; an unknown wake word is rejected
      with the available list in the error; blank or `hey_homey` both resolve to
      `hey_homey`. The label format was simplified during the session to
      `hey_homey [ACTIVE], okay_nabu, …` (ids only, comma-separated — the old
      newline-separated friendly-name format rendered as an unreadable run-on in the
      real settings UI; unit test updated)._
- [x] **Flow editor**: all action/condition cards now list the TR device (device
      filters were extended), `button-pressed` trigger appears for TR with the `event`
      token and fires in a real flow on a physical press.
      _Verified 2026-07-19: TR present in WHEN/AND/THEN card device pickers; a real flow
      fired on physical presses with correct `event` tokens (`single_press`/
      `double_press`/`triple_press` — TR firmware has no long-press; it emits two
      singles)._
- [ ] Device tile: active timer name + time remaining shown; volume/mute capability
      changes from the Homey UI reach the satellite.

### Homey runtime specifics

- [ ] **Real device control via ApiHelper**: voice commands against your actual Homey
      devices and zones (DeviceManager changed substantially) — including the H4
      lock-device cap: voice can lock but the one-device unlock cap behaves as designed.
- [ ] **Audio served from the Homey itself**: WebServer picks the right LAN interface,
      satellites fetch and play the FLAC URLs, files are cleaned up after the TTL
      (emulator serves audio through a different port-80 shim, so this path is
      Homey-only). _Serving/playback verified implicitly 2026-07-19 — every spoken reply
      (OpenAI + Mistral + custom pipeline) played from Homey-hosted URLs on the PE.
      TTL file cleanup still unchecked._
- [ ] **Performance & stability on Homey Pro hardware**: local-pipeline resampling +
      FLAC encoding CPU/latency, multi-day run without memory growth, recovery after a
      Homey network blip (reconnect policy under real conditions).
- [x] **Sentry / homey-log throttling** (homey-log is shimmed in the emulator): a
      repeated error reports once and is then throttled; genuine new errors still
      arrive. _Verified 2026-07-19 on the Homey Pro: repeated pipeline health-check
      exceptions produced "Prevented sending a duplicate log" while distinct new errors
      (ESP TCP drop, websocket drop) were still captured. (Dev run, so captures were
      local-only — no `HOMEY_LOG_URL` — but the throttle logic itself fired.)_
- [ ] Final Music Assistant pass with the app running **on the Homey** (production
      timing differs from a dev machine): one end-to-end "play X in the kitchen" +
      ducking check per device type.

---

**Before the store release, also remember** (from TODO.md): README screenshots
(`.resources/settings.jpg`) predate the settings redesign, and `README.md` /
`README.txt` must reflect everything above.
