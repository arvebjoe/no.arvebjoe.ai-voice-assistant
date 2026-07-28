# TODO — single source of truth

## Next session — small-stuff punch list (written 2026-07-23)

**Goal: clear all the remaining small items before the store release.** Work top to bottom;
mark each `[x]` when done/verified, `[~]` when in progress. Code-review item context is in
[`docs/code_review_2.md`](./docs/code_review_2.md); fixed review items are archived in
[`COMPLETED.md` §7](./COMPLETED.md). **M2 (Noise encryption) is DONE** — implemented and
fully live-verified 2026-07-24 on branch `feature/noise-encryption` (all pairing
permutations: PE/TR × scan/BT wizard/manual IP × encrypted/plain). Full context, gotchas
and the test-firmware note are archived in [`COMPLETED.md` §11](./COMPLETED.md).

1. [x] **H4 product decision — `allow_unlock_via_voice` setting?** DONE 2026-07-25 (owner said
       yes): default-off global setting gates `locked=false` in `set_device_capability`
       (`UNLOCK_DISABLED` until enabled; single-device cap still applies after). Toggle lives in
       the Smart home control settings card; READMEs updated; tests green. Details in
       [`COMPLETED.md` §7](./COMPLETED.md) (H4 entry).
2. [x] **L3 — pairing probe polls every 10 ms and leaks the 5 s timeout** DONE 2026-07-25:
       `checkVoiceCapabilities` restructured to the `probeManualEntry` pattern — `finish()`
       resolves the promise directly (no 10 ms poll loop), the timeout handle is cleared in
       `finish()`, and a `client.start()` throw now also runs cleanup (was a leak). Details in
       [`COMPLETED.md` §7](./COMPLETED.md).
3. [x] **L4 — dead `preStart` variable in `pcm-segmenter.mts:134`** DONE 2026-07-25: removed
       (not implemented) — plus the write-only `trailingBuffer` state and the `PRE_PAD_*`
       constants, all dead. Zero behavior change (segmenter tests unchanged and green).
       Rationale + details in [`COMPLETED.md` §7](./COMPLETED.md).
4. [x] **L5 — no teardown for process/SDK listeners** DONE 2026-07-25: `onUninit` now removes
       the three process listeners (stored via `addProcessListener`), unsubscribes the
       remote-log `onGlobals` subscription, and calls new `dispose()` methods on GeoHelper,
       DeviceManager (before ApiHelper — it unregisters through `apiHelper.devices`) and
       ApiHelper (`api.destroy()`). Covered by 3 new tests. Details in
       [`COMPLETED.md` §7](./COMPLETED.md).
