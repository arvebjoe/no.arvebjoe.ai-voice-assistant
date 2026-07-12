# Code review 2

**Repository:** `arvebjoe/no.arvebjoe.ai-voice-assistant`  
**Reviewed commit:** `0a64afa614f779380aa52660d5662dbdd52ea8e9` (`main`)  
**Review date:** 2026-07-12  
**Scope:** application and driver code, provider implementations, ESPHome/Wyoming transports, settings/API UI, helper integrations, tests, package manifest and lockfile.

## Executive summary

The codebase is substantially safer and better tested than the state described at the end of `code_review_1.md`. In particular, the ESP frame size guard, reconnect cleanup, secret masking, capability-write whitelist, single-lock unlock restriction, runtime provider rebuild and output-pipeline generation guard are all present.

This review still found **4 high**, **7 medium**, and **5 low** priority issues. The most important correctness problem is that a settings save emits many independent updates which run asynchronous provider rebuild/restart logic concurrently. The most important security problem is the lack of a trust boundary between web-search output and state-changing smart-home tools, including single-door unlock. The most important availability problem is that weather requests have no timeout and one is awaited during application startup.

Recommended order:

1. Serialize/debounce settings application and provider lifecycle operations (H1).
2. Add a request queue/correlation to text Flow requests (H2).
3. Put timeouts on all weather fetches, especially the startup fetch (H3).
4. Add a code-enforced confirmation/authorization boundary for unlocking and isolate untrusted web content (H4).
5. Bound Wyoming frames/queues and add ESPHome Noise encryption support (M1/M2).

## Method and verification

- Reviewed the repository at one immutable commit rather than mixing moving `main` revisions.
- Traced initialization, settings updates, device/provider lifecycles, voice turns, tool execution, audio-file serving, discovery and reconnect paths.
- Reviewed external-input boundaries: settings API, LLM tool calls, ESPHome TCP, Wyoming TCP, WebSockets, HTTP responses and the settings webview.
- Compared findings against `docs/code_review_1.md` and did not re-report issues that are demonstrably fixed.
- Ran `npm audit --package-lock-only --omit=dev` against the checked-in lockfile: 8 production-tree advisories (0 critical, 0 high, 6 moderate, 2 low).
- Full build/test execution was not possible in the review workspace because `npm ci` could not materialize the dependency tree there (the git-sourced `raven`/npm cache path failed). This is a review-environment limitation, not evidence that the repository build fails.

## High priority

### H1 — Settings saves race provider rebuilds and restarts

**Evidence**

- `settings/index.html:1641-1731` issues more than twenty independent asynchronous `Homey.set(...)` calls from one click. They are neither awaited nor grouped.
- `src/settings/settings-manager.mts:105-111` immediately publishes a complete snapshot for every individual key update.
- `src/homey/voice-assistant-device.mts:110-113` invokes async `handleSettingsChange()` from a synchronous subscriber without awaiting or serializing it.
- `src/homey/voice-assistant-device.mts:813-938` mutates shared `provider`, `providerOptions`, tool registration and instruction state. It may call `rebuildProvider()` and then calls `this.provider.restart()` without awaiting it at line 932.
- `src/llm/providers/local-pipeline-provider.mts:398-431` independently subscribes to the same update stream, swaps all three clients, and fire-and-forgets `start()`.

**Impact**

One Save can start overlapping `close -> delay -> start`, health checks, instruction reloads and provider replacement. A late continuation can operate on a provider which another update has already destroyed, or a restart for an older snapshot can finish after a newer one. Symptoms will be intermittent: duplicate connections, transient unavailable state, stale tools/credentials, dropped turns and unhandled rejections.

**Recommendation**

- Store settings as one versioned object or add an explicit `saveSettings()` API which validates and commits one snapshot.
- At minimum debounce snapshots and process them through a single per-device promise queue/mutex.
- Give provider lifecycle operations a generation token; a superseded generation must not publish state or reconnect.
- Await `restart()` and make rebuild/restart mutually exclusive.
- Add a test which saves provider, key, voice, language, endpoints and feature gates concurrently and asserts exactly one final provider is alive with the final snapshot.

### H2 — Concurrent “ask as text” Flow calls receive the wrong response

**Evidence**

