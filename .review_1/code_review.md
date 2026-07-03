# Code review — no.arvebjoe.ai-voice-assistant

_Full-project review: correctness/bugs, organization, testability, and a security audit._
_Method: six parallel deep-dives (ESP pipeline, Homey device/driver layer, LLM provider layer, helpers/settings, security, test coverage). Every finding verified against source._

---

## What changed during the review (tests)

The suite was **red before the review**: 21 failing tests. `WeatherHelper.init()` now performs a
debug weather fetch, but `weather-helper.test.mts` primed its `fetch` mock *after* calling `init()`,
so every test threw in `beforeEach`. Fixed that, gated the live-network integration test behind
`RUN_INTEGRATION=1`, and loosened its lat/long assertion (Open-Meteo snaps to a model grid).

Added six new pure-logic test files (52 tests):

| File | Covers | Tests |
|---|---|---|
| `esp-messages.test.mts` | varint framing: encode/decode roundtrip, **partial-frame reassembly never throws**, multi-byte length, unknown id, byte accounting | 11 |
| `pcm16k-to-24k.test.mts` | resampler ratio, clamp, framing, sample-aligned chunk invariance, + a test pinning the odd-length byte-drop bug | 10 |
| `pcm-segmenter.test.mts` | silence-cut segmentation, feed-boundary invariance, + the short-reply drop bug | 7 |
| `audio-encoders.test.mts` | WAV header correctness, FLAC magic, frame-size/bit-depth guards | 7 |
| `settings-manager-pubsub.test.mts` | init idempotency, subscribe/notify/unsubscribe, snapshot isolation | 9 |
| `voice-provider-factory.test.mts` | provider selection, key resolution, unknown-id fallback | 8 |

**Suite now: 169 passing, 8 skipped (integration), 0 failing.** Two new tests deliberately assert
*current* buggy behavior (documented inline) so the bugs are pinned until fixed:
`pcm16k-to-24k` odd-length byte drop, and `pcm-segmenter` short-reply drop.

---

## Fixes applied (session 1 — easy wins)

Low-risk, high-confidence fixes made after the review. Build (`tsc`) clean; full suite green
(171 passing, 8 integration skipped). Product/UX decisions (S2/S3 tool gates, C1/C2 refactors)
were intentionally **not** touched.

- **H-i FLAC encoder leak** — `pcmToFlacBuffer` now releases the native encoder + its Flac-singleton
  listener in a guarded `finally`.
- **H-e `ws.close(1006)` crash** — replaced reserved code 1006 with app code 4000 and routed both
  call sites through a new `safeCloseSocket()` that can't throw out of the health-check interval.
- **H-a / H-b / H-c / H-d / M10 / S1 ESP RX robustness** — `decodeFrame` now returns `null` on
  incomplete varints (no throw) and rejects payloads > 1 MiB; `onTcpData` caps `rxBuf` at 2 MiB and
  wraps decode in try/catch, resetting the connection on corruption instead of wedging; `rxBuf` is
  cleared on every (re)connect; `lastMessageReceivedTime` is seeded in `onConnect()`.
- **H-j weather init non-fatal** — the debug fetch in `WeatherHelper.init()` is wrapped so a boot-time
  network failure no longer aborts app initialization.
- **S4 secret masking on the error path** — `Logger.error()` now runs `details` through `maskSecrets()`
  before writing to the Homey log.
- **L2 timer overflow guard** — `startTimer` rejects durations that would overflow the 32-bit
  setTimeout delay (~24 days) instead of firing instantly.
- **Cleanup** — deleted unused `src/helpers/polyfills.mts` and `src/llm/custom-instructions.mts`;
  removed a commented-out debug log line in `voice-assistant-device.mts`.

New tests added for the guards: oversized-payload/partial-varint (esp-messages) and the
timer-duration overflow (timer-manager).

## Fixes applied (session 2 — C1 & C2)

- **C2 OpenAI auto-reconnect** — reconnection is now driven by the websocket `close` event (guarded by
  `reconnectTimeoutId` against duplicates), so a *failed* reconnect attempt's own close schedules the
  next one instead of the campaign dying after attempt 1. `start()` resets `isManuallyClosing` (fixes
  M3: `close()`+`start()` no longer leaves reconnect disabled), and the dead `reconnected` emit (M1) is
  fixed by capturing the attempt count before it's reset. Regression test added.
