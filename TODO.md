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
- [x] **Mistral LLM replies contain markdown — FIXED 2026-07-20 (prompt side; needs a live
      spot-check):** TTS was already protected (`SentenceSpeaker.cleanForSpeech` strips
      markdown since 2026-07-05) — the leak was in transcripts/logs/history. Fix: new
      `plainTextOutput` flag on `InstructionParams` appends a short "spoken plain text
      only, no markdown" block; the local pipeline (and therefore the Mistral provider)
      sets it. The block is counted in the settings budget meter's base cost
      (`feature-costs.mts`). Speech-to-speech providers unaffected.
- [x] **Bump `SettingsManager.EMIT_DEBOUNCE_MS` (300 ms) to ~1–2 s — DONE 2026-07-20
      (now 1.5 s, pubsub tests updated).** A real mobile-webview
      save burst (~30 sequential `Homey.set` calls) spreads wider than 300 ms, causing
      several redundant provider rebuilds + health probes per save (each a Sentry capture).
      Observed live 2026-07-19: one save produced staggered rebuilds (mid-burst config
      snapshots). Harmless but noisy.
- [ ] **Settings webview one-off (2026-07-19, unreproduced):** one webview session where
      Save silently persisted nothing (no error shown; reopening showed old values; later
      sessions saved fine). Suspected dead webview bridge. Watch for recurrence before
      blaming our page.
- [x] **Unhealthy local pipeline double-reports each failed probe — FIXED 2026-07-20:**
      the `start()` health-check catch now reports loudly (logger.error → Sentry + the
      "error" emit that triggers the device's second capture) only on the FIRST failure
      of a reconnect campaign (`reconnect.attemptCount === 0`); retries log as warnings
      (no Sentry, no "error" emit). "Unhealthy" still emits every time so device
      availability stays correct; `idleHealthCheck` already single-reported.
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
- [x] **TR link stability — root-caused 2026-07-19, fix shipped, SOAK PASSED 2026-07-20:**
      overnight soak (~8+ h) with PE + TR both connected: zero disconnects, both answered a
      voice command cleanly in the morning — so the PE re-check below also passed. App
      memory stable at ~40–50 MB idle all night (~65–70 MB during active turns), CPU 0%
      idle with a small ~10% blip every ~12 min (nothing of ours runs at that cadence —
      our periodic work is 30–60 s ticks — so that's Homey platform housekeeping/GC,
      not the app). Original context: three
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
      _2026-07-20 update: after the overnight soak both devices played replies as expected —
      no recurrence so far on the stable link._
      during the flaky-link period (pre-keepalive, 2026-07-19) each per-sentence FLAC's
      last ~200–300 ms was audibly cut on the TR; after the active-ping fix the owner
      reports playback is clean. Plausibly the watchdog's connect/destroy churn was
      disturbing the announce sequencing. If it recurs on a stable link: candidate fixes
      are tail-padding each segment with ~300 ms silence (device flag like `micGain`) or
      finding an early-stop in the TR's mpv announce path.

- [x] **Feedback sounds made generic + error feedback added — DONE, real recordings pushed
      2026-07-23:** the old `please_set_api_key.flac` named OpenAI specifically,
      which is wrong now that Gemini/Mistral/local are supported. Reworked `.sounds/` into a
      provider-agnostic set (`src/helpers/sound-urls.mts` + `.sounds/README.md`):
      `wake_word_triggered`, `api_key_missing` (generic, replaces the OpenAI clip),
      `agent_not_connected`, a NEW `error` clip, and a NEW `device_connected` clip. The device
      plays `device_connected.flac` **once** on the first successful ESP handshake after pairing
      (gated by a `justPaired` store flag set in `onAdded`, cleared in the `capabilities`
      handler) so the user hears the satellite is now linked to Homey. The device now plays `error.flac` on a
      genuine **mid-turn** failure (agent `error`/`Unhealthy`/`close` while a turn is in flight)
      via `abortCurrentTurn(reason, playError)` — previously the user got total silence when a
      reply died in flight. Silent by design when no turn was active (idle reconnect) or the ESP
      link itself dropped (can't play anyway) or on an expected teardown (provider switch).
      Real recordings for `device_connected`, `api_key_missing`, `agent_not_connected` and
      `error` were recorded, pushed to main and live-verified on the PE 2026-07-23 (the
      welcome-sound path confirmed end-to-end via VictoriaLogs). `wake_word_triggered.flac`
      was deliberately left as-is — the app never plays it (the wake chime comes from device
      firmware; the only code reference is a comment in `esp-voice-assistant-client.mts`).
      Gotcha for future sound updates: `SOUND_BASE` serves from raw GitHub `main` behind
      Fastly (`max-age=300`, per-encoding cache variants), so the satellite can play a stale
      clip for up to ~5 min after a push — wait it out, a device reboot won't help.

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

**Live verification started 2026-07-20** against the owner's MA **2.9.9** (Linux server,
`192.168.0.10:8095`; the duckdns HTTPS URL is UI-only — the app uses the LAN IP/plain ws).
First finding: **MA requires token auth since API schema 28 (MA 2.9) — the shipped client
couldn't connect at all** (error_code 20 on every command; beware: an unauthed `players/all`
error was easy to misread as "0 players"). Fixed same day: `music_assistant_token` setting
(long-lived token from the MA web UI profile), `auth` command sent after the server-info frame
when schema ≥ 28, helpful create-a-token / token-rejected errors, settings-page field, fake
MA server now enforces auth in tests, READMEs updated. Pre-2.9 servers still work tokenless.

