# TODO — single source of truth

## Next session — small-stuff punch list (written 2026-07-23)

**Goal: clear all the remaining small items before the store release.** Work top to bottom;
mark each `[x]` when done/verified, `[~]` when in progress. Code-review item context is in
[`docs/code_review_2.md`](./docs/code_review_2.md); fixed review items are archived in
[`COMPLETED.md` §7](./COMPLETED.md). **M2 (Noise encryption) is explicitly NOT in this list** —
owner decision 2026-07-23: don't implement it for this release; it moved to Feature ideas
below. Ship plaintext-only as a documented limitation (make sure README mentions it, item 9).

1. [ ] **H4 product decision — `allow_unlock_via_voice` setting?** Ask the owner at session
       start: the untrusted-content envelope + one-device unlock cap already shipped; the
       remaining option is a code-enforced gate on `locked=false` behind a default-off setting.
       Decide yes/no, implement or close.
2. [ ] **L3 — pairing probe polls every 10 ms and leaks the 5 s timeout**
       (`voice-assistant-driver.mts:212-231`). Resolve directly from `finish()`.
3. [ ] **L4 — dead `preStart` variable in `pcm-segmenter.mts:134`** — implement the documented
       pre-pad windowing or remove the dead code/comment.
4. [ ] **L5 — no teardown for process/SDK listeners** (`app.mts:81-102`, GeoHelper,
       DeviceManager). Mostly theoretical on Homey; add `dispose()` methods.
5. [ ] **M5 — stage-test API hardening:** add basic body type/port validation only; do NOT
       block loopback/LAN ranges — arbitrary LAN endpoints are the product's purpose.
6. [ ] **M6 — npm audit legacy chains** (`homey-api`/`homey-log`: socket.io-client 2.x, raven).
       Re-run `npm audit`, confirm still 0 critical/high, ask Athom for updated releases,
       then close as tracked-upstream.
7. [ ] **M7 — provider `start()` readiness semantics:** largely defused by the H1
       serialization. Decide: document + close, or centralize state in the provider seam.
8. [ ] **TR mic gain refinement:** expose `micGain` as a device setting (advanced) instead of
       the hardcoded TR constant 4; sanity-check that 4× gain doesn't clip/hurt STT for loud
       close speech. (Fix itself shipped + verified 2026-07-19 — context in the watch item
       below and COMPLETED.md.)
9. [ ] **README/store-listing polish:** retake the stale settings screenshots
       (`.resources/settings.jpg`, predate the settings redesign — needs the owner's Homey);
       add the plaintext-only/no-Noise limitation note (M2 deferral) to README.md; spot-check
       README.txt still matches.
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

- [ ] **Noise encryption for the ESPHome link (was code-review M2)** — support
      `Noise_NNpsk0_25519_ChaChaPoly_SHA256` plus a per-device encryption-key setting so
      satellites with an ESPHome API encryption key can connect (today the plaintext-only
      client fails entirely against them). Owner decision 2026-07-23: NOT for this release —
      ship as a documented limitation instead (README note, punch-list item 9). Background:
      CLAUDE.md "ESPHome firmware compatibility", COMPLETED.md §6, `docs/code_review_2.md` M2.

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

**Not tracked but worth remembering before a store release:** the README screenshots
(`.resources/settings.jpg`) predate the provider-choice settings redesign and are stale.