- **C1 wake-death** — added `abortCurrentTurn()` that resets *all* turn state (isSteamingMic, isPlaying,
  hasIntent, announceUrls, peConversationActive, replyViaTtsUrl, continueConversation, emptyTurnRetries,
  replyPcm, resampler, segmenter, onoff). Wired to the provider `error`, **`close`** (the primary
  wake-death trigger — the agent idle-timeout close previously had no listener), and both `Unhealthy`
  handlers (agent + ESP). Added `PcmSegmenter.reset()` (discards buffered audio without emitting) and a
  test. Recovery from a mid-turn disconnect is now automatic — no PE power-cycle needed.

Build (`tsc`) clean; full suite green (174 passing, 8 integration skipped).

## Fixes applied (session 3 — H-h & H-k)

- **H-h zone changes / restart storm** — two parts. (1) `DeviceManager` now updates its tracked zone
  after firing the zone-change callback, so the flood of `device.update` events (which fire on any
  device change, including the app's own onoff writes) no longer re-fires the callback and restarts the
  provider mid-turn indefinitely. (2) Zone changes now actually reach the tools: added
  `ToolManager.setStandardZone()`/`getStandardZone()` and both providers' `updateZone()` now call it, so
  `get_devices_in_standard_zone` targets the device's new room instead of the room it booted in.
- **H-k pairing probe hijack** — added an immutable `isDiscoveryProbe` flag (separate from the mutable
  `discoveryMode` sniff latch); a probe connection no longer sends `SubscribeVoiceAssistantRequest` /
  `SubscribeStatesRequest`, so pairing a new satellite can't steal an already-paired device's voice
  subscription. Identification still works — the capability counts come from the ListEntities/DeviceInfo
  phase, not the subscription.

New tests: real `DeviceManager` zone-change handler (5 cases incl. the storm fix — first real coverage
of that module) and `ToolManager` standard-zone. Build clean; full suite green (182 passing).

## Fixes applied (session 4 — H-l & M2)

- **H-l reply audio out-of-order** — the announce-path `chunk` handler (async FLAC encode + serve +
  play) now runs through a per-device promise chain (`announceChain`), so segments emitted back-to-back
  play in strict FIFO order instead of racing on encode time. Extracted the body into
  `playReplyChunkAnnounce()`. The in-band branch stays synchronous (it must complete before the `done`
  handler reads `replyPcm`). Added a `replyGeneration` counter, bumped in `abortCurrentTurn()`, so a
  segment queued before an abort can't play after it.
- **M2 in-band reply files leaked** — the in-band `done` path built a FLAC and served it but never
  scheduled deletion (only the announce path did), leaking one file per conversation turn onto
  `/userdata` until restart. Now calls `scheduleAudioFileDeletion()`, and that helper gained an optional
  `extraMs` (passed the reply's playback length) so a long reply isn't deleted mid-stream.

New test: `file-helper-deletion` (TTL math incl. the extraMs extension and env override). H-l is
verified by build + reasoning (unit-testing it needs a full device harness, same as H-k). Build clean;
full suite green (186 passing).

## Fixes applied (session 5 — M3 & M4)

- **M3 `onSettings` read stale values** — it recomputed the audio-skip byte counts from
  `this.getSettings()`, which returns the OLD values inside `onSettings` (the SDK persists after it
  resolves), so every save applied the *previous* save's numbers. Now reads from the `newSettings`
  parameter, and treats `initial_audio_skip = 0` as a deliberate value (only null/undefined = unset).
- **M4 runtime `voice_provider` switch ignored** — switching provider did nothing until an app restart.
  Added `rebuildProvider()`: it tears down the old provider (destroy/close + removeAllListeners), builds
  the newly-selected one (the factory resolves that provider's own API key), re-matches the resampler to
  its input rate (OpenAI 24 kHz vs Gemini 16 kHz — `configureResampler()` now also *clears* the
  resampler for a 16 kHz passthrough provider), re-wires the handlers, and connects.
  `handleSettingsChange` detects the change and calls it. To make the handlers re-attachable, the ~15
  provider event handlers were extracted verbatim from `onInit` into `wireProviderEvents()` (esp/segmenter
  handlers stay inline — those emitters are created once). Verified all 15 handlers appear exactly once.

M3/M4 are verified by build + full suite + handler-count check; unit-testing them needs a full
`VoiceAssistantDevice` harness (same gap as H-k/H-l). Build clean; full suite green (186 passing).

## Fixes applied (session 6 — device test harness)

Built the `VoiceAssistantDevice` unit-test harness the earlier sessions kept deferring. It boots the
**real** device (real `onInit`, real event handlers, real `PcmSegmenter`/`ToolManager`/`TimerManager`)
with faked transport and app singletons, so conversation-flow logic is drivable with zero network.

- `tests/mocks/mock-homey-sdk.mts` — self-contained fake `homey` package (Device/App/Driver base),
  no config/settings.json reads (unlike the emulator shim), `this.homey` injected via constructor.
- `tests/mocks/mock-esp-client.mts` — fake `EspVoiceAssistantClient`: records every protocol call and
  lets a test emit device-facing events (`starting`, `chunk`, `silence`, `Unhealthy`, …).
- `tests/mocks/mock-voice-provider.mts` — fake provider + `createVoiceProvider` with an instance
  registry so a runtime rebuild is assertable.
- `tests/mocks/device-harness.mts` — assembles the fakes + fake app singletons and runs `onInit`.
- `tests/voice-assistant-device.test.mts` — 10 tests now covering the previously-untestable fixes:
  **C1** (turn state resets on ESP drop / agent close / and a new wake is accepted afterwards; the
  duplicate-wake guard still holds), **H-l** (segments play in emit order even when the first encodes
  slower; the queued segment plays on `announce_finished`), **M3** (onSettings applies `newSettings`,
  and `0` is a deliberate no-skip), **M4** (provider rebuilds on `voice_provider` change, old one torn
  down; no rebuild when unchanged).

Confirmed the harness catches regressions: reverting the H-l serialization makes its two tests fail
(segment 2 plays before segment 1), and restoring it makes them pass. Remaining unit-test gap: **H-k**
(pairing probe) lives in the ESP client's handshake, which needs a fake `net` socket rather than this
device harness. Build clean; full suite green (196 passing).

## Fixes applied (session 7 — fake-WebSocket provider harness)

Built the provider-level counterpart to the device harness so the OpenAI Realtime provider's logic is
testable offline — previously it needed a live key, so those integration tests passed *vacuously*.

- `tests/mocks/mock-ws.mts` — fake `ws` WebSocket (records everything sent; drivers for
  open/message/error/close; instance registry for reconnect assertions; optional strict close-code
  validation like the real `ws`).
- `tests/openai-realtime-provider.test.mts` — 7 tests via `vi.mock('ws', …)`: missing-api-key (no
  socket), session.created → session.update → open, base64 audio-delta decode, **response.done
  suppression on tool-call turns vs. emission on normal turns**, malformed-JSON message is ignored (no
  crash), full **tool execution** (function_call → handler → function_call_output + response.create fed
  back), and **C2** (the reconnect campaign keeps scheduling after repeated failed attempts).

Confirmed teeth: reverting the C2 close-handler fix makes its test fail (`expected 2 to be 3` — the
campaign dies after the first failed reconnect); restoring it passes. This retroactively covers the
provider findings that were previously build+reasoning only (C2, response.done-suppression, tool
execution, JSON-parse safety). Build clean; full suite green (203 passing).

Follow-up: the older key-gated integration tests (`openai-connection-test`, `openai-agent-behavior`,
`smart-home-agent`) were converted from vacuous early-return passes to `describe.skipIf(!hasValidApiKey)`,
so without a key they now report as **skipped** rather than falsely green (7 tests). Their logic is
covered offline by the harness above; they remain as real-API smoke tests when a key is present.

## Fixes applied (session 8 — Gemini provider harness)

Built the fake-SDK counterpart for the Gemini Live provider (`@google/genai` uses a callback-based
`ai.live.connect(...)` session rather than raw `ws`).

- `tests/mocks/mock-genai.mts` — fake `GoogleGenAI` + `Modality`: `live.connect` records each session
  and exposes drivers (`__open`/`__message`/`__error`/`__close`) plus `sendRealtimeInput` /
  `sendClientContent` / `sendToolResponse` / `close` capture; `failNextConnect` to simulate a failed
  connect.
- `tests/gemini-live-provider.test.mts` — 9 tests via `vi.mock('@google/genai', …)`: missing-api-key,
  open→`open`+`Healthy`, base64 audio-delta decode, output-transcription → `transcript.delta`,
  `turnComplete` → `response.done`, tool execution → `sendToolResponse` (with the handler result),
  odd/empty message doesn't crash, reconnect campaign continues after repeated drops, and no reconnect
  after a manual `close()`.

Build clean; full suite green (205 passed, 15 skipped, 220 total).

## Fixes applied (session 9 — H-f & H-g)

The last two unclaimed high-severity findings — both "socket dies at the wrong moment → crash":

- **H-g `sendAudioChunk` throws on a closed socket** — now honors the seam's no-throw contract
  (documented explicitly on `IVoiceProvider.sendAudioChunk` too): on a dead socket it kicks the
  reconnect campaign (via a new `requestReconnect()`, extracted from `assertOpen`) and silently
  drops the frame, matching the Gemini implementation. The device's per-mic-frame call is safe again.
- **H-f unhandled rejection when the socket closes during tool execution** — `maybeExecuteTool`'s
  old error path called `sendFunctionResult` *inside its own catch*, so a closed socket rethrew and
  escaped. Restructured into two phases: run the tool (its own try/catch produces either the result
  or a structured `{error}`), then feed the result back + `createResponse` inside a guarded block
  that logs instead of rejecting. Also fixed the systemic hole: the ws `message` handler invoked the
  async `onMessage` fire-and-forget, so *any* throw in a server-event handler was an unhandled
  rejection — now caught and logged at the call site.

New tests (fake-ws harness): H-g drop-and-reconnect, H-f socket-close-mid-tool (asserts zero
`unhandledRejection`s), and throwing-tool-handler → structured error fed back with error
instructions. Build clean; full suite green (208 passing, 15 skipped).

## Fixes applied (session 10 — M8 & M7)

- **M8 Gemini emits `response.done` on tool-call turns** — ported the OpenAI-side suppression:
  a `toolCall` message sets `pendingToolTurn` (synchronously, so a `turnComplete` in the same
  message is covered) and that turn's `turnComplete` is swallowed — the continuation after
  `sendToolResponse` carries the real one. Defensive against both server timelines: if the server
  *doesn't* send a `turnComplete` for the tool-call turn, the first model output after the tool
  response clears the flag so the single real `turnComplete` isn't swallowed
  (`markToolContinuation`, gated on `toolResponseSent` so pre-tool speech doesn't count). A failed
  `sendToolResponse` and a barge-in (`interrupted` → `endTurn`) also clear it.
- **M7 `emitGlobals` per-subscriber error isolation** — each subscriber callback is now wrapped in
  try/catch (logged), so one throwing device no longer stops the rest from seeing a settings
  update — nor throws back into Homey's settings `set` emitter. The initial-snapshot call in
  `onGlobals` got the same guard (same failure class: a throwing subscriber used to break the
  subscribe call itself and lose the unsubscribe handle).

New tests: two M8 cases in the Gemini fake-SDK harness (suppress-then-emit, and the
no-tool-turn-turnComplete timeline) and an M7 bad-subscriber case in the pub/sub suite. Build
clean; full suite green (211 passing, 15 skipped).

---

## Critical bugs

### C1. "Wake-death": conversation state never resets on disconnect
`src/homey/voice-assistant-device.mts` (flags set false only at `:404` silence, `:729` provider error)
`isSteamingMic` is cleared in only two handlers. If the PE drops TCP mid-listen (Wi-Fi blip, reboot),
the OpenAI session idle-times out and emits `Unhealthy`/`close` — neither resets any turn flag.
`isSteamingMic` stays `true` forever, so every later wake hits the "duplicate wake" guard (`:241`) and
is silently dropped. Matches the known "recovery = power-cycle PE" symptom. Same for `isPlaying` +
`announceUrls`. **Fix:** an `Unhealthy`/`close` handler that aborts the turn (reset all flags, clear
`announceUrls`, reset segmenter, `setCapabilityValue('onoff', false)`).

### C2. OpenAI auto-reconnect dies after the first failed attempt
`src/llm/providers/openai-realtime-agent.mts:226, 972, 988-1005`
`scheduleReconnect()` sets `isReconnecting=true`, only cleared in the `open` handler. `start()` never
rejects on connection failure (the `WebSocket` ctor succeeds; failure arrives later as async `close`),
so the re-schedule path never runs and the `close` handler is gated out by `isReconnecting`. A
5-second internet blip takes the agent permanently offline. `maxReconnectAttempts = Infinity` is an
illusion — the real max is 1. Gemini's reconnect is correct (it awaits `live.connect`).

---

## High-severity bugs

### Robustness / crashes
- **H-a. Unbounded RX buffer + no frame-length cap** — `src/voice_assistant/esp-messages.mts:98-136`,
  `esp-voice-assistant-client.mts:320-355`. A hostile/spoofed LAN peer sends a header advertising a
  huge `payloadLen` and dribbles bytes; `rxBuf` grows without limit → memory exhaustion → whole app
  down. (Also the top security finding — see S1.)
- **H-b. Unguarded protobuf decode** — `esp-messages.mts:126-127`. A malformed frame makes
  `entry.type.decode` throw; `onTcpData` has no try/catch, `rxBuf` is never advanced, and every
  subsequent packet re-throws → that device's pipeline is permanently wedged.
- **H-c. Truncated varint across TCP chunks throws** — `esp-messages.mts:109,116`. Any audio frame
  ≥128 bytes has a 2-byte length varint; a TCP segment boundary between the two bytes → unhandled
  rejection (fatal on modern Node).
- **H-d. `rxBuf` never cleared on reconnect** — `esp-voice-assistant-client.mts` `start()`/
  `handleDisconnect()`. A stale half-frame desyncs the new session → no frame ever decodes → zombie
  connection (also defeats the health check, which requires `lastMessageReceivedTime > 0`).
- **H-e. `ws.close(1006, …)` throws** — `openai-realtime-agent.mts:1025,1033`. 1006 is a reserved code
  `ws` v8 refuses to send; called from a `setInterval` health check with no guard → the recovery path
  crashes the app.
- **H-f. Unhandled rejection when the socket closes during tool execution** —
  `openai-realtime-agent.mts:793-815, 911-928`. `maybeExecuteTool` catch → `sendFunctionResult` →
  `assertOpen()` throws. "Turn on the lights" + Wi-Fi drop mid-execution → crash.
- **H-g. `sendAudioChunk` throws on a closed socket** — `openai-realtime-agent.mts:389-408` vs the
  device calling it unguarded per mic frame (`voice-assistant-device.mts:363`). The `IVoiceProvider`
  seam has an implicit no-throw contract only Gemini honors.

### Correctness
- **H-h. Zone changes never reach the tools.** `device-manager.mts:47-63` compares against a cached
  zone snapshot it never updates, so `device.update` (fires on *every* capability change, incl. the
  app's own `setCapabilityValue('onoff')` each session) re-fires the zone-change callback endlessly →
  `provider.restart()` kills sessions mid-turn. Separately `ToolManager.standardZone` is frozen at
  construction and `updateZone()` is a functional no-op → moving a device between rooms silently
  controls the wrong room.
- **H-i. FLAC encoder leak** — `audio-encoders.mts:120-158`. `encoder.destroy()` is never called, so
  every spoken segment leaks a native encoder + a listener on the shared `Flac` singleton → unbounded
  heap growth → eventual OOM.
- **H-j. Weather outage at boot crashes app init** — `weather-helper.mts:126` + `app.mts:47`.
  `init()` awaits `getCurrentWeather()`, which rethrows — before `WebServer`/`DeviceManager` are
  constructed. No internet at reboot = no app.
- **H-k. Pairing probe hijacks in-use satellites** — `voice-assistant-driver.mts:212-235` + esp client
  `:449-456`. Discovery runs a full `start()` that unconditionally sends
  `SubscribeVoiceAssistantRequest`, stealing the voice subscription from an already-paired active
  device until its connection cycles ("blue→red LEDs during discovery"). Should not subscribe in
  `discoveryMode`.
- **H-l. Reply audio can play out of order** — `voice-assistant-device.mts:494-552`. The segmenter
  `chunk` handler is `async` and awaits FLAC encode; concurrent invocations race, so a short later
  chunk can play before a slow earlier one.

---


## Notable medium/low bugs

- **M1. Short replies produce no audio** — `pcm-segmenter.mts:49-60,124-132`. `flush()` routes the
  tail through the same `MIN_CHUNK` guard, so a sub-600ms reply ("Ja?") is dropped while `done` still
  fires. Likely part of ongoing conversation-flow debugging. (Pinned by a new test.)
- **M2. In-band reply FLAC files never deleted** — `voice-assistant-device.mts:691-698`. Disk leak on
  `/userdata` until app restart. Announce-path files are fine (`:927-930`).
- **M3. `onSettings` reads old values** — `voice-assistant-device.mts:1216-1232` uses
  `this.getSettings()` instead of the `newSettings` param → audio-skip tuning silently doesn't apply
  until the next save.
- **M4. Switching `voice_provider` at runtime is ignored** — factory reads it once in `onInit`
  (`voice-assistant-device.mts:211`); `handleSettingsChange` never re-inspects it and checks the old
  provider's key.
- **M5. Forecast cache ignores the `days` arg** — `weather-helper.mts:204-213,336-381`. "Will it rain
  in 10 days?" with a 7-day forecast returns hour-168 data as the day-10 answer.
- **M6. Open-Meteo timestamps parsed in the server tz**, not the location's — `weather-helper.mts:469`.
- **M7. `emitGlobals` has no per-subscriber error isolation** — `settings-manager.mts:173-176`. One
  throwing device stops others from getting settings updates.
- **M8. Gemini emits `response.done` on tool-call turns** — `gemini-live-provider.mts:325-328`, the
  same bug the OpenAI side fixed.
- **M9. Audio file deletion is a fixed 30s TTL from playback start** — `file-helper.mts:47-59`. Long
  files / late PE re-fetch → 404 mid-playback.
- **M10. Health check can't detect a zero-frame connection** — `esp-voice-assistant-client.mts:222`
  requires `lastMessageReceivedTime > 0`. Seed it in `onConnect()`.

### Low / cleanup
- Hardcoded Norwegian hallucination sentinel `"undertekster av ai-media"` duplicated in
  `voice-assistant-device.mts:440` and `openai-realtime-agent.mts:637`; other languages unfiltered.
- Debug leftover: commented-out `//this.logger.error('Mute test2', …)` at `:751`; empty
  `esp.on('started')` at `:324`; stale TODO at `:407`.
- Dead code: `src/llm/custom-instructions.mts` (unused, wrong signature), `src/helpers/polyfills.mts`
  (unused; Blob/File are global in Node 18/20), `pcmToWavBuffer` (unused outside tests), several
  GeoHelper methods, unused OpenAI-only public methods (`setAudioToTextMode`, `getOutputMode`,
  `forceReconnect`, …), never-emitted seam events (`connected`, `input_audio_buffer.committed`).
- Loggers constructed `disabled=true` in device-manager/weather/geo/webserver/file-helper — `warn()`
  routes through `info()` so diagnostics for the bugs above are invisible.
- `timer-manager.mts:156` — `durationSeconds*1000` overflows 32-bit setTimeout for >~24.8 days →
  fires instantly. Add a max-duration guard next to the `<= 0` check.
- FLAC 8-bit path (`audio-encoders.mts:109-116`) is internally inconsistent (dead in practice).
- Resampler drops the trailing byte of odd-length chunks (`Pcm16kTo24k.mts:47-50`) — latent, pinned
  by a test.
- `webserver.mts` isn't a server (only builds URLs); `this.ip` cached once → DHCP change breaks URLs.

---

## Organization & testability

Architecture is fundamentally sound — the ESP/device/provider/tool layering is clean, `TimerManager`
is exemplary (injected deps, drift-free `endAt` math, guarded callbacks, unit-testable as-is), the
audio helpers are pure state machines. Three structural problems drive most of the bugs above:

1. **`voice-assistant-device.mts` (1300 lines) has no explicit state machine.** ~15 flags mutated from
   eight anonymous closures inside a 670-line `onInit`; every abort path forgets a different subset of
   flags — the direct cause of C1 and the barge-in bug. Extract a `TurnStateMachine` with named states
   (IDLE, LISTENING, THINKING, SPEAKING_*, ABORTED) and one `abort()`, plus an `AudioOutputPipeline`
   (segmenter + encode + serialized queue → fixes H-l and unifies file TTL → fixes M2).
2. **The two providers have drifted into divergent copies of the same machinery** — reconnect, tool
   execution, instruction loading are each triplicated, and in each case one copy is correct and the
   other buggy (C2, M8). Extract a shared `ReconnectPolicy`, move `ToolManager.execute()` into the
   tool manager, share an `InstructionState` with an awaited `ready()`.
3. **`DeviceManager` conflates three roles** and relies on object identity surviving `fetchData()`
   rebuilds — the root of H-h. Store MAC→callback and resolve the device fresh per event.

Also: replace the four `(this.homey as any).app.webServer` reaches with a typed accessor; add
`@vitest/coverage-v8` (currently `npm run test:coverage` fails on the missing dep).

---

## Recommended next steps (priority order)

1. Bound the ESP RX buffer + wrap decode in try/catch (closes the only unauthenticated
   network-reachable crash/DoS: H-a, H-b, H-c, S1).
2. Add the disconnect/`Unhealthy` turn-abort to kill wake-death (C1).
3. Fix the OpenAI reconnect flag (C2) and the `ws.close(1006)` throw (H-e).
4. Call `encoder.destroy()` in `pcmToFlacBuffer` (H-i).
5. Make `weatherHelper.init()` non-fatal (H-j).
6. Enforce the tool safety caps in code (S2/S3).