- `src/homey/voice-assistant-device.mts:1055-1086` attaches `provider.once('text.done', ...)` for each request, but there is no request ID or queue.
- Two pending listeners therefore both consume the first `text.done` event and resolve with the same answer; the second real answer is orphaned.
- `src/llm/providers/local-pipeline-provider.mts:605-680,719-727` also allows concurrent `respond()` calls to mutate the same `messages` array and `turnAbort` field.
- `src/llm/providers/gemini-live-provider.mts:423-459` emits the same uncorrelated event after an independent async request.

**Impact**

Two Flows, an emulator request plus a Flow, or a retry within 30 seconds can cross-wire answers. In the local provider, histories and tool results may also interleave, producing answers based on the other caller's question.

**Recommendation**

Either enforce one text request per device with a FIFO queue, or change the provider seam to `requestText(question, requestId): Promise<string>` and correlate completion/error by ID. Do not use a shared broadcast event as an RPC response.

### H3 — Weather HTTP calls can hang app startup and tool turns indefinitely

**Evidence**

- `src/helpers/weather-helper.mts:184`, `:261`, and `:327` call `fetch()` without an `AbortSignal`.
- `WeatherHelper.init()` awaits `getCurrentWeather()` at `:126-134`.
- `app.mts:49-51` awaits `weatherHelper.init()` before the web server, Homey API and device manager are initialized.

**Impact**

A stalled TCP/TLS connection or response body can leave the app initialization pending, preventing every voice device from coming online. The same problem can keep a weather tool call and the active voice turn open indefinitely.

**Recommendation**

Use a shared bounded fetch helper (for example 10-15 seconds with `AbortSignal.timeout`) and validate/limit response size. Do not await the diagnostic weather prefetch on the critical startup path; start it in the background with a caught failure.

### H4 — Web content can influence state-changing tools, including unlocking a door

**Evidence**

- `src/helpers/web-search.mts:89-111` returns third-party Brave titles and snippets verbatim to the main model.
- The main model retains all tools after the search, including `set_device_capability`.
- `src/llm/tool-manager.mts:1226-1233` intentionally permits unlocking one device with no code-enforced confirmation.
- The system prompts describe how to unlock but contain no instruction that web/tool output is untrusted and must never authorize actions.

**Impact**

This creates an indirect prompt-injection path: attacker-controlled indexed content can instruct the model to make a subsequent smart-home write. The multi-lock guard limits blast radius but does not protect one physical lock, one heater, or smaller groups of devices. Prompt wording alone is not a reliable authorization boundary.

**Recommendation**

- Require a fresh, explicit user confirmation for `locked=false`, enforced in code with a short-lived confirmation token bound to device ID and requested action.
- Consider requiring confirmation for other safety-relevant writes (heating, garage/door classes) and make policy configurable.
- Mark search/tool output as untrusted data in every provider prompt and prohibit tool calls based solely on that data.
- Prefer a two-phase tool architecture: read/search phase, then a policy/authorization gate before writes.
- Add adversarial tests where Brave results and other tool outputs contain fake system instructions and tool-call requests.

## Medium priority

### M1 — Wyoming framing permits memory denial of service

**Evidence**

- `src/llm/providers/local/wyoming-protocol.mts:36-38` concatenates every received chunk.
- `:142-145` trusts `data_length` and `payload_length` without finite, non-negative or maximum checks.
- The event queue at `:29` is also unbounded.

**Impact**

A compromised/misconfigured LAN service can advertise a huge frame and make the Homey process retain incoming bytes while waiting for it. Negative/non-finite lengths can desynchronize parsing. A fast stream of events can also grow the queue. This is especially relevant because settings can point the client at an arbitrary host.

**Recommendation**

Reject invalid lengths and cap the header line, extra JSON, payload, aggregate receive buffer and queued event count. Destroy the connection on violation. Add tests for huge, negative, fractional and non-numeric lengths and a header with no newline.

### M2 — ESPHome control/audio transport is plaintext and unauthenticated

**Evidence**

- `src/voice_assistant/esp-messages.mts:65,118-122` always emits plaintext native-API frames.
- `src/voice_assistant/esp-voice-assistant-client.mts:459-475` uses an empty legacy password and has no Noise handshake.
- The repository's own `COMPLETED.md:370-371` records Noise encryption as intentionally deferred.

