# TODO — single source of truth

## Code quality — long-term (not a release gate)

- [ ] **L1 — split oversized classes / reduce `any` at trust boundaries.** The last open item
      from the second code review; context in [`docs/code_review_2.md`](./docs/code_review_2.md)
      (the fixed review items are archived in [`COMPLETED.md`](./COMPLETED.md) §7 and §12).
      Not a release gate — only touch opportunistically when other work already opens those
      files. Centralizing provider lifecycle state was deliberately declined under M7 and
      belongs here if it is ever done.

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

## M5Stack AtomS3R driver — needs hardware verification

Driver written 2026-08-06 from M5Stack's official ESPHome config alone (**no hardware was
available**) for [issue #44](https://github.com/arvebjoe/no.arvebjoe.ai-voice-assistant/issues/44);
the reporter owns three units and volunteered to test. Research and reasoning:
[`docs/m5stack-atoms3r/README.md`](./docs/m5stack-atoms3r/README.md).

- [ ] **Pair a real device end to end** — mDNS scan, manual IP, and the encrypted (Noise) path
      (likely relevant: the reporter's units were adopted by Home Assistant, so they probably
      carry an API encryption key). Confirm it lists as *"AtomS3R Echo Base Voice Assistant"*.
- [ ] **Confirm the identity sniff fires.** We match `atoms3r` / `echo base` / `echo-base` /
      `m5stack` in HelloResponse/DeviceInfoResponse, ordered after `xiaozhi`.
- [ ] **Check `voice_assistant_feature_flags`** — TIMERS and ANNOUNCE are certain from the
      config; START_CONVERSATION is assumed, not verified.
- [ ] **Verify mic levels with `mic_gain` at 0 (1×).** The config runs on-device
      `auto_gain: 31dBFS` + `volume_multiplier: 2.0`, so it should be PE-like — but that AGC is
      aggressive; watch for clipping on close-up speech as well as missed distant speech.
- [ ] **Tune `initial_audio_skip` / `followup_audio_skip`** against the wake sound; both
      default to 0 and were never measured on this hardware.
- [ ] **Confirm the mute switch is `mute_microphone`** ("Mute Microphone" template switch) and
      that `volume_mute` actually mutes the mic.
- [ ] **Check the volume clamp.** The media player has `volume_min: 0.5` / `volume_max: 0.8`;
      verify Homey's 0–1 `volume_set` maps sensibly onto that window.
- [ ] **Replace the stand-in artwork.** `drivers/m5stack-atoms3r/assets/` holds a drawn
      stylised front view, not a product photo. Swap in real images before the store release.

## VoiceAssistantEvent payloads — needs a check on a real PE

Fixed 2026-08-06: `stt_end`, `pipeline_error`, `intent_progress` and
`stt_vad_end` built their payload as a spread property (`{ text }`), which
`VoiceAssistantEventResponse` has no field for — protobufjs dropped it silently,
so the device received the bare event type all along. They now use the repeated
`data` name/value field like `intent_end`/`tts_start`/`tts_end` already did, and
`vaEvent()` only accepts that array so the trap can't come back
(`tests/esp-voice-assistant-events.test.mts` asserts on the encoded bytes).

Also fixed 2026-08-06, found the same way: **a turn nobody spoke into never
closed.** Server VAD only reports the END of speech, so total silence produced no
event at all — the mic stayed open indefinitely and, because a turn in
'listening' arms the duplicate-wake guard, every later wake was dropped: the
satellite went deaf until it reconnected. A 15 s no-speech timeout (Home
Assistant's own VoiceCommandSegmenter value) now closes the turn the way an
empty transcript does — STT_END/RUN_END plus the mic-closed cue, no error event.
Cleared as soon as VAD hears speech, so a slow talker is unaffected.

- [ ] **Watch one real turn on a PE.** Two triggers that could never fire before
      now do: `on_stt_end` (the firmware used to bail with "No text in STT_END
      event") and `on_error` with a real code/message instead of empty strings.
      Both are expected to be harmless — this is what Home Assistant sends — but
      it's device-side behaviour we've never actually exercised. Run
      `homey app run --remote` and check the PE's own log for anything new
      around STT_END, plus that a wake with no API key still just plays the
      error sound.

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

- **Timer-tool phrasing miss (2026-07-28, live test, Norwegian):** "START nedtelling ett
  minutt" did not trigger `set_timer` — the LLM said it can't do countdowns and called
  `get_local_time` instead; "SETT nedtelling ett minutt" worked. If it recurs, consider a
  line in the timer instruction block mapping start/begin-a-countdown phrasings to
  `set_timer` (mind cost-of-growth rule 1 — one sentence, inside the existing
  timers-enabled gate).

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
Avoids the items dropped in the 2026-07-07 triage (multi-timers, image analysis — see
[`COMPLETED.md` §6](./COMPLETED.md)), **except start-flows-by-voice, which the owner
un-dropped 2026-07-31** (see "Start a Homey flow by voice" below).

### Easy wins (fit the existing architecture almost directly)

- [ ] **Room-to-room intercom / broadcast** — *"tell the kids dinner is ready"*, *"announce
      upstairs that we're leaving in 5 minutes"*. `DeviceManager` already tracks every voice
      satellite and the announce/TTS path exists (the *Say* flow card); a
      `broadcast_message(room?, message)` tool is a thin layer over both. Turns the satellites
      into a whole-house intercom.
- [ ] **Household memory** — *"remember that the spare key is in the blue cabinet"* →
      `remember`/`recall`/`forget` tools persisted in app settings, stored facts injected into
      the system prompt. Makes the assistant feel personal rather than generic.
- [ ] **Start a Homey flow by voice** — *"kjør kveldsrutinen"*, *"start movie night"*. Owner
      request 2026-07-31; this **un-drops** the start-flows-by-voice idea from the 2026-07-07
      triage ([`COMPLETED.md` §6](./COMPLETED.md) — note the recorded objection there was
      really about its bundle-mate *unchunked flow-triggered replies*, which touches the
      announce race; nothing technical was held against flows themselves). Two tools:
      `get_flows` (list: id + name + folder, so the LLM can match a spoken name) and
      `start_flow(id)`.
      - **API side:** `homey:manager:api` is already granted and the HomeyAPI instance is
        live in `ApiHelper` — but it only exposes `devices` and `zones` today, so add a
        `flow` accessor (or go through `getApi()`) next to them. Homey has **two** flow
        kinds — standard Flows and Advanced Flows — with separate list/trigger calls;
        cover both or the feature will look broken for anyone on Advanced Flows. Confirm
        the exact homey-api method names and whether triggering needs the flow to carry a
        *"This flow is started"* trigger card before speccing.
      - **Prompt cost:** do NOT inject the flow list into the system prompt — a real Homey
        has hundreds of flows. List on demand via the tool, exactly like devices/zones
        (cost-of-growth rule 1). Gate the whole thing behind a `flows_enabled` setting
        (default off) with a `FEATURE_TOOLS` entry + a `refreshFlowTools()` reconciler, and
        add it to `/feature-costs`.
      - **Product decision needed:** a flow can do anything the user built into it —
        unlock doors, disarm alarms. Decide whether every flow is voice-startable or only
        opted-in ones (a folder, a name convention, or a per-flow allowlist in settings).
        The H4 `allow_unlock_via_voice` precedent is the model to follow if a gate is wanted.
- [ ] **Moods** — Homey has native Moods and there is no mood tool today. `list_moods` +
      `set_mood` via `ApiHelper`, same pattern as the zone/device tools. Covers the "scenes"
      ask; pairs naturally with the flow tools above (same `ApiHelper` extension).
- [ ] **Presence** — *"is anyone home?"*, *"is Anna home yet?"*. Read-only tool over Homey's
      user/presence API.
- [ ] **Accept full URLs (https) in the custom-pipeline host fields** — forum request
      2026-07-29 (user runs their pipeline containers behind a swag reverse proxy). Verified
      state: the dedicated backends take *Host + Port* and hardcode the scheme —
      `http://${host}:${port}` in `ollama-client.mts:51`, `whisper-client.mts:44`,
      `piper-client.mts:83` (LM Studio likewise) — so an https URL in those fields yields
      `http://https://…` and fails. Nothing validates the input; the placeholder ("e.g.
      192.168.1.50") is just what makes it look IP-only. **There is already a working route:**
      each stage's *OpenAI-compatible* backend uses a Base URL field, and
      `normalizeOpenAiBaseUrl()` (`local/openai-compat.mts`) only prepends `http://` to a bare
      host — a full URL keeps its scheme. Fix: let the Host fields take a full URL too (parse
      scheme/host/port, keep the Port field for bare hosts) and refresh the placeholders.
      Note Wyoming STT/TTS can't benefit — raw TCP, not HTTP, so an HTTPS proxy can't front it.

### High value, more work

- [ ] **Voice-input-only mode (reply spoken by some other speaker)** — forum request
      2026-07-29, owner-approved in principle. User wants the satellite as a *microphone only*
      and the answer spoken by the Sonos app's *Say* card, with no TTS container at all.
      Design: a per-device setting (e.g. "Play response on this device", default **on**);
      when off, skip playback entirely.
      - **The flow side already works** — no new trigger card needed. `assistant-thinking`
        fires with the finished reply and `type: 'reply'`
        (`voice-assistant-device.mts:790`). Flows MUST filter on that token: the same card
        also fires per tool call with `type: 'tool'`, so an unfiltered flow speaks
        "Using tool get_devices".
      - **Real work item:** make the TTS stage optional. `LocalPipelineProvider` currently
        hard-requires it at startup — `tts.hasCredentials()` / `isConfigured()` / `check()`
        gates at lines 490, 498, 509, 572, 591 — so today you need a TTS container running
        even if nothing is ever spoken. Also check the realtime providers: they should be
        put in an audio→text mode rather than generating speech that gets thrown away.
      - **Known trade-offs to document for the user** (both confirmed, not guesses):
        follow-up questions stop working, because continue-conversation keys off the device
        finishing its own playback — every turn needs the wake word again; and the external
        TTS round trip adds latency on top of the pipeline.
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
