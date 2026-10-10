# TODO — single source of truth

## Device-less Flow cards — live verification (forum request: AI announcements on Sonos)

- [ ] **Live-test the three app-level cards on a real Homey** (`create-speech-url`, `ask-assistant`,
  `ask-assistant-speech-url`; `src/homey/flow-assistant.mts`). Unit-tested with a fake provider only.
  Check: the URL plays on a Sonos via *Play a URL*; the voice autocomplete lists the current
  engine's voices and the override is audible; an ask that controls a device works with no room
  of its own; each engine (OpenAI realtime, Gemini, Mistral, custom pipeline) answers; a settings
  save mid-use rebuilds cleanly; the realtime socket closes after 5 idle minutes. Then reply on the
  forum thread.

## Model refusals — optional follow-ups (from the 1.5.4 work, not started)

- [ ] Let the Gemini and Mistral providers emit `model_unavailable` on their equivalent
      refusals (the device side is provider-neutral already).
- [ ] The Custom pipeline's OpenAI-compatible stages could send the same "your project has no
      access to model X" Homey notification on a 403 — no auto-fallback (the model is explicit
      user config there), just the explanation instead of only the error voice. Surfaced by the
      2026-08-31 live test, which started on that path by accident.

## Code quality — long-term (not a release gate)

- [ ] **L1 — split oversized classes / reduce `any` at trust boundaries.** The last open item
      from the second code review; context in [`docs/code_review_2.md`](./docs/code_review_2.md)
      (the fixed review items are archived in [`COMPLETED.md`](./COMPLETED.md) §7 and §12).
      Not a release gate — only touch opportunistically when other work already opens those
      files. Centralizing provider lifecycle state was deliberately declined under M7 and
      belongs here if it is ever done.

## Turn robustness — nothing caps how long one utterance may run

- [ ] **Add a maximum-utterance cap to the turn.** `NO_SPEECH_TIMEOUT_MS` (15 s,
      `voice-assistant-device.mts:132`) is the only clock on an open mic, and it is **cleared
      outright** the moment the provider's VAD reports speech (`:753`). After that the sole
      thing that can end the turn is the provider's `silence` event — server VAD has no maximum
      duration — so a mic feed that never goes quiet enough pins the state machine in
      `listening` **forever**. The satellite sits on its listening page and stops answering.
      Found while triaging the M5Stack hang report (2026-08-10); it is not M5Stack-specific,
      but aggressive on-device AGC (`auto_gain: 31dBFS` + `volume_multiplier: 2.0`) pumping
      room noise between words is a plausible trigger.

      The fix is to make `speech` lower the net to a floor rather than cancel it. Mind
      `tests/voice-assistant-device.test.mts` — the case *"stands down once VAD hears speech,
      however long the user then talks"* asserts today's behaviour deliberately and has to be
      rewritten alongside. Users now have a manual escape hatch (switching the tile's *Start
      conversation* off cancels the turn), so this is a robustness item, not an emergency.

## Forum: pairing probe rebooted the satellite — one open question

Fixed (full write-up: [`COMPLETED.md`](./COMPLETED.md) §22). The pairing probe asked for the
voice-assistant configuration, which null-derefs and **reboots** ESPHome 2025.8 - 2026.5; the probe
now settles from `DeviceInfoResponse.voice_assistant_feature_flags` instead. Verified on a real
Voice PE, patched build, three firmwares — 25.12.4 (ESPHome 2025.12.2, affected), 26.4.0 (2026.3.2,
affected) and 26.6.0 (2026.6.2, already safe upstream) all pair, and a command works afterwards.

