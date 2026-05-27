# Voice PE — End-to-End Communication Flows

This document describes the complete message sequences for each interaction type between the
Home Assistant Voice Preview Edition and Home Assistant.

---

## 1. Device Boot and Connection

```
Voice PE (ESP32-S3)                     Home Assistant
        │                                     │
        │ [Power on — firmware init]          │
        │ XMOS processor init (I2C)           │
        │                                     │
        │──── TCP connect port 6053 ─────────►│
        │◄─── Hello (server capabilities) ────│
        │──── Hello (device info, name) ─────►│
        │──── Connect (optional password) ───►│
        │◄─── ConnectResponse OK ─────────────│
        │                                     │
        │──── ListEntities ──────────────────►│
        │◄─── ListEntitiesResponse* ──────────│  (one per entity)
        │◄─── ListEntitiesDoneResponse ───────│
        │                                     │
        │──── SubscribeStates ───────────────►│
        │◄─── StateResponse (initial) ────────│
        │                                     │
        │ [Phase 1: Idle — LED static colour]  │
        │ [Micro wake word listening on-device]│
```

---

## 2. Wake Word Detection — Local (on-device)

The Voice PE detects the wake word locally on the ESP32-S3 using **Micro Wake Word**. No audio
leaves the device until detection occurs.

```
Voice PE                                Home Assistant
        │                                     │
        │ [Micro Wake Word triggers]           │
        │ [Phase 2: Waiting — LED animation]   │
        │                                     │
        │──── VoiceAssistantRequest ─────────►│  {start: true}
        │◄─── VoiceAssistantEvent ────────────│  WAKE_WORD_END
        │     {wake_word_id: "ok_nabu"}        │
        │                                     │
        │ [Phase 3: Listening — LED animation] │
        │                                     │
        │  (begin streaming audio)            │
```

---

## 3. Voice Command — Full Pipeline (Wake → TTS)

```
Voice PE                   Home Assistant              Voice Services (Wyoming)
        │                       │                            │
        │ [Wake word detected]   │                            │
        │──── VoiceAssistantRequest ──────────────────────────
        │     {start: true}      │                            │
        │                       │──── Wyoming: run-pipeline ─►│ wake svc
        │◄─── WAKE_WORD_END ─────│                            │
        │                       │                            │
        │ [Phase 3: Listening]   │                            │
        │──── audio frames ─────►│                            │
        │──── audio frames ─────►│──── audio-start ──────────►│ STT svc
        │──── audio frames ─────►│──── audio-chunk (×N) ─────►│
        │                       │                            │
        │◄─── STT_START ─────────│                            │
        │◄─── STT_VAD_START ─────│◄─── voice-started ─────────│
        │◄─── STT_VAD_END ───────│◄─── voice-stopped ─────────│
        │                       │──── audio-stop ────────────►│
        │                       │◄─── transcript ─────────────│
        │◄─── STT_END ───────────│                            │
        │     {text: "..."}      │                            │
        │                       │                            │
        │ [Phase 4: Thinking]    │                            │
        │◄─── INTENT_START ──────│                            │
        │                       │──── text to conversation ──►│ HA conversation
        │                       │◄─── intent response ────────│
        │◄─── INTENT_END ────────│                            │
        │     {response: "..."}  │                            │
        │                       │                            │
        │◄─── TTS_START ─────────│                            │
        │                       │──── Wyoming: synthesize ───►│ TTS svc
        │                       │◄─── audio-start ────────────│
        │                       │◄─── audio-chunk (×N) ───────│
        │                       │◄─── audio-stop ─────────────│
        │◄─── VoiceAssistantAudio│                            │
        │     (TTS chunks) ──────│                            │
        │◄─── TTS_END ───────────│                            │
        │                       │                            │
        │ [Phase 5: Replying]    │                            │
        │ [Speaker plays audio]  │                            │
        │                       │                            │
        │──── tts_response_finished ────────────────────────── (firmware signal)
        │                       │                            │
        │ [Phase 1: Idle]        │                            │
```

---

## 4. Voice Command — Starting from STT (Button Press / API Trigger)

When the user presses the action button (bypassing wake word detection):

```
Voice PE                            Home Assistant
        │                                 │
        │ [Button press detected]          │
        │──── VoiceAssistantRequest ──────►│  {start: true, stage: stt}
        │◄─── run-start ──────────────────│  {stt_binary_handler_id: 1}
        │◄─── STT_START ──────────────────│
        │                                 │
        │──── [0x01][PCM audio bytes] ───►│  (binary WebSocket frame)
        │──── [0x01][PCM audio bytes] ───►│
        │──── [0x01] (end signal) ────────│
        │                                 │
        │◄─── STT_END, INTENT_END, TTS_START, TTS_END, RUN_END
        │ (remainder same as above)        │
```

---

## 5. Announcement (Server Push → Satellite)

Home Assistant proactively plays a message on the Voice PE (e.g. a doorbell notification):

