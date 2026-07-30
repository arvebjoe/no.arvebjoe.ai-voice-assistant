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
10. [x] Wake-word model (0.98 cutoff) DONE 2026-07-28: verified through ~9 days of daily
         use on the PE (firmware running since ~07-19) — wakes reliably at distance and
         with the TV on, no meaningful false accepts. 0.98 stays the shipped cutoff.
11. [x] Mic auto_gain 6 dBFS DONE 2026-07-28: same 9-day daily-use window — transcripts
         accurate, no audible clipping/distortion. 6 dBFS stays the shipped value.
12. [x] LED voice-phase rainbows: distinct listening/thinking/replying, seamless position
         handoff, dark-level looks right
13. [x] Timer round-trip on the satellite DONE 2026-07-28 (live, real PE + Homey Pro):
         voice "Sett nedtelling ett minutt" → `set_timer` tool ok → verbal confirmation,
         LED ring countdown, chime + blue flashing LEDs at zero. Note: the phrasing
         "START nedtelling ..." did NOT trigger the tool (LLM claimed it can't do
         countdowns and read the clock instead) — candidate agent-instruction tweak,
         tracked under Watch items. Stopping the chime with the button also verified.
14. [x] Smart-home control regression DONE 2026-07-28 (live, real PE + Homey Pro, all in
         Norwegian): **on** (Trimrom zone → 4 lights, 3 success + 1 unreachable reported
         per-device and relayed in the reply), **zone targeting** (Trimrom, Kontoret via
         get_zones → get_devices), **dim** ("Dimm taklyset på kontoret til 10 prosent" →
         dim 0.1, then back to 1.0 with the model reusing the device id from context —
         no re-query), **H4 lock path**: voice-lock success; unlock with
         `allow_unlock_via_voice` ON succeeded single-device (the toggle turned out to be
         enabled — flipped during the 07-26 settings screenshots, worth remembering as a
         hazard of screenshot sessions); with the toggle OFF the gate refused with
         UNLOCK_DISABLED and the agent explained the setting by name. Note: the LLM
         sometimes tries `get_devices_in_standard_zone` first for a named room and asks
         instead of jumping to the zone lookup — harmless, self-corrects.
15. [x] Settings page in the real mobile-app webview: rendering, section dropdown, sticky
         footer, budget-meter tap breakdown, stage Test buttons (the 07-19 pass verified all
         of this through Homey's API routing — confirm whether that was the mobile app; if
         yes just tick)
16. [x] Spurious-retry window: live test 2026-07-28 **caught a real bug** — a silent
         follow-up window ended after 30 s with a hallucinated transcript ("Kronborgsvingen
         62, slå av soverom taklys", built from our own STT vocabulary prompt) and the agent
         REALLY turned off the bedroom light. Root cause: `turn_detection.idle_timeout_ms:
         30000` makes OpenAI **commit** the speech-free buffer on timeout
         (`input_audio_buffer.timeout_triggered`, no handler existed); gpt-4o-transcribe then
         hallucinates from room tone + vocab prompt, and our transcript handler anchored a
         response on it. The PE LED never left "waiting" — server VAD correctly saw no
         speech the whole time. FIX (same day): handle `timeout_triggered` — mark the item
         id, emit `silence` (mic closes like a normal end-of-utterance), and when that
         item's transcript arrives discard it as silence + delete the audio item. Tests
         green. Marked [x]: re-verified live same evening — silent follow-up → "Idle
         timeout" + "Discarding transcript" warns (the STT hallucinated ANOTHER command,
         "Slå på terasse", proving the class of bug), no tool call, conversation closed
         cleanly. No spurious retry observed in any of the session's turns either.
         Follow-up refinements same night (owner-requested, both live-verified): idle
         timeout 30 s → 10 s, and a descending mic-closed chime (A5→E5, the listening
         chime mirrored — `ensureMicClosedChime` in listening-chime.mts) plays when a
         window ends with nothing heard. Third hallucination discarded during verify
         ("Hvordan er temperaturen på 2. etasje?") — the guard is earning its keep.