- [ ] **Did the reporter's 26.6.0 really fail?** He listed it among the failures, but 26.6.0 carries
      ESPHome 2026.6.2, which has the upstream fix and answers an unsubscribed request harmlessly —
      so on this diagnosis **old app code + PE 26.6.0 should pair fine**. Cheap test, only worth
      running while a PE is already on 26.6.0: install the unpatched build and pair.
      - *Pairs* → diagnosis complete; he mis-attributed that one.
      - *Times out* → the null-deref is real but not the whole story on 2026.6.x; reopen before
        telling anyone this is solved.
      **Most likely explanation, no test needed:** his *original* report was "stuck Unavailable
      **despite successful pairing**" — a different symptom from the pairing timeout, and quite
      possibly the availability/API-key confusion archived in
      [`COMPLETED.md`](./COMPLETED.md) §33. The follow-up may simply have merged his two symptoms
      into one firmware list.

## Diagnosability — one item left after the Dump-log work

The 2026-08-15 "Unavailable / Connected: no" triage and the "Pas de connexion" portal-log analysis
are archived in [`COMPLETED.md`](./COMPLETED.md) §33 (their fixes: §21, §23, §24); the Dump-log
design and its rejected alternatives in §34 (shipped: §27). Neither reporter's root cause was ever
established — if either resurfaces, the tile and the Debug tab now answer the questions themselves.

- [ ] **Dump a compact snapshot into the app log automatically, so unprompted reports are not a dead
      loss.** Some users just press *Create Diagnostics Report* without reading anything. A short
      dense block — ESP connect/handshake outcome, provider selected and whether it ever opened,
      last error per subsystem, sanitized config — written on every session end and every connect
      failure keeps the tail of the app log useful inside Homey's narrow submission window. This is
      the fix for the "Pas de connexion" portal report ([`COMPLETED.md`](./COMPLETED.md) §33), which
      arrived with a user message and a log that could not answer it.

## ReSpeaker XVF3800 driver — needs hardware verification

Driver written 2026-07-28 from the community ESPHome config alone (**no hardware was
available**), so everything below is a documented best guess. Research and the reasoning behind
each choice: [`docs/respeaker-xvf3800/README.md`](./docs/respeaker-xvf3800/README.md).

**Tester feedback 2026-08-07 — first real-hardware report.** A tester with a board reports it
"seems to be working". Encouraging but NOT yet a tick for anything below: he confirmed nothing
item by item, so treat these as still open until he answers specifics. His board has **no
speaker**, which is why he cannot verify anything on the playback side at all — he wants the
reply handed to a Sonos speaker as a URL instead (shipped 2026-08-10:
[`COMPLETED.md`](./COMPLETED.md) §31). Ask him explicitly about mic levels at `mic_gain` 0,
the listed device name, the mute switch, and whether his unit carries an API encryption key.

