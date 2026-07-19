# TODO — single source of truth

## Release testing — everything shipped since v1.4.0

- [ ] Work through [`docs/release-testing-since-1.4.0.md`](./docs/release-testing-since-1.4.0.md)
      before the next store release: List A is emulator-testable (real satellite on the
      LAN, no Homey), List B needs the app running on the Homey Pro (pairing UI, flow
      editor, settings webview, upgrade path, homey-log/Sentry, Homey-hosted audio).
- [x] **Live-verify the first-class Mistral provider — CORE VERIFIED 2026-07-19 on the
      Homey Pro + PE:** full spoken turns on BOTH `voice_provider: 'mistral-realtime'`
      and the Custom pipeline with all-Mistral stages (streaming Voxtral Realtime STT —
      transcript ready ~200 ms after mic close, so the `createStream` live-feed works;
      chat with real tool calls `get_local_time`/`get_current_weather`; Voxtral TTS reply;
      mic-close→speaking ≈ 2.7 s). Still unverified: the batch fallback when the STT
      websocket drops mid-utterance (hard to provoke), and an explicit check of the
      mirrored key/model inputs (`MIRRORED_INPUTS`) + Voxtral voice dropdown contents.
- [ ] **Mistral LLM replies contain markdown (`**bold**`) which is passed raw to TTS**
      (observed live 2026-07-19; Voxtral TTS ignores the asterisks so it's inaudible, but
      it pollutes transcripts/logs and other TTS engines may read them). Prompt it away in
      the local-pipeline instructions and/or strip markdown before TTS.
- [ ] **Bump `SettingsManager.EMIT_DEBOUNCE_MS` (300 ms) to ~1–2 s.** A real mobile-webview
      save burst (~30 sequential `Homey.set` calls) spreads wider than 300 ms, causing
      several redundant provider rebuilds + health probes per save (each a Sentry capture).
      Observed live 2026-07-19: one save produced staggered rebuilds (mid-burst config
      snapshots). Harmless but noisy.
- [ ] **Settings webview one-off (2026-07-19, unreproduced):** one webview session where
      Save silently persisted nothing (no error shown; reopening showed old values; later
      sessions saved fine). Suspected dead webview bridge. Watch for recurrence before
      blaming our page.
- [ ] **Unhealthy local pipeline double-reports each failed probe** ("Pipeline health check
      failed" + "Realtime agent error" both captureException, every few seconds while a
      LAN box is off). Sentry throttling contains it, but consider single-report and/or
      slower campaign cap before store release.
- [ ] **TR mic level vs local VAD — FIXED 2026-07-19, refinements open:** the TR's
      WebRTC-processed mic peaks only ~330–430 int16-RMS for close speech, so the local
      VAD (adaptive threshold ~500) never detected speech and every turn timed out with
      "Heard nothing" (wake worked; ~160 chunks/turn arrived fine — diagnosed with a
      temp RMS logger). **Fix shipped and verified live:** `micGain` flag on
      `VoiceAssistantDevice` (default 1), TR driver sets 4 — applied in-place to the
      16 kHz chunks (int16 clamp) before resampler/provider so VAD *and* STT get the
      boosted audio; full TR voice turn then worked end-to-end (peak RMS 1166, correct
      transcript, spoken reply on the TR speaker). Refinements to consider: expose gain
      as a device setting instead of a constant; evaluate the TR's own mic-gain /
      noise-suppression entities (research doc) as a device-side remedy; check whether
      4× gain hurts STT when someone shouts next to the TR (clipping).
- [ ] **TR link stability — root-caused 2026-07-19, fix shipped, needs soak:** three
      "Connection timeout - no ping received" disconnects at ~3 min idle cadence. Cause:
      our health check was purely passive (device must talk within `PING_TIMEOUT` 120 s);
      the PE chatters on its own but the TR's Linux firmware goes silent when idle, so
      our own watchdog was killing a healthy link. Fix: the client now sends `PingRequest`
      itself once the link is quiet (health-check tick, `esp-voice-assistant-client.mts`)
      and the `PingResponse` refreshes liveness. _Verified 2026-07-19: 12+ min idle soak
      with zero disconnects (old cadence was a drop every ~3 min), then a wake worked
      instantly with no reconnect. Re-check the PE still behaves after this change
      (it should — its own traffic keeps the link fresh and the extra pings are no-ops)._
- [ ] **TR playback choppiness — RESOLVED ITSELF with the keepalive fix, keep watching:**
      during the flaky-link period (pre-keepalive, 2026-07-19) each per-sentence FLAC's
      last ~200–300 ms was audibly cut on the TR; after the active-ping fix the owner
      reports playback is clean. Plausibly the watchdog's connect/destroy churn was
      disturbing the announce sequencing. If it recurs on a stable link: candidate fixes
      are tail-padding each segment with ~300 ms silence (device flag like `micGain`) or
      finding an early-stop in the TR's mpv announce path.

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