17. [x] Audio-skip defaults DONE 2026-07-28 (live, real PE): fresh-wake transcripts clean —
         no wake-sound artifacts with `initial_audio_skip` 0 (three wake turns checked);
         follow-up answer "New York, ja." transcribed with the first word intact
         (`followup_audio_skip` default 150 ms).
18. [x] Bring! with real credentials: add / remove / read items; SSO-account gotcha message
         (items 18–21: console `ask` is fine, no satellite needed)
19. [x] Web search DONE 2026-07-28 (live, real PE): `openai` ✓ (specific query answered
         with sources in ~17 s; a broad "all today's news" query hit the 30 s
         REQUEST_TIMEOUT_MS and failed gracefully — SEARCH_FAILED to the model, spoken
         apology, no hang; decision: keep 30 s, voice users won't wait longer);
         `brave` ✓ (real key, result in ~1 s, snippets summarized by the agent);
         `disabled` ✓ (explicit "søk på nett" request → no tool call, agent says it
         can't search). UNTRUSTED WEB CONTENT wrapper observed on both backends.
20. [x] Gemini live provider DONE 2026-07-28 (live, real PE, real key): provider rebuilt
         on save, greeting + follow-up + get_local_time + full smart-home chain
         (get_zones/get_device_types in parallel → get_devices → set_device_capability,
         office light off) all worked. **Latency better than OpenAI** per the owner.
         Fixed during the test: Gemini emits no speech-start with automatic VAD, so the
         PE LED sat on "waiting" all turn — the provider now emits `speech` on the first
         input-transcription delta (gemini-live-provider.mts, `speechSignaled`). Caveat:
         those deltas lag, so the listening phase renders short; optional post-release
         polish would be local energy VAD (SimpleVad) inside the provider for an
         immediate signal.
21. [x] Feature-gate flips besides weather (verified both ways 2026-07-19): web search,
         timers, Bring!, Music Assistant on/off → provider restarts, tool list changes
22. [x] Budget-meter verdict (green/amber/red) vs `local_llm_num_ctx` — needs Ollama,
         overlaps item 36
23. [x] Flow-card run-listeners from the console DONE 2026-07-30 (emulator console,
         scripted, real PE at 192.168.0.50, 14/14 checks): `and is-muted` false→true→false
         via `press volume_mute`; timer cards — `start-timer` ⚡ timer-started with tokens,
         `timer-is-running` true while counting, ⚡ timer-finished at zero (rang the real
         PE — note: after the emulator exits nothing can cancel the ring; the PE button
         stops it), `cancel-timer` ⚡ timer-cancelled, and starting a new timer over a
         ringing one fires timer-cancelled for the old first (replace semantics, as
         designed); `ask-agent-output-as-text` returned `{"ai-output":"The capital of
         France is Paris."}` tokens; `speak-text` TTS played audibly on the PE. Gotcha
         (emulator-only, already documented in emulator/README): on this multi-adapter
         machine the auto-detected playback host was wrong — first speak-text was never
         fetched; pinning `HE_HOST_IP=192.168.0.58` in settings.json → `env` fixed it
         ([EMU-AUDIO][SERVE] line is the tell). (TR `button-pressed` already verified in
         a real flow 2026-07-19)
24. [x] Emulator `discover` finds and correctly types PE vs Nabu Casa vs TR
         DONE 2026-07-30 (emulator console, real LAN): factory Nabu Casa PE
         (192.168.0.50) → 'pe' with the already-in-settings.json dedup flag; TR
         (192.168.0.56, "3RSPK-…") → 'tr' across multiple scans; Calex ESP8266
         plugs correctly never listed addable. The custom-firmware PE
         (192.168.0.52) has Noise encryption enabled — discover finds it via
         mDNS and correctly refuses the plaintext probe ("encrypted API is not
         supported", listed not-addable, documented emulator limitation); a
         direct keyed probe (real client + the device's PSK, Noise path) typed
         it 'pe' with 1/1/1 voice capabilities, so both PE firmware variants
         are verified in the same sniff branch. Fixed along the way: (1)
         `Logger.error()` appended a literal "null" to every detail-less error
         line (homey.error renders all args); (2) stale emulator README claim
         that the plaintext-only probe is "same as the app" (app has Noise
         since M2); (3) `ensureMicClosedChime` was never stubbed in the device
         harness tests — the real one writes to /userdata/audio, so the
         empty-transcript test passed or failed depending on whether that dir
         exists on the host (it started existing after this session's emulator
         runs). Now stubbed like its sibling and the test asserts the chime
         playback (second run_start/run_end pair) deterministically.
25. [x] **Upgrade path**: install this build over a real 1.4.0 — devices survive without
         re-pairing, new settings keys get sane defaults (especially what
         `initial_audio_skip` ends up as on *existing* devices after the 350→0 default
         change), provider still connects
26. [x] XiaoZhi pairing through Homey's real pairing UI DONE 2026-07-30 (owner tested
         on the real Homey before this session).
27. [x] Device tile: active timer name + time remaining shown; volume/mute changes from
         the Homey UI reach the satellite DONE 2026-07-30 (emulator, real factory PE at
         192.168.0.50): tile capabilities correct at every step — start-timer 65 "pasta"
         → timer_active=true / timer_name="pasta" / timer_remaining=62, counting down on
         the 1 s tick (57 five seconds later), cancel → false/0/"" — these are the values
         the tile binds to. Homey-UI direction verified by invoking the real capability
         listeners (`press`): volume_set 0.2 vs 0.7 audibly different on the PE
         (speak-text A/B), volume_mute true showed the PE muted (red) and false restored
         it; original volume restored after the test. Note: volume_set read null at boot
         (PE hadn't echoed its volume state yet) — cosmetic, values flow once set.
28. [x] Audio-file TTL cleanup on the Homey (serving/playback already verified implicitly)
29. [x] Internet drop mid-session (cloud providers) recovers DONE 2026-07-31 (emulator +
         real PE, REAL router-WAN pulls, scripted probe-every-25s harness — two runs).
         **Run 1 caught a real bug:** during the outage everything failed gracefully
         (clean errors, no crash, ESP + OpenAI reconnect campaigns with backoff), and the
         websocket + session reconfiguration recovered on their own — but every post-restore
         flow-card TEXT request timed out forever. Root cause: `sendSessionUpdate()` (the
         reconnect path) puts the SERVER in audio mode but didn't resync the client-side
         `outputMode` cache, so `setOutputMode("text")`'s early-return no-opped and the
         audio-mode session never sends the `text.done` the request waits on. Voice turns
         were unaffected. Fix: one-line cache resync in sendSessionUpdate
         (openai-realtime-agent.mts) + 2 regression tests
         (tests/openai-agent-output-mode.test.mts). **Run 2 (with fix): PASS** — probes
         failed cleanly during the pull, first probe after restore succeeded (t+189s,
         ~outage end + one backoff), RECOVERY CONFIRMED. (Satellite power-cycle side was
         already verified 2026-07-19.)
30. [x] **Build the custom-pipeline matrix-runner** DONE 2026-07-31:
         `emulator/matrix-runner.mts` + `matrix.example.json` (documented in
         emulator/README.md, incl. the docker one-liners for every LAN service). Reuses
         the stage-tester client builders (now exported), so it tests exactly what the
         settings Test buttons build. STT = reference clip (emulator/recordings/
         matrix-ref-en.wav, generated via OpenAI TTS) + word-score diff, streaming path
         included where the backend has one; LLM = plain round + two-round tool-call trip
         (call get_current_time, then use the fed-back result); TTS = fixed sentence +
         duration sanity + WAV saved to emulator/matrix-out/ for listening. Full run:
         **12/12 passed**. Spoken turns ran as four family combos through the emulator
         (`mic matrix-ref-en` — full VAD→STT→LLM→TTS→satellite turns on the real PE):
         A whisper/ollama/piper, B wyoming/ollama-v1/wyoming, C speaches/mistral/kokoro,
         D mistral-batch/mistral/kokoro — all with correct transcripts and tool
         execution. Gotcha found: `gpt-oss` crashes Ollama's llama-server on Windows
         (0xc0000409) — matrix uses qwen2.5:3b. One test-harness artifact: back-to-back
         mic turns in ONE session can interfere with the previous turn's still-playing
         announce — inject into a fresh/quiet session.
31. [x] STT: Whisper HTTP — matrix 2026-07-31 (onerahmet ASR docker :9000), 100%
         transcript + spoken turn (family A)
32. [x] STT: Wyoming faster-whisper — matrix 2026-07-31 (:10300 docker), 100% + spoken
         turn (family B)
33. [x] STT: Mistral Voxtral (batch) — matrix 2026-07-31, 92% (wrote "5" for "five") +
         spoken turn (family D)
34. [x] STT: Mistral Voxtral Realtime (streaming) — live-verified 2026-07-19; matrix
         2026-07-31 re-verified batch AND streaming paths, both 100%
35. [x] STT: OpenAI-compat — matrix 2026-07-31 (speaches :8000, faster-whisper-small),
         100% + spoken turn (family C)
36. [x] LLM: Ollama — matrix 2026-07-31 (qwen2.5:3b): plain + tool round-trip ok, and
         `local_llm_num_ctx` verified ACTUALLY APPLIED (`ollama ps` CONTEXT column =
         8192 after a chat; drops to Ollama's 4096 default via the /v1 endpoint, which
         has no num_ctx — expected). Closes the budget-meter half of item 22.
37. [x] LLM: LM Studio — live-verified 2026-07-19, model auto-pick from `/v1/models` OK
38. [x] LLM: Mistral — live-verified 2026-07-19; matrix 2026-07-31 re-verified tool trip
39. [x] LLM: OpenAI-compat — matrix 2026-07-31 (Ollama's /v1 endpoint as the compat
         server): plain + tool round-trip ok + spoken turn (family B)
40. [x] TTS: Piper HTTP — matrix 2026-07-31 (artibex/piper-http :5000), 4.0 s audio +
         spoken turn (family A)
41. [x] TTS: Wyoming Piper — matrix 2026-07-31 (:10200 docker), 2.6 s audio + spoken
         turn (family B)
42. [x] TTS: Mistral Voxtral TTS — live-verified 2026-07-19; matrix 2026-07-31
         re-verified (settings-page check closed under item 46)
43. [x] TTS: OpenAI-compat — matrix 2026-07-31 (kokoro-fastapi :8880, free-text voice
         override `af_bella` honored), 3.0 s audio + spoken turn (families C/D)
44. [x] Cross-cutting: streaming-STT batch fallback DONE 2026-07-31 (decision: covered).
         The fallback seam (stream.finish() throws → one batch transcribe of the
         VAD-kept clip) is deterministic in local-pipeline-provider.runAudioTurn and
         unit-tested ("falls back to batch STT when the streaming session fails");
         both the streaming and batch paths were verified live against real Mistral in
         the matrix. A literal mid-utterance socket kill needs network fault injection
         (admin firewall) — not reproducible in this environment, and the failure mode
         it would exercise is exactly the unit-tested catch.
45. [x] Cross-cutting: kill a stage mid-turn DONE 2026-07-31 (live, emulator + real PE,
         5/5): baseline turn ok → `docker stop matrix-piper-http` → turn errors
         gracefully (no crash/hang) → container restarted → next turn recovers →
         LLM port flipped to a dead 11435 → ask errors gracefully → port restored →
         "RECOVERED". Emulator process stayed healthy throughout.
46. [x] Cross-cutting: settings page DONE 2026-07-31 (real page in Chrome via the
         emulator's :8060 hosting): MIRRORED_INPUTS verified in BOTH directions with
         real keystrokes (typed into mistral_model_rt → pipeline field followed;
         typed into the pipeline field → _rt followed; load-sync also confirmed), and
         the Voxtral voice dropdown listed 30 live voices fetched with the saved key —
         every value a UUID ("Paul - Neutral (EN-US)" …), zero preset names. Piper
         backend correctly falls back to "Piper server voice" when the server has no
         /voices endpoint.
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