**Second report 2026-08-10 (forum post #60), with full app + ESPHome logs.** Three of the four
problems he reported are **fixed** — the `Beam lock released` loop was the Docker-bridge audio URL
bug and the `client has not subscribed to actions` spam was the missing
`SubscribeHomeassistantServicesRequest` (both archived in [`COMPLETED.md`](./COMPLETED.md) §17),
while `No text in STT_END event` was already fixed on `dev` by `198ce16` (§14) and only showed up
because his build came from `main`. None was ReSpeaker-specific and none was caused by the custom
pipeline he suspected. His config is the
stock [`respeaker-xvf-satellite-example.yaml`](https://github.com/formatBCE/Respeaker-XVF3800-ESPHome-integration/blob/main/config/respeaker-xvf-satellite-example.yaml)
with only the device name changed. What remains open and ReSpeaker-shaped:

- [ ] **Device stops reacting to a follow-up question** (field report 2026-08-10, **root cause
      not established** — do not fix blind). In his 21:10 log the reply plays correctly
      (`Streaming …tx_79e63413….flac (FLAC)`, `Decode finished`), then `micro_wake_word` fires
      **four** times (`21:10:45`, `:47`, `:52`, `:58`) and nothing follows — no new
      `VoiceAssistantRequest`, no STT. So detection works and the device simply never asks us to
      start a run, which points at it being stuck in conversation/announce state instead of
      returning to idle. Corroborating: a doubled `Beam lock released` at `:41.038`/`:41.040`,
      and `micro_wake_word: Wake word detection is already running` in the earlier log. Our side
      of that state is the sticky `continue_conversation` flag on `intent_end(text,
      continueConversation)` (`esp-voice-assistant-client.mts:1037`) — worth auditing what we
      send for this device, but the YAML's `on_end` also does an **unbounded** `wait_until` before
      restarting `micro_wake_word`, exactly like the M5Stack hang candidate above. Needs a
      reproduction or a DEBUG-level device log covering one good turn plus one ignored wake word.
- [ ] **`No text in TTS_START event` — the replying phase never engages on this hardware.**
      We deliberately omit the text on the announce path (`voice-assistant-device.mts:434`)
      because the PE firmware fires `tts_start_trigger_` itself for announcements. The ReSpeaker
      YAML's `on_tts_start` does not, so its LED/beam "replying" phase is skipped. Sending the
      text unconditionally is probably right, but verify it does not double-fire the phase on
      the PE before changing it.
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

**First hardware report, 2026-08-07:** the reporter's unit is adopted by Home Assistant and
does carry an encryption key — it listed as *"needs encryption key"*, and the Noise handshake,
entity list and DeviceInfo/VA-config exchange all **succeeded**. It then failed the identity
check with `not_a_match`, because he had renamed the device ("Mikro EG") and the M5Stack
config exposes no other identifying string (no `project:`, no `board:` → `model` is just
`esp32-s3-devkitc-1`). Manual entry now accepts an unidentified-but-voice-capable device; see
[`docs/m5stack-atoms3r/README.md`](./docs/m5stack-atoms3r/README.md#identity-defaults--user-editable).

**Second hardware report, 2026-08-10 — the core loop works.** With `friendly_name` temporarily
set to *"Mikro EG AtomS3R"* (the workaround for the identity miss above, no longer needed once
`3020e3d` ships) the tester confirmed: **pairing completes and the device lists correctly**, the
**wake word → question → spoken reply loop works**, and the **microphone hears him from across
the room** at `mic_gain` 1× — so the no-`defaultMicGain`-override call was right, and the sniff
branch does fire on the `atoms3r` token. No clipping reported on close-up speech either.

What he found broken heads the list below. Note how many of them are **"the command seems not to
arrive"** shaped, and reading M5Stack's YAML against our code found no defect on our side: the
mute switch really is `mute_microphone` (`scoreMuteCandidate()` scores it 1), the vendored
`es8311` component does implement `set_volume`, ESPHome applies volume to the *announcement*
speaker (our playback path) and `volume_min: 0.5`/`volume_max: 0.8` still spans roughly −32 dB
to +6.5 dB at the DAC. All of it was blocked on the ESPHome device log, requested 2026-08-10 —
**that log arrived 2026-08-14 and is read below.**

**Third hardware report, 2026-08-14 — the device log arrived**
([issue #44](https://github.com/arvebjoe/no.arvebjoe.ai-voice-assistant/issues/44), saved verbatim
as [`docs/m5stack-atoms3r/logs/2026-08-14-mirko-ug.txt`](./docs/m5stack-atoms3r/logs/2026-08-14-mirko-ug.txt)).
20 minutes, 2089 lines, `14:49:26` → `15:10:54`, firmware **ESPHome 2026.7.4** (compiled
2026-08-07), Noise encryption **on**. Reporter's summary: mute dead, volume dead, timer fine but
"the device crashed afterwards and I had to pull the plug", Sonos-over-URL failed, and it "keeps
hanging". Four things the log settles:

1. **Mute and volume were the `object_id` bug — already fixed, not yet shipped to him.** Every
   reconnect logs `'ai-voice-assistant' using outdated API 1.6, update to 1.14+`, so the build he
   ran predates `29338cf`; and 2026.7.0+ never sends `object_id` to *any* client
   ([`COMPLETED.md`](./COMPLETED.md) §18). So **no** entity key resolved — not the mute switch,
   not the volume number, not the media player. Evidence: pressing mute produces not one `switch`
   line in the whole log, and `setze die Lautstärke auf 60%` is recognised at `14:56:46` while all
   60-odd `[S][media_player]` dumps from `14:49` to `15:10` still read `Volume: 50%`. Nothing to
   investigate — this needs a re-test on a build carrying `29338cf` (see the last item).
2. **The timer worked end to end.** `14:50:06` timer created (120 s), countdown events at 90 / 60 /
   30 s, `Type: 3` finished at `14:52:06`, chime played and repeat-played ~10× to `14:52:40`. The
   earlier "no chime" report does not reproduce.
3. **The I2S bus wedges: the mic and the speaker cannot both hold it, and that is what "keeps
   hanging" means.** `[E][i2s_audio.speaker.std:401] Parent bus is busy` + `Driver failed to start;
   retrying in 1 second` fires 139 times, and the clusters line up **exactly** with the dropped
   turns: the retry loop starts on the same second our 24 kHz reply FLAC begins decoding
   (`14:56:01`, `14:57:08`, `15:03:12`, `15:05:51`), runs for 10–25 s with **no audio playing**,
   and stops on the same second the API connection drops — after which `i2s_audio.speaker:063
   Starting` finally succeeds, because the disconnect made the VA stop the microphone and release
   the bus. The AtomS3R mic (GPIO7) and Echo Base speaker (GPIO5) share one I2S peripheral, and
   `micro_wake_word` re-arms the mic the moment the VA leaves `STREAMING_MICROPHONE` — the Voice PE
   has separate buses and never shows this. It is a race, not a constant: plenty of turns
   (`14:56:39`, `14:56:49`, `15:02:19`) announce and play normally.
4. **Nine disconnects in 20 minutes, all closed from our end** — `Reading failed CONNECTION_CLOSED
   errno=128`, and the device reacts by dropping `STREAMING_RESPONSE` → `IDLE`, i.e. **the reply is
   cut off mid-sentence**. Only one of them (`15:05:27`, exactly 120 s after connect) is the ping
   watchdog; the rest sit at 17 / 32 / 48 / 52 / 190 / 199 s, so `PING_TIMEOUT` (120 s,
   `esp-voice-assistant-client.mts:205`) does not explain them. The unconditional
   `handleDisconnect()` callers are the suspects — RX-buffer overflow (`:505`), frame-decode
   failure (`:520`) and Noise decrypt failure — and this is the **only** tester running Noise
   encryption.

- [ ] **Find out who closes the TCP connection mid-reply** (log finding 4). The device log cannot
      name the path — **ask for the Homey-side log for the same window** (`homey app run --remote`,
      or point `remote_log_*` at a collector), where every one of the three candidate paths logs a
      warn/error naming itself. If it is the Noise decrypt/frame path, that is a real bug in
      `noise-frame-codec.mts` under sustained traffic and it affects every encrypted device, not
      just this one. This is the top item on the list: it is ours, it is reproducible, and it is
      what the reporter experiences as "not stable enough for regular use".
- [ ] **Report the shared I2S bus to M5Stack** (log finding 3, angle (b); angle (a), the announce
      watchdog on our side, is done — [`COMPLETED.md`](./COMPLETED.md) §29). The watchdog stops the
      hang from stranding the turn, but the reply still does not play: `Parent bus is busy` is the
      firmware's mic and speaker fighting over one I2S peripheral, and `micro_wake_word` re-arming
      the mic the moment the VA leaves `STREAMING_MICROPHONE` is what wins the race. Check whether
      their `i2s_audio` can be configured duplex / the wake-word restart delayed until
      `media_player` is idle, since a satellite that cannot speak while its wake-word engine
      listens is a hardware-config bug. Verify on the reporter's next Dump log that the watchdog
      lines (`never reported the ... clip finished`, then `Second clip in a row`) fire where the
      freezes used to be — on his hardware it should be the two-strike abort, not the forgiven
      single miss the ThirdReality produced on 2026-08-29.
- [ ] **Device rebooted at ~`14:53:35`** (`safe_mode:142 Boot seems successful; resetting boot loop
      counter` at `14:54:48`, plus the CLI's `Processing unexpected disconnect`) — this is the
      "crashed after the timer" report. Immediately before it: twelve announce cycles between
      `14:52:06` and `14:53:34` (ten of them the timer-chime loop, inside 35 s), each allocating a
      fresh **1 MB** `ann_read` ring buffer, on top of a
      `Parent bus is busy` retry loop running continuously from `14:52:41` to `14:53:43`. Suspect
      PSRAM exhaustion / fragmentation on the firmware side. No backtrace survived the reset, so
      this stays a hypothesis; ask him to capture the crash dump if it recurs.
- [ ] **`onoff` appears to do nothing** (field report). It should chime and open the mic
      (announce + `start_conversation`). ESPHome sets ANNOUNCE **and** START_CONVERSATION
      whenever the VA has a `media_player:`, and this config does — so if it genuinely does
      nothing, that is a real bug. The tile is now labelled *"Start conversation"* and off
      cancels the running turn, which removes the "is this a power switch?" confusion but not
      the underlying report. **Not exercised in the 2026-08-14 log** — every turn in it starts from
      the wake word — so this one is still untouched by evidence and needs its own test.
- [ ] **The timer chime rings until the button is pressed, and nothing else stops it.** Firmware
      repeat-plays `timer_finished_sound` while the `timer_ringing` switch is on; the log shows ~10
      repeats and no path that clears it from our side. Decide whether the assistant should be able
      to stop a ringing timer by voice (and whether we should clear `timer_ringing` when a turn
      starts) — ten 1 MB announce buffers in 35 s is also the run-up to the reboot above.
- [ ] **Session hangs — "stayed in listening mode and did not exit"** (field report). Two distinct
      causes now, and the log points at the second: the missing max-utterance cap (own section
      above), and the wedged-bus/dropped-connection pair (log findings 3 and 4), which is what
      actually shows up in this log. Firmware-side candidate still worth ruling out: `on_end`
      contains an **unbounded** `wait_until (not media_player.is_announcing AND not
      speaker.is_playing)` before it restarts `micro_wake_word` — and with the I2S bus wedged that
      condition is exactly what fails to resolve.
- [ ] **Confirm the identity sniff on a device with its STOCK name**, and the **mDNS scan** with
      it. Both field reports came from renamed units, and a renamed device never appears in the
      network scan — manual IP is the documented route for those.
- [ ] **Tune `initial_audio_skip` / `followup_audio_skip`** against the wake sound; both
      default to 0 and were never measured on this hardware. The log now shows why it matters: the
      turn at `15:02:40` transcribed **`"오케이, 나부."`** — the device's own *Okay Nabu* wake sound
      coming back through the mic — and three further turns burned 15 s of open mic each only to end
      `No text in STT_END event` (`14:57:08`, `15:03:11`, `15:05:51`).
- [ ] **Sonos-over-URL failed and needed a restart** (field report, 2026-08-14). The device log is
      blind to this by definition — the `WARNING Disconnected from API` gap from `14:57:17` to
      `15:00:04` is all it shows. Needs a Homey-side log plus which Flow card he used; the
      *Reply audio ready* card path was rewritten on `fix/reply-audio-ready` (MP3, reachable IP)
      after his build, so re-test before digging.
- [ ] **Replace the stand-in artwork.** `drivers/m5stack-atoms3r/assets/` holds a drawn
      stylised front view, not a product photo. Swap in real images before the store release.
- [ ] **Ship a test build carrying `3020e3d` *and* `29338cf`** — the first lets the tester drop the
      rename workaround, the second is what makes mute and volume work at all on his 2026.7.4
      firmware (log finding 1). His build advertises API 1.6, so it predates both. Until that build
      is out, every "command doesn't arrive" report from him is expected and re-testing anything
      else on that hardware is wasted effort.

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

- **Mistral Voxtral Realtime STT has no language pin (found via PR #52, 2026-08-28):** the
  Gemini Live sidecar transcriber flipped Dutch to German until PR #52 sent `languageHints`;
  every other STT backend already passes `language` through. The Voxtral Realtime websocket
  (`mistral-realtime-stt-client.mts`) has NO language parameter — the model detects the language
  and reports it afterwards in `transcription.language`. Worse than the Gemini case because the
  Mistral provider is a chain (STT → LLM → TTS): a mis-transcribed utterance is the LLM's only
  input, so the whole answer goes wrong, not just the log line. Options if it bites: check the
  reported `transcription.language` against `selected_language_code` and re-run the utterance
  through the batch Voxtral STT (which does take `language`), or note the limitation in
  README.md. Left alone until a user reports it.

- **Zone fallback cannot tell two same-named zones under the SAME parent apart (PR #51,
  decided 2026-08-27 — deferred):** `grantFallback()` (shared by the typed fallback and the `cover_sweep` fallback) groups matches on the zone *path*
  (`"Office > Upstairs"`), which separates same-named zones under different parents but not
  siblings with identical names. Fixing it needs a zone id on `Device`, which lands in every
  device listing the model sees — a per-device token cost (`docs/cost-of-growth.md`). Left as
  is because the layout is rare and the failure mode is a *declined* fallback (the safe
  direction). Revisit only if a user reports a real house that hits it.

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
- [ ] **Weather for any location, not just home** — *"what's the weather in Paris?"*,
      *"will it rain in Bergen tomorrow?"*. Verified state 2026-08-07: weather is hard-wired to
      the Homey's own coordinates. `GeoHelper` reads lat/lon from `homey.geolocation`
      (`geo-helper.mts:83`), `WeatherHelper` injects exactly those into every Open-Meteo call
      (`weather-helper.mts:155`, `:230`, `:303`) and throws `No location data available from
      GeoHelper` when they're missing — no fallback location input. None of the five weather
      tools (`get_current_weather`, `get_weather_forecast`, `will_it_rain`,
      `get_weather_summary`, `get_outside_illumination`, `tool-manager.mts:1388`) expose a
      location parameter; the only arg any of them takes is `hours`. So an away-from-home
      question either falls through to `web_search` or gets answered from model knowledge.
      - **Fix:** optional `location` string on the weather tools → geocode via Open-Meteo's
        free `geocoding-api.open-meteo.com/v1/search` (no key, same provider) → pass those
        coordinates instead of GeoHelper's. Omitted `location` keeps today's home behavior.
      - **Cache:** `WeatherHelper` has a single global slot per query type (10 min validity,
        `weather-helper.mts:83`) — must become location-keyed or a Paris lookup will answer
        the next "what's it like outside?".
      - **Prompt cost:** five tool descriptions grow by a parameter each; check the delta in
        the `/feature-costs` meter before landing (cost-of-growth rule 1). Also drop the
        "at the user's location" wording from the descriptions and the "for the home's
        location" phrasing in `get_assistant_capabilities` (`tool-manager.mts:641`).
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
      when off, skip playback entirely. Related but NOT the same as the URL hand-off above —
      that one keeps our TTS, this one removes it. If both ship, they are two values of the
      same per-device "reply audio" setting.
      - **The flow side already works** — no new trigger card needed. `assistant-thinking`
        fires with the finished reply and `type: 'reply'`
        (`voice-assistant-device.mts:805`). Flows MUST filter on that token: the same card
        also fires per tool call with `type: 'tool'`, so an unfiltered flow speaks
        "Using tool get_devices".
      - **DONE for the Custom pipeline (2026-08-07):** the TTS stage now accepts
        `local_tts_provider: 'none'` (`providers/local/none-clients.mts`), so no TTS container
        is needed — the None client satisfies the startup gates without touching the network,
        and `textToSpeech()` throws so the *Say* card reports an error instead of serving
        silence. Shipped alongside `local_llm_provider: 'none'` (forum request 2026-08-07: stop
        after STT and hand the transcript to a Flow).
      - **`local_llm_provider: 'none'` LIVE-VERIFIED on the PE 2026-08-09.** Flow: dump the
        transcript to the timeline on `assistant-heard`, wait 1 s, then *Say* "yes sir!" —
        heard on the PE. Confirms both halves: the transcript still reaches the trigger with
        no LLM in the chain, and the no-reply-audio turn closes itself (the `silent` report
        from `AudioOutputPipeline` on `reply-done`) instead of hanging waiting for an
        `announce_finished` that never comes.
      - **`local_tts_provider: 'none'` LIVE-VERIFIED on the PE 2026-08-09 — this IS the
        requested feature, working.** "What is the time?" → timeline showed the transcript,
        then `Using tool get_local_time`, then `It's 11:56 PM.` The full chain runs (STT →
        LLM → tool call → reply text out on `assistant-thinking`); only speech is removed.
        The mic-closed "end" tone still plays — it goes out via `playUrl()` from the LAN
        webserver, nothing to do with the TTS stage — and nothing follows it: no reply
        audio, no hang. Matches the `noOp` design (the provider skips the stage rather than
        calling it).
      - **That test also demonstrated the `type`-token footgun above**, live: the timeline
        received TWO `assistant-thinking` fires for one turn, `type: 'tool'`
        ("Using tool get_local_time") and `type: 'reply'`. Harmless in a timeline; a Flow
        wired to a *Say* card without the filter would speak the tool name out loud first.
      - **The *Say* card under `local_tts_provider: 'none'` also verified 2026-08-09**, and
        it behaves as designed: `textToSpeech()` throws at
        `local-pipeline-provider.mts:887-888` ("TTS backend is set to 'None' — this device
        cannot speak…"), the driver's run-listener catches it
        (`voice-assistant-driver.mts:111-113`) and the Flow editor shows the message rather
        than the card silently succeeding. That test also surfaced the Sentry-noise bug
        fixed the same evening ([`COMPLETED.md` §15](./COMPLETED.md)).
      - **Still open:** the same for the three realtime providers — they should be put in an
        audio→text mode rather than generating speech that gets thrown away; and this is a
        GLOBAL setting, so it cannot be per-device the way the original request imagined.
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
- [ ] **Deferred / scheduled actions — "do this later, or when a condition holds"** — owner idea,
      recorded 2026-08-20 when the abandoned `feature/job-manager-executor` branch was deleted
      (that branch was an *idea sketch*, `src/helpers/job-manager.mts` + `job-executor.mts` +
      tool-manager wiring, ~1965 lines, never working code — treat it as inspiration only, not a
      starting point; recover it from the reflog/GitHub if the shape is ever wanted).
      The user tells the assistant to do something at a later time or on a schedule, and the LLM
      writes **half-baked instructions for its own future self** — a stored natural-language job
      plus whatever structured trigger info it can pin down. A **Flow card** kicks off the future
      event (so the schedule/trigger lives in Homey, where it belongs, rather than in a timer we
      have to keep alive); when it fires, the app checks whether any stored job is ready for
      execution, and if so hands that half-baked instruction back to the LLM, which then acts on
      it — evaluating the condition itself, calling the normal tools, and producing a result. The
      result can be returned as text or spoken on a speaker (the existing *Say* / reply-audio
      paths cover both).
      Examples: *"if it's cold tomorrow at 7, turn on the heater in my Tesla"*, *"if nobody is home
      at 08:00 tomorrow and the door is unlocked, then lock the main door and arm the alarm"*.
      Open questions to settle before speccing: where jobs persist and how many are kept; how the
      LLM's stored instruction is bounded (prompt cost at execution time, cost-of-growth rule 1);
      whether a job is one-shot or recurring, and what expires it; which Flow card shape drives it
      (a single "check pending assistant jobs" action the user schedules however they like is the
      cheapest start); and the safety gate — these jobs run unattended, so anything touching locks
      or alarms must respect the `allow_unlock_via_voice` precedent.

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