**Impact**

Anyone able to intercept or inject traffic on the LAN can observe microphone/control traffic, impersonate a satellite, change volume/playback, or feed crafted frames. Device discovery identity is descriptive text, not authentication. Devices configured with an ESPHome encryption key cannot connect at all.

**Recommendation**

Implement the ESPHome Noise protocol and store per-device keys in the device store/settings. Make encrypted pairing the default, clearly label plaintext as legacy/insecure, and bind identity to the authenticated key rather than manufacturer/name substrings.

### M3 — A stale Music Assistant socket can fail commands on a new socket

**Evidence**

- `src/helpers/music-assistant-client.mts:153-160` closes the old socket and immediately allows a replacement.
- The old socket's `close` handler at `:230-238` conditionally clears `this.ws`, but calls `failAllPending(...)` unconditionally.

**Impact**

If configuration changes and a new command connects before the old socket's delayed `close` event, that stale event rejects commands belonging to the new socket.

**Recommendation**

Only fail pending commands owned by the socket which closed. Associate each pending command with a connection generation/socket, or return early when `this.ws !== ws`. Add a deterministic old-close-after-new-connect test.

### M4 — Audio directory initialization races the first playback

**Evidence**

- `app.mts:44` calls `initAudioFolder()` without awaiting it.
- `src/helpers/file-helper.mts:8-20` asynchronously creates the directory and then deletes every entry.

**Impact**

An early playback can write before the directory exists, or its newly written file can be deleted by the still-running startup cleanup. The latter produces a valid URL which returns 404 to the satellite.

**Recommendation**

Await initialization before exposing services/devices. For extra safety, delete only files older than the current startup timestamp and use `rm(..., { force:true })`/file-type checks.

### M5 — Stage-test API is an authenticated SSRF/network-scanning primitive

**Evidence**

- `api.mts:30-32` passes the posted body directly to `testLocalStage()`.
- `src/llm/providers/local/stage-tester.mts:69-97` constructs clients from arbitrary `host`, `port`, and `url` values.
- A test performs both a health request and a real STT/LLM/TTS request, potentially sending supplied content/credentials.

**Impact**

Anyone who gains access to the app's authenticated settings API can probe arbitrary LAN services and HTTP(S) endpoints from Homey's network position. This is not unauthenticated remote SSRF, but it increases the impact of a compromised Homey admin/browser session.

**Recommendation**

Validate body size/types, ports and URL schemes; reject credentials in URLs; block loopback, link-local and cloud metadata ranges unless explicitly needed; and add rate limiting. If arbitrary LAN endpoints are a product requirement, document this privileged capability and require a recent settings-page nonce.

### M6 — Production dependency tree contains known vulnerable legacy chains

`npm audit --package-lock-only --omit=dev` reported 8 findings:

- Moderate ReDoS in `parseuri@0.0.6`, reached via `homey-api@3.19.1` -> legacy `socket.io-client@2.5.0` / `engine.io-client@3.5.x`.
- Moderate legacy `uuid@3.0.0` issue plus a low `cookie@0.3.1` issue, reached through `homey-log@2.1.2` -> git-sourced `raven@2.6.2`.
- No critical or high audit findings.

Exploitability appears limited in current usage (`HomeyAPI.createAppAPI` supplies its own endpoint, and the vulnerable Raven UUID APIs are not called directly), but the chains are old and some have no automatic fix.

**Recommendation**

Ask Athom for supported `homey-api`/`homey-log` releases without the legacy Socket.IO and Raven chains. Do not apply npm's suggested downgrade blindly. Add a CI audit policy that records accepted transitive exceptions with reachability/rationale and fails on new high/critical findings.

### M7 — Provider start/restart contracts are inconsistent and failures are often fire-and-forgotten

**Evidence**

- OpenAI `start()` resolves after registering WebSocket handlers, before connection/session readiness (`src/llm/providers/openai-realtime-agent.mts:232-318`).
- Local `start()` resolves only after all health probes (`src/llm/providers/local-pipeline-provider.mts:436-476`).
- Several call sites discard returned promises: device zone callback (`voice-assistant-device.mts:123-128`), settings restart (`:931-933`), and local settings health recheck (`local-pipeline-provider.mts:428-431`).

**Impact**

