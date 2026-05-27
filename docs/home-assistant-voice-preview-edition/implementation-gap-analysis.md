# Implementation Gap Analysis — Voice PE Documentation vs. This Project

This document compares the Home Assistant Voice PE communication flows and protocol
documentation against the actual implementation in this project (`esp-voice-assistant-client.mts`
and `voice-assistant-device.mts`).

---

## Context

This project **replaces Home Assistant** as the server that communicates with the Voice PE over
the ESPHome Native API. Instead of routing through the Assist pipeline, it sends audio directly
to OpenAI's Realtime API for STT/intent/TTS processing.

The documentation describes how HA handles the Voice PE; below are areas where this project
diverges or has gaps.

---

## ✅ What's Already Working Well

| Feature | Status |
|---|---|
| TCP connection on port 6053 (ESPHome Native API) | ✅ Implemented |
| Hello → Connect → ListEntities → Subscribe flow | ✅ Implemented |
| VoiceAssistantRequest handling (start/stop) | ✅ Implemented |
| Audio streaming via API (TCP) instead of UDP | ✅ Implemented |
| VoiceAssistantEvent lifecycle (RUN_START → STT → INTENT → TTS → RUN_END) | ✅ Implemented |
| Announcement playback (VoiceAssistantAnnounceRequest) | ✅ Implemented |
| Media player volume control | ✅ Implemented |
| Mute switch control | ✅ Implemented |
| Health check / ping-pong keepalive | ✅ Implemented |
| Reconnection with exponential backoff | ✅ Implemented |
| mDNS discovery (via Homey discovery) | ✅ Implemented |
| Audio format: 16 kHz 16-bit mono PCM from device | ✅ Handled (resampled to 24 kHz for OpenAI) |
| `start_conversation` follow-up listening | ✅ Implemented |

---

## 🔶 Gaps & Recommended Changes

### 1. ~~Missing `INTENT_PROGRESS` Event~~ ✅ DONE

**Documentation:** The `INTENT_PROGRESS` event (`VoiceAssistantEvent`) is sent during LLM-backed
conversations that stream their response. It contains `chat_log_delta` and `tts_start_streaming` fields.

**Current implementation:** Not emitted. The device jumps from `INTENT_START` directly to `INTENT_END`.

**Impact:** The PE firmware may use this to start streaming TTS playback earlier (before the full
response is ready), improving perceived latency.

**Recommendation:** Emit `INTENT_PROGRESS` events as OpenAI streams response text deltas back.
This aligns with the `agent.on('transcript.delta')` handler that already exists.

**Effort:** Low

---

### 2. ~~Missing `WAKE_WORD_END` Event~~ ✅ DONE

**Documentation:** After wake word detection, HA sends a `WAKE_WORD_END` event back to the PE
before STT begins.

**Current implementation:** The flow goes directly from `VoiceAssistantRequest {start: true}` to
`RUN_START` → `STT_START`. No `WAKE_WORD_END` is sent back.

**Impact:** The firmware uses this event to transition LED state from "Waiting" to "Listening".
Without it, the LED animation may not correctly reflect the current phase.

**Recommendation:** After receiving `VoiceAssistantRequest {start: true}`, emit a `WAKE_WORD_END`
event before `STT_START`:

```typescript
// In esp.on('starting') handler:
this.esp.run_start();
this.esp.vaEvent(VA_EVENT.VOICE_ASSISTANT_WAKE_WORD_END, {}, 'WAKE_WORD_END');
this.esp.stt_start();
```

**Effort:** Trivial

---

### 3. ~~No Error Event Handling~~ ✅ DONE

**Documentation:** The pipeline sends `ERROR` events with codes like `stt-no-text-recognized`,
`timeout`, `intent-failed`, etc. The PE displays these as flashing red LEDs (Phase 11).

**Current implementation:** When STT returns empty text, the handler sends `stt_end('')` and
`run_end()` but no explicit `ERROR` event. The PE firmware won't show the error LED state.

