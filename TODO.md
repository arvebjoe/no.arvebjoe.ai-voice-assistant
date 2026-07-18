# TODO — single source of truth

## Release testing — everything shipped since v1.4.0

- [ ] Work through [`docs/release-testing-since-1.4.0.md`](./docs/release-testing-since-1.4.0.md)
      before the next store release: List A is emulator-testable (real satellite on the
      LAN, no Homey), List B needs the app running on the Homey Pro (pairing UI, flow
      editor, settings webview, upgrade path, homey-log/Sentry, Homey-hosted audio).
- [ ] **Live-verify the first-class Mistral provider (2026-07-12, needs a real Mistral key
      + satellite):** `voice_provider: 'mistral-realtime'` — full spoken turn (streaming
      Voxtral Realtime STT fed during speech via the new `ISttClient.createStream` seam,
      chat with tool calls, Voxtral TTS reply), the batch fallback when the websocket drops
      mid-utterance, the mirrored key/model inputs in the General settings section
      (`MIRRORED_INPUTS` — must stay in sync with the Custom pipeline's fields), and the
      Voxtral voice dropdown after saving the key. Unit tests cover all of it with fakes;
      nothing has run against the live endpoints yet.

## Code review 2 — remaining items (see [`docs/code_review_2.md`](./docs/code_review_2.md))

External review of `main` @ `0a64afa` (ChatGPT 5.6 Sol). **Fixed 2026-07-12 with regression
tests: H1+L2, H2, H3, H4 (untrusted-data mitigation), M1, M3, M4** — full context in
[`COMPLETED.md` §7](./COMPLETED.md). Still open:

- [ ] **M2 — ESPHome transport is plaintext (no Noise encryption).** Known, deliberate deferral
      (CLAUDE.md / COMPLETED.md §6). Treat as a **store-release criterion**: satellites with an
      API encryption key set cannot connect at all today.
- [ ] **H4 follow-up (product question):** an `allow_unlock_via_voice` setting (default off)?
      The untrusted-content envelope + one-device unlock cap shipped; a code-enforced gate on
      `locked=false` is the remaining option if the owner wants it.
- [ ] **M5 — stage-test API as SSRF primitive.** Low urgency (behind Homey's authenticated
      settings API; arbitrary LAN endpoints are the product's purpose). Only add basic body
      type/port validation; do NOT block loopback/LAN ranges — that breaks legitimate setups.
- [ ] **M6 — npm audit: legacy chains in `homey-api`/`homey-log`** (socket.io-client 2.x,
      raven). Not fixable in this repo; ask Athom for updated releases. 0 critical/high.
- [ ] **M7 — inconsistent provider `start()` readiness semantics.** Largely defused by the H1
      serialization; revisit if lifecycle races reappear (centralize state in the provider seam).
- [ ] **L1 — split oversized classes / reduce `any` at trust boundaries.** Long-term
      refactoring; do opportunistically.
- [ ] **L3 — pairing probe polls every 10 ms and leaks the 5 s timeout**
      (`voice-assistant-driver.mts:212-231`). Resolve directly from `finish()`.
- [ ] **L4 — dead `preStart` variable in `pcm-segmenter.mts:134`** — implement the documented
      pre-pad windowing or remove the dead code/comment.
- [ ] **L5 — no teardown for process/SDK listeners** (`app.mts:81-102`, GeoHelper,
      DeviceManager). Mostly theoretical on Homey; add `dispose()` methods when touching those
      files anyway.

---

## Music via Music Assistant (PE + TR) — implemented 2026-07-09, live verification pending

The control-plane integration is implemented and unit-tested (full context archived in
[`COMPLETED.md` §3](./COMPLETED.md)); the music audio itself never touches this app — Music
Assistant ≥ 2.7 streams to the PE and TR directly over Sendspin.

**Remaining: verify against a real MA server + speakers** (needs the owner's network):

- [ ] MA discovers the PE (stock 26.x firmware) and TR as Sendspin players; check what the
      players' `device_info.ip_address` / names look like so the satellite→player auto-matching
      in `resolveMusicPlayer` (IP first, then device name, then zone name) actually hits.
- [ ] End-to-end voice flow on both devices: "play <album> by <artist>", pause/resume/next/
      previous, shuffle, "what's playing?", explicit room targeting ("…in the kitchen").
- [ ] Announcement ducking while Sendspin music plays (PE has a separate announcement pipeline;
      TR docs claim ducking works out of the box) — and that music resumes after the reply.
- [ ] Wake word while music is playing (PE has XMOS AEC; TR uses WebRTC/PulseAudio AEC).
- [ ] `resume` behavior on a long-stopped queue (the tool maps resume→`play` when paused,
      `resume` otherwise — check the idle case restarts where it left off).
- [ ] Partial-result accumulation against a big real library (implemented per the API models;
      only exercised with a fake server so far).

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
