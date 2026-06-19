# Voice PE Timers — ESPHome Native API + Homey Mapping

Research/design notes for adding timer support (gap-analysis #5, `TODO.md` §1/§3).
**Nothing is implemented yet** — this maps out the full mechanism so implementation is mechanical.

---

## TL;DR

- The PE firmware **already supports timers**. We (the app, replacing Home Assistant) drive them by
  sending one protobuf message: **`VoiceAssistantTimerEventResponse`** (message id **115**,
  direction **client → device**).
- A timer has four lifecycle events: **STARTED, UPDATED, CANCELLED, FINISHED**.
- The device **ticks the countdown locally** for its LED-ring display, but it **never finishes on its
  own** — it rings only when *we* send a **FINISHED** event. So **our app must own the authoritative
  countdown** and decide when the timer is up.
- Device support is advertised by a feature flag (`TIMERS = 1 << 3 = 8`) in `DeviceInfoResponse`.
- **Homey has no built-in timer/countdown capability.** Map it with **custom capabilities** (for the
  device tile) + **Flow cards** (for automation), with the app holding the real timer. Homey's
  `ManagerAlarms` is clock-alarm-based and a poor fit for countdowns (see §7).

---

## 1. Protocol

### Message (already in `src/voice_assistant/api.proto:1746-1764`)

```proto
enum VoiceAssistantTimerEvent {
  VOICE_ASSISTANT_TIMER_STARTED   = 0;
  VOICE_ASSISTANT_TIMER_UPDATED   = 1;
  VOICE_ASSISTANT_TIMER_CANCELLED = 2;
  VOICE_ASSISTANT_TIMER_FINISHED  = 3;
}

message VoiceAssistantTimerEventResponse {
  option (id) = 115;
  option (source) = SOURCE_CLIENT;          // sent BY us (the API client) TO the device
  option (ifdef) = "USE_VOICE_ASSISTANT";

  VoiceAssistantTimerEvent event_type = 1;
  string timer_id      = 2;   // our opaque id; reused across the timer's lifetime
  string name          = 3;   // optional spoken name ("pasta", ""); shown by some firmwares
  uint32 total_seconds = 4;   // original duration
  uint32 seconds_left  = 5;   // remaining at the moment we send this event
  uint32 is_active     = 6;   // bool: true = running, false = paused
}
```

> Note: `option (source) = SOURCE_CLIENT` is from the device's point of view — in the ESPHome model
> the **device is the "server"** and Home Assistant (here, this app) is the **"client"**. So despite
> the `...Response` suffix, **this message is something we send to the PE**, not something we receive.

### Direction & encoding

- We send it exactly like every other outbound message via the existing
  `send('VoiceAssistantTimerEventResponse', payload)` path in
  `src/voice_assistant/esp-voice-assistant-client.mts` (protobufjs frames it: `0x00` + varint(len) +
  varint(115) + body).
- This is a **different message** from `VoiceAssistantEventResponse` (id 92) used by the existing
  `vaEvent()` helper for the STT/INTENT/TTS pipeline. Timers do **not** go through `vaEvent()`.
- protobufjs decodes/encodes field names as camelCase (`eventType`, `timerId`, `totalSeconds`,
  `secondsLeft`, `isActive`) — match the convention already used in the client.

---

## 2. How the PE firmware reacts (device behavior)

Source: ESPHome `voice_assistant` component (`voice_assistant.cpp` `on_timer_event` + `timer_tick_`)
and the Voice PE firmware (`home-assistant-voice.yaml`).

1. **On any event** the component finds the timer by `timer_id` in its `timers_` collection and
   inserts/updates/erases it.
2. **Local 1 Hz tick.** While at least one timer exists, the component runs a local interval and
   decrements `seconds_left` itself every second:
   ```cpp
   void VoiceAssistant::timer_tick_() {
     for (auto &timer : this->timers_) {
       if (timer.is_active && timer.seconds_left > 0)
         timer.seconds_left--;
     }
     this->timer_tick_trigger_.trigger(this->timers_);   // fires on_timer_tick every second
   }
   ```
   On the PE this drives the **LED-ring countdown animation** (orange "Timer tick" effect showing
   remaining fraction). So **after a single STARTED event the ring counts down on its own** — we do
   **not** need to stream per-second updates for the display.
3. **Finishing is NOT autonomous.** The device's `seconds_left` hitting 0 does **not** ring. The
   component fires `on_timer_finished` **only when it receives a FINISHED event from us**. The PE's
   `on_timer_finished` turns on the `timer_ringing` switch → plays `timer_finished_sound` locally
   (looped) + LED alert. **⇒ our app must send FINISHED when our own countdown elapses.**
4. **Globals exposed by the firmware:** `is_timer_active` (bool) and `first_active_timer`
   (`voice_assistant::Timer` with `seconds_left`, `total_seconds`, `name`) — usable in lambdas / as
   HA sensors, not needed by us.

### Per-event semantics (what we send, what happens)

| Event | When we send it | Device effect |
|---|---|---|
| **STARTED** | timer created | adds timer, starts local tick + LED ring countdown |
| **UPDATED** | pause/resume, add/subtract time | re-syncs `seconds_left`/`is_active`; `is_active=false` freezes the ring |
| **CANCELLED** | user cancels, or to **stop the ringing** | removes timer; stops tick; stops ring |
| **FINISHED** | our authoritative countdown reaches 0 | turns on `timer_ringing` → local chime loop + LED alert |

---

## 3. Feature-flag gating

The device advertises timer support in **`DeviceInfoResponse.voice_assistant_feature_flags`**
(`api.proto:241`). Flag values (`aioesphomeapi` `VoiceAssistantFeature`, `IntFlag`):

| Flag | Value |
|---|---|
| VOICE_ASSISTANT | `1 << 0` = 1 |
| SPEAKER | `1 << 1` = 2 |
| API_AUDIO | `1 << 2` = 4 |
| **TIMERS** | **`1 << 3` = 8** |
| ANNOUNCE | `1 << 4` = 16 |
| START_CONVERSATION | `1 << 5` = 32 |

Before offering timers, check `(voiceAssistantFeatureFlags & 8) !== 0`. Today the client's
`DeviceInfoResponse` handler (`esp-voice-assistant-client.mts:382`) ignores this field — parsing it
is a prerequisite (see §6).

---

## 4. Required client flow (our app = the timer owner)

Home Assistant's `TimerManager` sends **STARTED once**, **FINISHED when its own server-side timer
elapses**, and **UPDATED only on discrete changes** (pause/resume/add-time) — it does **not** stream
periodic updates. We mirror that:

```
App (authoritative timer)                         Voice PE
        │  user: "set a 5 minute timer"               │
        │  create timer_id, total=300, left=300       │
        │── STARTED {id, total:300, left:300, active} ►│  LED ring starts, ticks locally
        │                                             │
        │  (app holds a real setTimeout/interval)     │  (device ticks its own copy for display)
        │                                             │
        │  user: "pause"                              │
        │── UPDATED {id, left:212, active:false} ─────►│  ring freezes
        │  user: "resume"                             │
        │── UPDATED {id, left:212, active:true} ──────►│  ring resumes
        │                                             │
        │  app countdown hits 0                        │
        │── FINISHED {id, total:300, left:0} ─────────►│  rings: chime loop + LED alert
        │                                             │
        │  user: "stop" / button press                │
        │── CANCELLED {id} ───────────────────────────►│  stops ringing, removes timer
```

Rules:
- **App is authoritative.** Keep a real timer (`homey.setTimeout`) per active timer; the device's
  local tick is display-only and may drift by a second or two — that's fine and matches HA.
- **Always send FINISHED** — the device will never ring otherwise.
- Reuse the same `timer_id` for the whole lifecycle.
- Optional drift-correction: send an occasional UPDATED with the true `seconds_left`. HA doesn't, so
  treat as nice-to-have.
- Multiple concurrent timers are supported (distinct `timer_id`s); `on_timer_tick` carries all of them.

---

## 5. Gotchas / edge cases

- **Ringing stop:** FINISHED starts a *looping* chime. It stops on a device button press, or when we
  send **CANCELLED**. Confirm on-device whether there's an auto-stop timeout — *verify on hardware*.
- **Stale timers after reconnect:** the device clears timers on disconnect. After our reconnect we
  must re-send STARTED for any still-running timers (with the current `seconds_left`) or drop them.
- **Cancelled-but-still-responding:** [home-assistant-voice-pe#252](https://github.com/esphome/home-assistant-voice-pe/issues/252)
  documents the agent still referencing just-cancelled timers — keep our timer registry and the
  agent's view in sync; always emit CANCELLED.
- **No spoken confirmation here:** the PE only shows ring/plays chime. Spoken "timer set" comes from
  our OpenAI agent's normal TTS response, separate from these events.
- **Firmware vs. local-handling:** stock PE handles voice-set timers entirely on-device *when paired
  with HA*. Since we replace HA, **we are the timer brain** — the device only renders what we send.

---

## 6. Integration points in this codebase

| Area | File | Change |
|---|---|---|
| Send helpers | `src/voice_assistant/esp-voice-assistant-client.mts` | add `startTimer/updateTimer/cancelTimer/finishTimer(...)` sending `VoiceAssistantTimerEventResponse`; an internal registry of active timers keyed by `timer_id`, each with a `homey.setTimeout` that fires FINISHED |
| Capability gate | same, `DeviceInfoResponse` handler (`:382`) | parse `voiceAssistantFeatureFlags`, store `supportsTimers = (flags & 8) !== 0`; expose via the existing `capabilities` event |
| Reconnect | same, `handleDisconnect`/connect flow | clear or re-issue STARTED for active timers |
| Agent tool | `src/llm/tool-manager.mts` | add `set_timer` (+ `cancel_timer`, maybe `pause_timer`) tool calling the client helpers; register in `getToolDefinitions()` / `getToolHandlers()` |
| Orchestration | `src/homey/voice-assistant-device.mts` | own the per-device timer registry; surface state to Homey (custom capabilities + Flow triggers, §7) |
| Agent prompt | `src/llm/agent-instructions.*.mts` | teach the agent it can set/cancel timers |

The existing `vaEvent()` helper is **not** reused (that's id 92 for the STT/TTS pipeline); timers need
a new `send('VoiceAssistantTimerEventResponse', …)` path.

---

## 7. Mapping the timer onto Homey

**There is no built-in Homey capability for a countdown/timer.** (The SDK's `duration` capability
*option* is unrelated — it only lets a Flow **action** card accept a duration argument; it does not
represent timer state.) Timer/countdown features in the Homey ecosystem are community **apps** driven
by **Flow cards**, not device capabilities.

So the PE timer state has to be represented by things we define. Options:

| Approach | What it gives | Fit |
|---|---|---|
| **Custom capabilities** (recommended for the tile) | timer state visible on the device card | Good |
| **Flow cards** (recommended for automation) | triggers/conditions/actions for users' flows | Good — most Homey-native |
| **`ManagerAlarms`** (clock alarms) | a scheduled clock alarm | Poor for countdowns (see below) |
| Community Countdown app | external app's timers | Not controllable from our app |

### Recommended: custom capabilities + Flow cards, app stays authoritative

Because the device can't finish on its own, the **app already has to own the timer** (§4). Surface
that owned state on the Homey device:

**Custom capabilities** (defined under `.homeycompose/capabilities/`, added to the driver):
```jsonc
// timer_remaining.json — remaining seconds, sensor (read-only)
{ "type": "number", "title": { "en": "Timer remaining" }, "units": { "en": "s" },
  "getable": true, "setable": false, "uiComponent": "sensor", "icon": "/assets/timer.svg" }

// timer_active.json — is a timer running (boolean alarm-style)
{ "type": "boolean", "title": { "en": "Timer active" },
  "getable": true, "setable": false, "uiComponent": "sensor" }

// optional: timer_name.json — string, the active timer's spoken name
{ "type": "string", "title": { "en": "Timer name" }, "getable": true, "setable": false }
```
Update these from the device's timer registry (set on STARTED, tick down with the app's own interval,
clear on CANCELLED/FINISHED). For multiple timers, surface the soonest-finishing one (mirrors the
firmware's `first_active_timer`).

**Flow cards** (under `.homeycompose/flow/`):
- Triggers: `timer_started`, `timer_finished`, `timer_cancelled` (tokens: name, total/remaining seconds).
- Condition: `is_timer_active`.
- Actions: `start_timer` (duration + optional name), `cancel_timer` — lets users start a PE timer
  from a flow, not just by voice.

This dovetails with the existing `TODO.md` §3 "Alarm / countdown" agent-tool item and gap-analysis #5.

### Why not `ManagerAlarms`

[`HomeyAPIV3Local.ManagerAlarms`](https://athombv.github.io/node-homey-api/HomeyAPIV3Local.ManagerAlarms.html)
models **clock alarms** (fire at a wall-clock time, repeat by weekday) — app/system-global, not bound
to a device. A countdown can be converted to an absolute time, but you lose pause/resume, sub-minute
precision, and the device-tile association, and you'd be mixing user alarms with transient timers.
Fine as a *fallback* for long "wake me at 07:00" style requests; not the primary timer mechanism.

---

## 8. To verify on hardware

- Exact ring auto-stop behavior/timeout after FINISHED, and whether CANCELLED reliably silences it.
- Whether the PE renders the `name` field anywhere (LED/voice) or ignores it.
- Behavior with multiple simultaneous timers on the ring.
- Whether any UPDATED cadence is needed to keep the ring visually accurate over long timers (drift).

---

## References

- ESPHome Voice Assistant component (timer automations): https://esphome.io/components/voice_assistant/
- `voice_assistant.cpp` source (`on_timer_event`, `timer_tick_`): https://api-docs.esphome.io/voice__assistant_8cpp_source
- Voice PE firmware YAML (`on_timer_*`, `timer_ringing`, globals): https://github.com/esphome/home-assistant-voice-pe/blob/dev/home-assistant-voice.yaml
- `aioesphomeapi` `VoiceAssistantFeature` flags: https://github.com/esphome/aioesphomeapi/blob/main/aioesphomeapi/model.py
- HA Voice Chapter 7 (timers): https://www.home-assistant.io/blog/2024/06/26/voice-chapter-7/
- Cancelled-timer edge case: https://github.com/esphome/home-assistant-voice-pe/issues/252
- Homey device capabilities (no native timer; custom capabilities): https://apps.developer.homey.app/the-basics/devices/capabilities
- Homey `ManagerAlarms`: https://athombv.github.io/node-homey-api/HomeyAPIV3Local.ManagerAlarms.html
