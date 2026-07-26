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
       stays part of the release-testing pass (item 10). 5 new harness tests; README.md
       settings + troubleshooting updated (README.txt doesn't enumerate per-device tuning —
       unchanged); app.json recomposed, `homey app validate` green at publish level.
9. [x] **README/store-listing polish:** ~~retake the stale settings screenshots~~ (done
       2026-07-26 — `.resources/settings.jpg` replaced by five section screenshots:
       `settings_general.png`, `settings_smart_home.png`, `settings_weather.png`,
       `settings_custom_pipeline.png`, `settings_logging.png`, reflecting the section-dropdown
       redesign). ~~add the plaintext-only/no-Noise limitation note~~ (superseded — Noise
       encryption shipped); ~~spot-check README.txt~~ (done 2026-07-26 — accurate, incl.
       locks/encryption).
10. [ ] **Release-testing checklist pass** ([`docs/release-testing-since-1.4.0.md`](./docs/release-testing-since-1.4.0.md)):
       tick off everything the 2026-07-19→23 live sessions already proved (pairing/BLE, Mistral,
       music, TR end-to-end, soak); then run what genuinely remains — upgrade path 1.4.0→1.4.1
       on the live Homey, flow-editor cards, settings webview on mobile. The custom-pipeline
       matrix is item 11 below.
11. [ ] **Custom-pipeline backend matrix — test EVERY implementation (STT, LLM, TTS).**
       Overlaps the checklist's "Custom pipeline" block but tracked here explicitly. First
       build **a repeatable way to test them**: a matrix-runner script (emulator side, no Homey
       needed) that exercises each backend client in isolation against the real endpoint —
       feed one known WAV to every STT backend and diff transcripts, one fixed prompt (incl. a
       tool call) to every LLM backend, one fixed sentence to every TTS backend and check
       audio comes back — then one full `ask`/`mic` voice turn per backend family via the
       emulator + settings Test buttons (`/test-local-stage`) for the UI path. Needed servers:
       Wyoming dockers (10300/10200), Whisper HTTP, Piper HTTP, Ollama, LM Studio, a Mistral
       key, one OpenAI-compat endpoint (Groq/speaches/kokoro cover STT/LLM/TTS cheaply).
       Implementations to tick off (each at least once, stage in isolation + one spoken turn):
       - STT: [ ] Whisper HTTP · [ ] Wyoming faster-whisper · [ ] Mistral Voxtral (batch) ·
         [x] Mistral Voxtral Realtime (streaming — live-verified 2026-07-19) · [ ] OpenAI-compat
       - LLM: [ ] Ollama (verify `local_llm_num_ctx` actually applied) · [x] LM Studio
         (live-verified 2026-07-19, model auto-pick OK) · [x] Mistral (live-verified
         2026-07-19, tool calls OK) · [ ] OpenAI-compat
       - TTS: [ ] Piper HTTP · [ ] Wyoming Piper · [x] Mistral Voxtral TTS (live-verified
         2026-07-19; still check: voice dropdown lists live voices, presets NOT offered) ·
         [ ] OpenAI-compat (free-text voice override)
       - Cross-cutting: [ ] streaming-STT batch fallback (kill the ws mid-utterance) ·
         [ ] kill a stage mid-turn (stop Ollama/Piper) — graceful error, next turn recovers ·
         [ ] `MIRRORED_INPUTS` key/model mirroring on the settings page
12. [ ] **L1 — split oversized classes / reduce `any` at trust boundaries.** Long-term, NOT a
       release gate — only touch opportunistically if items above already open those files.

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