Second finding (2026-07-20, via authenticated `players/all`): **both satellites ARE
discovered** (PE `Home Assistant Voice 0908d1`, TR `3RSPK-A8E29151DBAD` — note: provider is
`universal_player`, not `sendspin`, on MA 2.9), **but `device_info.ip_address` is null for
both**, so the shipped IP-first auto-match could never hit. Fixed same day: the player hint
now carries the satellite's **MAC** (`store.mac`, from mDNS TXT) and `resolveMusicPlayer`
matches MAC first — against `device_info.mac_address` (PE) or embedded in the player_id/name
(TR) — then IP, then name/zone. Unit-tested against the exact live shapes.

**Remaining: verify against a real MA server + speakers** (needs the owner's network):

- [x] MA discovers the PE (stock 26.x firmware) and TR as Sendspin players; check what the
      players' `device_info.ip_address` / names look like so the satellite→player auto-matching
      in `resolveMusicPlayer` actually hits — VERIFIED 2026-07-20, see the findings above
      (discovery yes; IP null → MAC-hint matching added, live confirmation of the match
      pending below).
- [x] End-to-end voice flow on both devices — VERIFIED 2026-07-20 (PE + TR, MA 2.9.9):
      play by artist (incl. STT-typo'd names absorbed by MA search: "Heillung"→Heilung),
      pause/resume/next, shuffle, "what's playing?" (full now-playing string + queue count),
      explicit player targeting by name (user renamed the web player to "Legion" and targeted
      it by voice — tip: renaming MA players to speakable names works great). One fix shipped
      mid-test: **play_media timeout 15s→45s** (`PLAY_MEDIA_TIMEOUT_MS`) — MA resolves a
      first-played artist from the provider BEFORE answering, ~27-30s observed, so every
      new-artist play falsely failed on the old 15s cap. Idea logged below re the silent wait.
- [x] Announcement ducking while Sendspin music plays — VERIFIED 2026-07-20 on BOTH devices:
      music volume ducks when spoken to, reply plays, volume restores after. Identical
      behavior on PE (XMOS) and TR (WebRTC/PulseAudio).
- [x] Wake word while music is playing — VERIFIED 2026-07-20 on both devices (commands
      understood over playing music; correct per-device targeting via the MAC hint).
- [x] `resume` behavior on a long-stopped queue — VERIFIED 2026-07-20: PE queue stopped ~5 min,
      "resume" picked up exactly where it left off (resume→`play` mapping on the idle queue).
- [x] Partial-result accumulation: considered covered — live searches + a 1277-track queue
      exercised the real server paths; chunked-list accumulation stays unit-tested (no MA
      command we use returns partials at our limits).
- [x] **Slow-play acknowledgement — IMPLEMENTED 2026-07-20 (owner-requested):** if
      `play_media` is still pending after 4 s, the satellite speaks "Putting on X, one
      moment." (12 languages, `getPlayAcknowledgement` in `music-instructions.mts`) via a
      new `ToolManager.setInterimSpeak` seam registered by the device (routes to
      `speakText`). The ack timer is cancelled when the command answers fast, so quick
      plays aren't double-confirmed. Unit-tested (slow/fast/localized). Alternative
      "faster play path" (top track first, extend queue after) explicitly not chosen.
      **Follow-up same night:** a big artist catalog (Rammstein) blew even the 45 s
      `play_media` timeout — but MA completes the command late and the music starts anyway
      (verified live: queue had 283 items; the owner heard it start). So a `play_media`
      timeout now returns `ok:true, status:'preparing'` ("tell the user it's on its way")
      instead of MUSIC_UNAVAILABLE — timeouts get `err.code='MA_TIMEOUT'` in the client;
      real command errors still fail. Raising timeouts further is a losing game: resolve
      time scales with catalog size and provider latency. Timeout then LOWERED 45→30 s
      (owner: "people are impatient") — safe now that timeout = "say it's on its way",
      not failure. Live sequence for a slow artist: ack at 4 s → "on its way" at ~34 s →
      music starts by itself.

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