Callers cannot know whether `await start()` means “attempt initiated” or “ready”. Rejections from restart/reload paths can become global unhandled rejections, and lifecycle races are hard to test.

**Recommendation**

Define explicit `connect(): Promise<void>` readiness semantics plus a separate non-throwing reconnect scheduler. Await or intentionally `void ...catch(...)` every promise. Centralize lifecycle state (`stopped/connecting/ready/closing`) in the provider seam.

## Low priority / maintainability

### L1 — Core classes remain too large and weakly typed

`voice-assistant-device.mts` is 1,426 lines, `tool-manager.mts` 1,416, and `esp-voice-assistant-client.mts` 1,075. Production TypeScript contains roughly 323 `any` occurrences. These files mix protocol, state machine, UI/Flow integration, authorization policy and feature-specific business logic.

Split tools by feature with a registry/policy layer; split ESP transport/framing/handshake/entities/voice session; and make the device an orchestrator over typed services. Replace `any` first at trust boundaries (API bodies, provider events, Homey API responses and protocol frames).

### L2 — Settings UI has no transactional completion or reliable success state

`settings/index.html:1641-1737` launches independent saves, displays errors per callback, never waits for all writes, and uses a fixed 500 ms delay before refreshing voices. Partial persistence is possible and the refresh can race a slow write. Wrap callback APIs in promises, `await Promise.all`, disable Save while pending, show one final result, and refresh from the committed snapshot.

### L3 — Pairing uses 10 ms polling and leaves timeout callbacks behind

`src/homey/voice-assistant-driver.mts:212-231` wraps an async executor in `new Promise`, polls `done` every 10 ms, and does not clear the 5-second timeout after early completion. Four probes can create thousands of timer callbacks. Resolve directly from `finish()` and hold/clear one timeout.

### L4 — PCM segmenter contains dead/inconsistent split logic

`src/helpers/pcm-segmenter.mts:134` calculates `preStart` but never uses it. The next segment instead starts with `remainderForNext`, which can preserve more leading silence than the documented 60 ms pre-pad. Either implement the intended windowing and test exact boundaries, or remove the dead variable/comment.

### L5 — Global process and SDK listeners have no symmetric teardown

`app.mts:81-102` installs three anonymous `process` listeners, while `onUninit()` only calls an empty `WebServer.stop()`. `GeoHelper` and `DeviceManager` also register SDK listeners without dispose methods. A same-process app reinitialization/test reset can duplicate handlers and retain objects. Store callbacks and remove them in `onUninit`; give shared services explicit `dispose()` methods.

## Test gaps to add

The existing suite is broad and covers many fixes from the first review. The remaining risk clusters need targeted tests:

1. One settings Save producing many out-of-order `set` events; assert serialized application and one live provider.
2. Two simultaneous text Flow requests, including one timing out and one succeeding.
3. Weather connect/body stall and startup continuing after timeout.
4. Prompt-injected Brave/tool output attempting to unlock or write capabilities.
5. Wyoming oversized/negative lengths, no-newline header, queue flood and close during `waitFor()`.
6. Music Assistant old socket closing after the new socket has pending commands.
7. Audio folder cleanup concurrent with first file creation.
8. Provider lifecycle conformance tests shared by OpenAI, Gemini and local implementations.

## Positive observations

- The code consistently uses bounded timeouts in most newer HTTP/WebSocket clients; weather is the main exception.
- Tool writes have a code-side capability whitelist, numeric coercion, zone/type scoping, >10-device confirmation and a one-lock unlock limit.
- ESP reconnect cleanup and frame parsing are much more defensive than in the first review.
- Secret-like settings are masked before normal Homey log output, and microphone debug capture is emulator-only.
- Audio output has FIFO ordering and generation invalidation to prevent stale segments from playing after abort.
- Optional features are gated so disabled tools disappear from model context.
- Tests cover provider behavior, reconnect policy, timer state, audio conversion, tool safety, settings pub/sub and client protocols.

## Final assessment

The project is not in a “rewrite” state. Its main weakness is lifecycle coordination: many individually reasonable async components mutate shared provider/turn state without a single serialization boundary. Fixing H1/H2/H3 will remove a large class of intermittent failures. For a public/store release, H4 and M2 should be treated as explicit security release criteria rather than residual documentation items.
