# Home Assistant Voice Preview Edition — Communication Overview

Source: https://www.home-assistant.io/voice-pe/

The **Home Assistant Voice Preview Edition (Voice PE)** is an ESP32-S3–based voice satellite device designed
by **Nabu Casa** and the **Open Home Foundation**. It communicates with Home Assistant through the
**ESPHome Native API**. Once a voice command is captured, Home Assistant processes it through the
**Assist pipeline**, which coordinates several services via the **Wyoming protocol** (for STT, TTS, and
wake-word engines).

This document gives a bird's-eye view. Detailed specifications are in the sibling files:

| Document | Contents |
|---|---|
| [voice-pe-hardware-reference.md](voice-pe-hardware-reference.md) | Full hardware specs, ports, controls, LED states |
| [esphome-native-api.md](esphome-native-api.md) | How Voice PE talks to HA over TCP |
| [assist-pipeline-websocket-api.md](assist-pipeline-websocket-api.md) | WebSocket pipeline API used by clients and satellites |
| [wyoming-protocol.md](wyoming-protocol.md) | Wyoming wire protocol — all message types |
| [voice-pe-communication-flow.md](voice-pe-communication-flow.md) | End-to-end sequence diagrams |

---

## Device at a Glance

| | |
|---|---|
| **Price** | $69 USD / €59 EUR |
| **Main SoC** | ESP32-S3 (16 MB flash, 8 MB PSRAM) |
| **Audio processor** | XMOS XU316 (AEC, noise removal, auto gain) |
| **DAC** | TI AIC3204 — 48 kHz |
| **Connectivity** | Wi-Fi 2.4 GHz, Bluetooth 5.0 |
| **Power** | USB-C 5 V / 2 A |
| **Firmware** | ESPHome (open-source) |
| **Languages** | 60+ languages and dialects |

---

## Hardware Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 Home Assistant Voice PE                 │
│                                                         │
│  ┌──────────────┐   I2C    ┌──────────────────────────┐│
│  │  ESP32-S3    │◄────────►│  XMOS Voice Processor    ││
│  │  (firmware)  │          │  • AEC (Echo Cancel)     ││
│  │              │   I2S    │  • IC (Interference)     ││
│  │  ESPHome     │◄────────►│  • NS (Noise Suppress)   ││
│  │  Native API  │  audio   │  • AGC (Auto Gain)       ││
│  └──────┬───────┘          └──────────────────────────┘│
│         │ Wi-Fi TCP                                     │
└─────────┼───────────────────────────────────────────────┘
          │ port 6053 (protobuf)
          ▼
┌─────────────────────────────────────────────────────────┐
│                    Home Assistant                        │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │              Assist Pipeline                      │  │
│  │                                                   │  │
│  │  Wake Word ──► STT ──► Intent ──► Handle ──► TTS │  │
│  └──────────┬───────────────────────────────────────┘  │
│             │ Wyoming protocol (TCP)                    │
│  ┌──────────▼───────────────────────────────────────┐  │
│  │   External Voice Services (local or remote)       │  │
│  │   • openWakeWord  • Whisper / Speech-to-Phrase   │  │
│  │   • Piper TTS     • Custom intent handlers        │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## Two Distinct Protocols in Play

### 1. ESPHome Native API (Voice PE ↔ Home Assistant)

The Voice PE connects over Wi-Fi to Home Assistant on **TCP port 6053** using a binary
**protocol-buffer** framing. This channel carries:

- Device state updates (LED mode, speaker volume, button presses)
- Voice assistant audio streaming (PCM frames to HA, TTS audio back to device)
- Configuration sync (wake-word list, pipeline selection)
- Sensor telemetry

See [esphome-native-api.md](esphome-native-api.md).

### 2. Wyoming Protocol (Home Assistant ↔ Voice Services)

Once HA receives audio from the Voice PE it fans the work out to microservices using the Wyoming
protocol over **TCP port 10700** (default). Each service — wake-word engine, STT, TTS — is a
separate Wyoming server.

The protocol uses newline-delimited JSON headers with an optional binary payload for raw PCM audio.

See [wyoming-protocol.md](wyoming-protocol.md).

---

## Assist Satellite State Machine

The `assist_satellite` entity in Home Assistant tracks the Voice PE through four states:

```
         wake word / button press
IDLE ──────────────────────────────► LISTENING
  ▲                                      │
  │                                      │ speech captured
  │                                      ▼
  │                                 PROCESSING
  │                                      │
  │                                      │ response ready
  │                                      ▼
  └──────────── tts_response_finished() RESPONDING
```

| State | Description |
|---|---|
| `IDLE` | Waiting for wake word or button press |
| `LISTENING` | Streaming audio to Home Assistant |
| `PROCESSING` | HA is running STT → Intent → Handle |
| `RESPONDING` | Device is playing back TTS audio |

The transition from `RESPONDING` → `IDLE` is triggered explicitly by the firmware calling
`tts_response_finished()` after the speaker finishes.

---

## Voice PE Operational Phases (Firmware View)

The firmware tracks a finer-grained `voice_assistant_phase` variable:

| Phase | Description | LED Feedback |
|---|---|---|
| 1 — Idle | Background wake-word listening | Static colour |
| 2 — Waiting | Post-wake-word, awaiting command | "Waiting" animation |
| 3 — Listening | Recording command audio | "Listening" animation |
| 4 — Thinking | HA processing response | Pulsing effect |
| 5 — Replying | Playing TTS audio | "Replying" animation |
| 10 — Not Ready | Initialising | Init sequence |
| 11 — Error | Pipeline error | Flashing red |

---

## Voice Processing Modes

| Mode | STT Engine | TTS Engine | Where it runs | Requirement |
|---|---|---|---|---|
| **Focused local** | Speech-to-Phrase | Piper | HA host | Any hardware |
| **Full local** | Whisper | Piper | HA host | Intel N100 or faster recommended |
| **Cloud** | Azure (Nabu Casa) | Azure (Nabu Casa) | Microsoft Azure | Home Assistant Cloud subscription |

All three modes use the same ESPHome Native API and Assist pipeline — only the backend services differ.
The device can also be connected to **OpenAI, Google, Anthropic, or local LLMs** as the conversation
agent for natural language understanding.

---

## Service Discovery

All Wyoming services advertise themselves via **Zeroconf/mDNS** so Home Assistant can discover
them automatically. Manual configuration is available under **Settings → Devices & Services →
Wyoming**.

The Voice PE itself is discovered through ESPHome's built-in mDNS advertisement.