**Recommendation:** Add an error event helper and use it for:
- Empty transcription (no speech detected)
- Agent connection failures during an active session
- Tool execution failures

```typescript
// Add to EspVoiceAssistantClient:
error(code: string, message: string): void {
    this.vaEvent(VA_EVENT.VOICE_ASSISTANT_ERROR, { code, message }, 'ERROR');
}
```

**Effort:** Low

---

### 4. ~~Missing `SubscribeStates` Message~~ ✅ DONE

**Documentation:** After `ListEntitiesDoneResponse`, the standard flow sends `SubscribeStates` to
receive ongoing state updates for all entities.

**Current implementation:** Only sends `SubscribeVoiceAssistantRequest`. The media player and
switch state subscriptions use custom per-entity subscribe calls that may not exist in all
firmware versions.

**Impact:** State updates (volume, mute) may not arrive on some firmware versions that expect
the standard `SubscribeStates` flow.

**Recommendation:** Send `SubscribeStatesRequest` after `ListEntitiesDoneResponse` instead of
(or in addition to) the individual subscribe calls:

```typescript
this.send('SubscribeStatesRequest', {});
```

This is the standard ESPHome flow and will deliver `MediaPlayerStateResponse`,
`SwitchStateResponse`, and `NumberStateResponse` without needing per-entity subscription.

**Effort:** Low

---

### 5. No Timer Event Support

**Documentation:** Home Assistant sends timer events (`timer-started`, `timer-updated`,
`timer-cancelled`, `timer-finished`) to the satellite so it can show timer state on the LED
ring and play alerts.

**Current implementation:** No timer functionality. The OpenAI agent cannot set timers that
display on the PE device.

**Impact:** Users cannot say "set a 5 minute timer" and have the PE track/alert on it.

**Recommendation:** 
1. Add a `set_timer` tool to the ToolManager
2. Track active timers locally
3. Send `VoiceAssistantTimerEvent` messages to the ESP when timers start/update/finish

This is a larger feature but would significantly improve the voice assistant experience.

**Effort:** Medium

---

### 6. No `tts_response_finished` Signal

**Documentation:** The firmware calls `tts_response_finished()` after the speaker finishes
playing TTS audio, which transitions the state machine back to IDLE.

**Current implementation:** The `announce_finished` event from the ESP is handled and triggers
`tts_end()` + `run_end()`. This appears functionally equivalent (the ESP sends
`VoiceAssistantAnnounceFinished` when playback completes).

**Status:** ✅ Already handled — the `announce_finished` event serves this purpose.

---

### 7. No Configuration Sync Support

**Documentation:** HA can send `CONFIG_UPDATED` events to the PE for wake word or pipeline
changes. The PE publishes Select entities for wake word and pipeline selection.

**Current implementation:** No handling of Select entities (`ListEntitiesSelectResponse`),
no configuration sync. Wake word management is left entirely to the PE firmware defaults.

**Impact:** Users cannot change wake words or manage on-device settings from the Homey app.

**Recommendation:** 
1. Parse `ListEntitiesSelectResponse` during entity enumeration
2. Store select entity keys for wake word and pipeline
3. Optionally expose wake word selection in Homey device settings

**Effort:** Medium

---

### 8. Missing `STT_VAD_END` Text Content

**Documentation:** `STT_VAD_END` may carry a text field (though typically empty in HA).

**Current implementation:** `stt_vad_end('')` is called with empty text, which matches HA
behaviour. However, the implementation comment says "TODO: Which we had some text to pass back
here."

**Status:** ✅ Current behaviour matches HA. The TODO is aspirational.

---

### 9. No `ListEntitiesSensorResponse` Handling

**Documentation:** The PE publishes sensor entities (LED brightness, button presses, etc.)
through `ListEntities`.

**Current implementation:** Only handles `ListEntitiesMediaPlayerResponse`,
`ListEntitiesSwitchResponse`, and `ListEntitiesNumberResponse`. Other entity types
(sensors, selects, binary sensors) are silently ignored.

**Impact:** Cannot read or control LED brightness, detect button presses as Homey triggers,
or observe sensor telemetry.