5. [x] **M5 — stage-test API hardening** DONE 2026-07-25: `validateStageTestRequest()` in
       stage-tester.mts — body shape, string-field types + 2048-char cap, port 1-65535,
       http(s)-only URLs without embedded credentials. Deliberately NO loopback/LAN blocking
       (the endpoint's purpose). 5 new tests. Details in [`COMPLETED.md` §7](./COMPLETED.md).
6. [x] **M6 — npm audit legacy chains** DONE 2026-07-26: re-ran `npm audit --omit=dev` —
       0 critical/high (2 low, 7 moderate). Fixed the one actionable finding: protobufjs
       7.5.x DoS advisory (GHSA-j3f2-48v5-ccww) → 7.6.5 via `npm audit fix` (semver-safe;
       esp-messages + noise-codec tests green). The rest are the known upstream chains —
       `homey-log`→raven (cookie/uuid, no fix) and `homey-api`→socket.io-client 2.x
       (parseuri; npm's "fix" is a homey-api DOWNGRADE — do not apply). Closed as
       tracked-upstream; optionally nudge Athom for updated releases.
7. [x] **M7 — provider `start()` readiness semantics** DONE 2026-07-26 (decision: document +
       close). The de facto contract was already consistent across all four providers —
       `start()` = "attempt initiated", never rejects on connect failure, provider-owned
       reconnect campaign, readiness via `open`/`Healthy`/`isConnected()` — and the
       fire-and-forgotten call sites were fixed under H1. Contract now documented on
       `IVoiceProvider.start()/close()/restart()` in `src/llm/voice-provider.mts`.
       Centralizing lifecycle state = deliberate non-goal (goes with L1 if ever). Details in
       [`COMPLETED.md` §7](./COMPLETED.md).
8. [x] **TR mic gain refinement** DONE 2026-07-26: new `mic_gain` device setting (PE + TR
       drivers' `driver.settings.compose.json`; number 0–20, default **0 = automatic** = the
       driver's built-in default, so the code constant stays authoritative and existing
       devices keep exact current behavior). `micGain` is now a mutable field resolved via
       `resolveMicGain()` (0/unset/invalid → `defaultMicGain` — the renamed subclass override,
       TR = 4; positive values clamped 1–20); applies live in `onSettings`, no reconnect. Gain
       loop now `Math.round`s (fractional gains would make `writeInt16LE` throw). Clip
       sanity-check (analytical): TR close speech ~330–430 int16 RMS → ×4 stays well under
       32767 even at peak; the clamp catches extremes, and the setting itself is now the
       mitigation if a loud talker ever distorts (turn it down). Live confirmation on the TR
       stays part of the release-testing items (10–29, fits naturally under item 14). 5 new harness tests; README.md
       settings + troubleshooting updated (README.txt doesn't enumerate per-device tuning —
       unchanged); app.json recomposed, `homey app validate` green at publish level.
9. [x] **README/store-listing polish:** ~~retake the stale settings screenshots~~ (done
       2026-07-26 — `.resources/settings.jpg` replaced by seven section screenshots:
       `settings_general.png`, `settings_smart_home.png`, `settings_weather.png`,
       `settings_web_search.png`, `settings_music.png`, `settings_custom_pipeline.png`,
       `settings_logging.png`, reflecting the section-dropdown redesign). ~~add the plaintext-only/no-Noise limitation note~~ (superseded — Noise
       encryption shipped); ~~spot-check README.txt~~ (done 2026-07-26 — accurate, incl.
       locks/encryption).
10. [ ] Wake-word model (0.98 cutoff): reliability at distance / with TV on, false-accept
         rate (the PE runs the `.esp_home` firmware daily since ~07-19)
11. [ ] Mic auto_gain 6 dBFS: transcription accuracy vs distortion on real hardware
12. [x] LED voice-phase rainbows: distinct listening/thinking/replying, seamless position
         handoff, dark-level looks right
13. [ ] Timer round-trip on the satellite: chime + LED ring countdown (voice or
         `then start-timer`)
14. [ ] Smart-home control regression: on/off, dim, zone targeting against real devices
         (tool-manager grew ~900 lines) — include the H4 lock path live: voice-lock works,
         unlock blocked until `allow_unlock_via_voice` is on, then single-device-only
         (gate shipped 2026-07-25, tests green, never live-verified)
15. [x] Settings page in the real mobile-app webview: rendering, section dropdown, sticky
         footer, budget-meter tap breakdown, stage Test buttons (the 07-19 pass verified all
         of this through Homey's API routing — confirm whether that was the mobile app; if
         yes just tick)
16. [ ] Spurious-retry window fix (2026-07-25, clock now mic-open→mic-close) — the one
         conversation-flow piece NEVER live-verified (one live conversation session covers
         items 16 + 17 together)
17. [ ] Audio-skip defaults: wake sound not transcribed (`initial_audio_skip` now 0) and
         follow-up turns don't lose the first word (new `followup_audio_skip`)
18. [x] Bring! with real credentials: add / remove / read items; SSO-account gotcha message
         (items 18–21: console `ask` is fine, no satellite needed)
19. [ ] Web search: each provider value works; `disabled` removes the tool (agent says it
         can't search)
20. [ ] Gemini live provider switch — the only provider never exercised (openai ↔ local ↔
         mistral rebuild-on-save verified 2026-07-19)
21. [x] Feature-gate flips besides weather (verified both ways 2026-07-19): web search,
         timers, Bring!, Music Assistant on/off → provider restarts, tool list changes
22. [x] Budget-meter verdict (green/amber/red) vs `local_llm_num_ctx` — needs Ollama,
         overlaps item 36
23. [ ] Flow-card run-listeners from the console: `then speak-text`,
         `then ask-agent-output-as-text` (tokens printed), `and is-muted`, timer cards
         (TR `button-pressed` already verified in a real flow 2026-07-19)
24. [ ] Emulator `discover` finds and correctly types PE vs Nabu Casa vs TR
25. [x] **Upgrade path**: install this build over a real 1.4.0 — devices survive without
         re-pairing, new settings keys get sane defaults (especially what
         `initial_audio_skip` ends up as on *existing* devices after the 350→0 default
         change), provider still connects
26. [ ] XiaoZhi pairing through Homey's real pairing UI (only untested device type)
27. [ ] Device tile: active timer name + time remaining shown; volume/mute changes from
         the Homey UI reach the satellite
28. [x] Audio-file TTL cleanup on the Homey (serving/playback already verified implicitly)
29. [ ] Internet drop mid-session (cloud providers) recovers (satellite power-cycle side
         already verified 2026-07-19)
30. [ ] **Build the custom-pipeline matrix-runner** — the repeatable way to test every
         backend implementation (items 31–46). A script (emulator side, no Homey needed)
         that exercises each backend client in isolation against the real endpoint: feed
         one known WAV to every STT backend and diff transcripts, one fixed prompt (incl.
         a tool call) to every LLM backend, one fixed sentence to every TTS backend and
         check audio comes back. Then each backend also gets one full `ask`/`mic` voice
         turn per family via the emulator + settings Test buttons (`/test-local-stage`)
         for the UI path. Needed servers: Wyoming dockers (10300/10200), Whisper HTTP,
         Piper HTTP, Ollama, LM Studio, a Mistral key, one OpenAI-compat endpoint
         (Groq/speaches/kokoro cover STT/LLM/TTS cheaply). Each backend counts as done
         after stage-in-isolation + one spoken turn.
31. [ ] STT: Whisper HTTP
32. [ ] STT: Wyoming faster-whisper (port 10300 docker)
33. [ ] STT: Mistral Voxtral (batch)
34. [x] STT: Mistral Voxtral Realtime (streaming) — live-verified 2026-07-19
35. [ ] STT: OpenAI-compat
36. [ ] LLM: Ollama — also verify `local_llm_num_ctx` is actually applied (closes the
         budget-meter half of item 22)
37. [x] LLM: LM Studio — live-verified 2026-07-19, model auto-pick from `/v1/models` OK
38. [x] LLM: Mistral — live-verified 2026-07-19, tool calls OK (9-char tool_call_id)
39. [ ] LLM: OpenAI-compat
40. [ ] TTS: Piper HTTP
41. [ ] TTS: Wyoming Piper (port 10200 docker)
42. [x] TTS: Mistral Voxtral TTS — live-verified 2026-07-19 (residual settings-page check
         folded into item 46)
43. [ ] TTS: OpenAI-compat (free-text voice override)
44. [ ] Cross-cutting: streaming-STT batch fallback — kill the websocket mid-utterance,
         batch path takes over
45. [ ] Cross-cutting: kill a stage mid-turn (stop Ollama/Piper) — graceful error, next
         turn recovers
46. [ ] Cross-cutting: settings page — `MIRRORED_INPUTS` key/model mirroring works, and
         the Voxtral voice dropdown lists live voices fetched with the Mistral key
         (preset names must NOT be offered)
47. [ ] **L1 — split oversized classes / reduce `any` at trust boundaries.** Long-term, NOT a
       release gate — only touch opportunistically if items above already open those files.

## ReSpeaker XVF3800 driver — needs hardware verification

Driver written 2026-07-28 from the community ESPHome config alone (**no hardware was
available**), so everything below is a documented best guess. Research and the reasoning behind
each choice: [`docs/respeaker-xvf3800/README.md`](./docs/respeaker-xvf3800/README.md).

- [ ] **Pair a real device end to end** — mDNS scan, manual IP, and the encrypted (Noise) path.
      Confirm it lists as *"reSpeaker XVF3800 Assistant"* (that name is derived from the YAML,
      not observed).
- [ ] **Confirm the identity sniff fires.** We match on `respeaker` / `xvf3800` in
      HelloResponse/DeviceInfoResponse. If Seeed's own wiki YAML (unreachable during research)
      names the device without either token, widen the match.
- [ ] **Check `voice_assistant_feature_flags`** — VOICE_ASSISTANT | API_AUDIO | TIMERS |
      ANNOUNCE are certain from the config; START_CONVERSATION is assumed, not verified.
- [ ] **Verify mic levels with `mic_gain` at 0 (1×).** The XMOS chip does AGC/AEC/beamforming
      on-chip and the config zeroes the software stages, so it should behave like the PE rather
      than the TR — but if speech is missed, this is the first knob.
- [ ] **Tune `initial_audio_skip` / `followup_audio_skip`** against the wake-word ding; both
      default to 0 and were never measured on this hardware.
- [ ] **Confirm the mute switch is `microphone_mute`.** `scoreMuteCandidate()` picks it and
      deliberately ignores the device's decoy `mute_sound` switch; check `volume_mute` actually
      mutes the mic.
- [ ] **Replace the stand-in artwork.** `drivers/respeaker-xvf3800/assets/` holds a stylised
      top-view rendering of the board (drawn, not photographed — deliberately not a reused photo
      of another device). Swap in real product images before the store release.

## Deferred with a deadline

- [ ] **Re-attempt the gpt-realtime-2.1 migration (deadline: before Jan 20, 2027).** The
  2.1 move (commit `1af0f56`) was reverted 2026-07-25: `gpt-realtime-2.1` has an open
  language-drift bug — it speaks non-English languages with a heavy English accent or
  drifts into English entirely, and prompting doesn't reliably fix it
  (<https://community.openai.com/t/gpt-realtime-2-1-exhibits-language-drift/1386953>).
  Symptom on the PE: Norwegian replies sounded "like a non-Norwegian trying to speak
  Norwegian". We're pinned to `gpt-realtime-2025-08-28` / `gpt-realtime-mini`, which
  OpenAI shuts off **Jan 20, 2027**. Before re-migrating (to 2.1 or newer): check the
  thread/changelog for a fix, then verify with a few Norwegian turns on the real PE.

## Watch items (no action unless they recur)

- **Settings webview one-off (2026-07-19, unreproduced):** one webview session where Save
  silently persisted nothing (no error shown; reopening showed old values; later sessions
  saved fine). Suspected dead webview bridge. Watch for recurrence before blaming our page.
- **TR playback choppiness — resolved itself with the keepalive fix (2026-07-20 soak clean):**
  during the flaky-link period each per-sentence FLAC's last ~200–300 ms was audibly cut on
  the TR. Plausibly the watchdog's connect/destroy churn disturbed announce sequencing. If it
  recurs on a stable link: candidate fixes are tail-padding segments with ~300 ms silence
  (device flag like `micGain`) or finding an early-stop in the TR's mpv announce path.

---

## Feature ideas — 2026-07-10 brainstorm (owner-approved, not yet started)

Ordered roughly by wow-per-effort. None are started; pick one and spec it before coding.
Explicitly avoids the items dropped in the 2026-07-07 triage (flows-by-voice, multi-timers,
image analysis — see [`COMPLETED.md` §6](./COMPLETED.md)).

### Easy wins (fit the existing architecture almost directly)

- [ ] **Room-to-room intercom / broadcast** — *"tell the kids dinner is ready"*, *"announce
      upstairs that we're leaving in 5 minutes"*. `DeviceManager` already tracks every voice
      satellite and the announce/TTS path exists (the *Say* flow card); a
      `broadcast_message(room?, message)` tool is a thin layer over both. Turns the satellites
      into a whole-house intercom.
- [ ] **Household memory** — *"remember that the spare key is in the blue cabinet"* →
      `remember`/`recall`/`forget` tools persisted in app settings, stored facts injected into
      the system prompt. Makes the assistant feel personal rather than generic.
- [ ] **Moods** — Homey has native Moods and there is no mood tool today. `list_moods` +
      `set_mood` via `ApiHelper`, same pattern as the zone/device tools. Covers the "scenes"
      ask without touching the dropped start-flows-by-voice idea.
- [ ] **Presence** — *"is anyone home?"*, *"is Anna home yet?"*. Read-only tool over Homey's
      user/presence API.

### High value, more work

- [ ] **Device-less "Ask AI (text answer)" flow card — target 1.5.0** (forum request 2026-07-25,
      owner-approved). An APP-level action card (no device picker) so flows can use the AI with
      zero voice hardware: *"summarize my open windows and send a notification"*, yes/no
      questions, text generation. Design sketch (agreed 2026-07-25): new
      `.homeycompose/flow/actions/` card registered in `app.mts`; a **headless provider**
      through the existing `IVoiceProvider` seam/factory in text↔text mode (works with all four
      engines + configured key automatically), created lazily on first use and torn down after
      idle (don't hold an OpenAI realtime websocket open forever; local/Mistral LLMs are
      stateless HTTP); a **headless ToolManager** with the device-bound tools removed — no
      timers (`esp.supportsTimers` needs a satellite), no interim-speak, zone context "whole
      home" — everything else (DeviceManager control, weather, geo/time, web search, shopping,
      music) is already an app singleton. Serialize concurrent flow invocations like the
      device's textRequestQueue (H2 lesson); single-shot per invocation, no conversation
      carryover between flow runs. Explicitly SKIPPED from the same request: device-less timer
      cards — the satellite rendering (LED ring + chime) is the point of app timers, Homey's
      native delays/timer apps cover the device-less case, and a headless timer tool would grow
      every turn's prompt (cost-of-growth rule 1). Remember READMEs + feature-costs when built.
- [ ] **Reminders (the missing sibling of timers)** — *"remind me tomorrow at 8 to take out the
      recycling"*. Unlike timers these need persistence (app settings) and delivery: spoken
      announcement on the satellite that set it, plus a Homey timeline/push notification as
      backup if nobody's listening. The most-used feature on Alexa/Google that we lack.
- [ ] **Energy & history questions via Homey Insights** — *"how much power are we using right
      now?"*, *"how much energy did the heat pump use yesterday?"*. Read-only tool over the
      Insights API; gives the assistant the time dimension it completely lacks today.
- [ ] **Electricity spot prices (Nord Pool)** — *"when is power cheapest today?"*, *"should I
      run the dishwasher now or tonight?"*. Public API (e.g. hvakosterstrommen.no) → small HTTP
      helper + one tool. Pairs with the Insights tool for genuinely smart answers.
- [ ] **Calendar (read-only iCal/CalDAV URL)** — *"what's on today?"*. Opt-in like Bring!:
      paste an iCal URL in settings, one `get_calendar_events` tool. Also feeds the briefing
      card below.
- [ ] **"Morning briefing" flow card** — one flow-card action ("Play briefing on device") where
      the LLM composes weather + today's calendar + spot-price note + shopping list into one
      short spoken update. Pure composition of existing tools (plus calendar/spot prices).

### Stretch / just-plain-cool

- [ ] **Follow-me music** — we already control Music Assistant and know each satellite's zone;
      with per-zone motion/presence, *"follow me"* transfers the MA queue between Sendspin
      players as you move. Prototype behind an opt-in setting.
- [ ] **"Hey Homey" wake word on the TR** — researched 2026-07-28, full plan in
      [`docs/thirdreality-voice-and-music/custom-firmware.md`](./docs/thirdreality-voice-and-music/custom-firmware.md).
      **No custom firmware needed**: the TR implements HA's external-wake-word mechanism, so we can
      host a microWakeWord `hey_homey.tflite`/`.json` on our own `WebServer` and push it in
      `VoiceAssistantConfigurationRequest` (needs one added proto field — our vendored `api.proto`
      predates it). `applyWakeWord()` then activates it unchanged. Blocking unknown: getting a
      model that behaves (train via OHF-Voice/micro-wake-word or microwakeword.com).
      Sub-item worth doing on its own: **re-apply the configured wake word on connect** — the TR
      firmware never persists `active_wake_words`, so it reverts to `okay_nabu` on every reboot.
- [ ] **TR LED control** — same doc. The LED is a single RGB LED (`/sys/class/leds/RGB_*`) driven by
      the `tr-ledring` daemon via a D-Bus signal, and is **not exposed on the ESPHome native API**,
      so LAN control does require a firmware patch (add a Light or Select entity to
      `linux-voice-assistant-cpp`; `api.proto` already carries the Light messages, only client
      dispatch is missing). Decide ownership first — the satellite overwrites the LED on every
      pipeline state change.

### Deferred technical work

*(empty — the last item here, Noise encryption / code-review M2, was implemented and fully
live-verified 2026-07-24 and is archived with full context in
[`COMPLETED.md` §11](./COMPLETED.md).)*

**Suggested first picks:** intercom/broadcast, memory, and reminders — they change how the
product feels day-to-day. Moods and presence are cheap enough to bundle into any of them.

Remember: each shipped feature must update `README.md` + `README.txt` (and usually the agent
instructions/`get_assistant_capabilities`) before commit.

---

The 2026-07-07 session cleared this list: every item was either implemented (archived with full
context in [`COMPLETED.md`](./COMPLETED.md)) or explicitly dropped by the owner (dropped items and
their rationale are in [`COMPLETED.md` §6](./COMPLETED.md) in case any come back).

Add new work here as it comes up. Reference docs that used to feed this list:
- [`OPENAI_API_IMPROVEMENTS.md`](./OPENAI_API_IMPROVEMENTS.md) — OpenAI Realtime API audit (all items resolved)
- [`docs/home-assistant-voice-preview-edition/implementation-gap-analysis.md`](./docs/home-assistant-voice-preview-edition/implementation-gap-analysis.md) — ESPHome native-API coverage vs. the PE docs

**Not tracked but worth remembering before a store release:** ~~the README screenshots
predate the provider-choice settings redesign and are stale~~ (done 2026-07-26 — replaced with
five current section screenshots under `.resources/settings_*.png`).