```
Home Assistant                          Voice PE
        │                                    │
        │ [Automation or service call]        │
        │──── assist_satellite.announce ─────►│ (HA service)
        │                                    │
        │──── VoiceAssistantEvent ───────────►│  ANNOUNCE
        │     {text: "Someone is at the door"}│
        │──── VoiceAssistantAudio (TTS) ─────►│
        │                                    │
        │                                    │ [Phase 5: Replying]
        │                                    │ [Speaker plays audio]
        │◄─── tts_response_finished ──────────│
        │                                    │
        │                                    │ [Phase 1: Idle]
```

---

## 6. Announcement + Follow-up Listening

When `start_conversation` feature is used (announcement followed by listening):

```
Home Assistant                          Voice PE
        │                                    │
        │──── assist_satellite.start_conversation ──────────►│
        │──── Announcement audio ────────────►│
        │                                    │ [Plays message]
        │                                    │ [Then immediately starts listening]
        │◄─── Audio stream begins ────────────│
        │◄─── STT pipeline runs ──────────────│
        │──── Intent + TTS response ─────────►│
```

---

## 7. Timer Flow

```
Home Assistant                          Voice PE
        │                                    │
        │ [User said "set timer 5 minutes"]  │
        │──── VoiceAssistantEvent INTENT_END ►│  {response: "Timer set..."}
        │──── timer-started ─────────────────►│
        │     {id, total_seconds: 300, name}  │
        │                                    │
        │ [30 seconds pass]                  │
        │──── timer-updated ─────────────────►│
        │     {id, total_seconds: 270}        │
        │                                    │
        │ [5 minutes elapsed]                │
        │──── timer-finished ────────────────►│
        │                                    │ [LED/sound alert]
```

---

## 8. Configuration Sync (Wake Word / Pipeline Change)

```
Home Assistant UI          Home Assistant Core              Voice PE
        │                         │                              │
        │ [User changes wake word] │                              │
        │──── assist_satellite/set_wake_words ──────────────────►│ (WebSocket)
        │                         │                              │
        │                         │──── VoiceAssistantEvent ────►│
        │                         │     {type: CONFIG_UPDATED}   │
        │                         │                              │
        │                         │◄─── Updated config ──────────│
```

---

## 9. Wyoming Protocol Internal Flow (HA ↔ Voice Services)

This is the internal flow within Home Assistant when it talks to Wyoming microservices:

```
Assist Pipeline                openWakeWord           Whisper (STT)          Piper (TTS)
        │                           │                      │                      │
        │─── describe ─────────────►│                      │                      │
        │◄── info ──────────────────│                      │                      │
        │                           │                      │                      │
        │─── detect ───────────────►│                      │                      │
        │─── audio-start ──────────►│                      │                      │
        │─── audio-chunk (×N) ─────►│                      │                      │
        │◄── detection ─────────────│                      │                      │
        │                           │                      │                      │
        │─── transcribe ──────────────────────────────────►│                      │
        │─── audio-start ─────────────────────────────────►│                      │
        │─── audio-chunk (×N) ────────────────────────────►│                      │
        │─── audio-stop ──────────────────────────────────►│                      │
        │◄── transcript ────────────────────────────────────│                      │
        │                           │                      │                      │
        │─── synthesize ──────────────────────────────────────────────────────────►
        │◄── audio-start ───────────────────────────────────────────────────────────
        │◄── audio-chunk (×N) ──────────────────────────────────────────────────────
        │◄── audio-stop ────────────────────────────────────────────────────────────
```

---

## 10. Error Scenarios

### STT no speech recognised

```
Home Assistant                          Voice PE
        │                                    │
        │ [No speech in audio stream]        │
        │──── VoiceAssistantEvent ERROR ─────►│
        │     {code: "stt-no-text-recognized"}│
        │                                    │
        │                                    │ [Phase 11: Error — LED flash]
        │                                    │ [Short pause]
        │                                    │ [Phase 1: Idle]
```

### Pipeline timeout

```
Home Assistant                          Voice PE
        │                                    │
        │ [Pipeline timeout exceeded]        │
        │──── VoiceAssistantEvent ERROR ─────►│
        │     {code: "timeout"}              │
        │                                    │ [Phase 11: Error]
        │                                    │ [Restart pipeline if restart_on_end=true]
```

### Server not ready

```
Wyoming Server                          Satellite
        │                                    │
        │──── pause-satellite ───────────────►│
        │                                    │ [Waits — does not stream]
        │──── run-satellite ─────────────────►│
        │                                    │ [Resumes normal operation]
```

---

## Audio Format Summary

| Parameter | Value | Notes |
|---|---|---|
| Sample rate | 16 000 Hz | Required by all STT engines |
| Bit depth | 16-bit signed | Little-endian PCM |
| Channels | 1 (mono) | After XMOS processing |
| Chunk size | Varies | Typically 512–2048 samples per chunk |
| TTS output | Varies | Piper produces 22 050 Hz by default; HA resamples |

---

## Port Reference

| Service | Protocol | Default Port |
|---|---|---|
| ESPHome Native API | TCP (protobuf) | 6053 |
| Home Assistant WebSocket | WebSocket (JSON) | 8123 |
| Wyoming services | TCP (JSON+binary) | 10700 |
| Wyoming satellite | TCP (JSON+binary) | 10700 |
| Zeroconf/mDNS | UDP | 5353 |