**Recommendation:** Add handlers for:
- `ListEntitiesSensorResponse` — for environmental sensors (temperature via Grove)
- `ListEntitiesSelectResponse` — for wake word / pipeline configuration
- `ListEntitiesBinarySensorResponse` — for button press events

**Effort:** Low per entity type

---

### 10. Connection Security Not Implemented

**Documentation:** The ESPHome Native API supports AES-256 encryption with a pre-shared key.

**Current implementation:** Always connects with empty password and no encryption:
```typescript
this.send('ConnectRequest', { password: '' });
```

**Impact:** Communication between Homey and the PE is unencrypted on the local network. For
most home setups this is acceptable, but devices with encryption enabled will refuse the
connection.

**Recommendation:** Add an optional `encryption_key` device setting. When configured, implement
the noise protocol handshake before the Hello exchange.

**Effort:** High (requires implementing the noise protocol)

---

### 11. ~~`HelloRequest` Version Negotiation~~ ✅ DONE

**Documentation:** The Hello exchange negotiates API version compatibility. The current
implementation sends `apiVersionMajor: 1, apiVersionMinor: 6`.

**Current implementation:** Sends the version but doesn't validate the `HelloResponse` to check
if the firmware supports the features being used (e.g., VoiceAssistantAnnounceRequest requires
a minimum API version).

**Recommendation:** Check the server's API version in `HelloResponse` and log a warning if it's
below the minimum required version for all features used.

**Effort:** Trivial

---

### 12. Audio Chunk Size Not Optimised

**Documentation:** Audio chunks are typically 512–2048 samples per chunk (1024–4096 bytes at
16-bit mono).

**Current implementation:** Audio arrives from the ESP in whatever chunk size the TCP stream
delivers. The `Pcm16kTo24k` resampler produces 20ms frames (480 samples at 24 kHz = 960 bytes).

**Status:** ✅ This is fine — the resampler normalises chunk sizes before sending to OpenAI.

---

## Summary Table

| # | Gap | Impact | Effort | Priority |
|---|---|---|---|---|
| 1 | ~~Missing INTENT_PROGRESS event~~ | ~~Latency / UX~~ | ✅ Done | ✅ Done |
| 2 | ~~Missing WAKE_WORD_END event~~ | ~~LED state accuracy~~ | ✅ Done | ✅ Done |
| 3 | ~~No ERROR event to device~~ | ~~Error feedback UX~~ | ✅ Done | ✅ Done |
| 4 | ~~Missing SubscribeStates~~ | ~~Compatibility~~ | ✅ Done | ✅ Done |
| 5 | No timer support | Feature gap | Medium | Medium |
| 6 | tts_response_finished | Already handled | — | — |
| 7 | No configuration sync | Feature gap | Medium | Low |
| 8 | STT_VAD_END text | Already correct | — | — |
| 9 | Missing entity type handlers | Feature gap | Low | Low |
| 10 | No encryption support | Security | High | Low |
| 11 | ~~Version negotiation check~~ | ~~Robustness~~ | ✅ Done | ✅ Done |
| 12 | Audio chunk sizes | Already handled | — | — |

---

## Recommended Implementation Order

1. ~~**Item 2** — Add `WAKE_WORD_END` event (trivial, immediate LED improvement)~~ ✅ Done
2. ~~**Item 3** — Add ERROR event helper (low effort, visible UX improvement)~~ ✅ Done
3. ~~**Item 1** — Emit `INTENT_PROGRESS` during streaming (low effort, perceived speed boost)~~ ✅ Done
4. ~~**Item 11** — Log version mismatch warning (trivial)~~ ✅ Done
5. ~~**Item 4** — Add `SubscribeStatesRequest` (low effort, broader firmware compat)~~ ✅ Done
6. **Item 9** — Handle additional entity types (incremental)
7. **Item 5** — Timer support (medium, big user-facing feature)
8. **Item 7** — Configuration sync (medium)
9. **Item 10** — Encryption (high effort, only needed if users enable it on device)




