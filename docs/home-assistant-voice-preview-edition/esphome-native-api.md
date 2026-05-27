# ESPHome Native API — Voice PE ↔ Home Assistant

The Home Assistant Voice PE firmware is built on **ESPHome** and communicates with Home Assistant
through the **ESPHome Native API**: a custom, binary TCP protocol encoded with **Protocol Buffers**.

---

## Transport

| Parameter | Value |
|---|---|
| Protocol | TCP |
| Default port | **6053** |
| Encoding | Protocol Buffers (protobuf) |
| Encryption | Optional AES-256 (32-byte base64 key) |
| Discovery | mDNS / Zeroconf |

The `.proto` schema is published in the ESPHome repository at `api.proto`.

---

## Connection Lifecycle

```
Voice PE (ESP32-S3)                    Home Assistant
        │                                     │
        │──── TCP connect (port 6053) ────────►│
        │                                     │
        │◄─── Hello (server info) ────────────│
        │──── Hello (device info) ───────────►│
        │                                     │
        │──── Connect (password if set) ─────►│
        │◄─── ConnectResponse (OK / invalid)──│
        │                                     │
        │  ═══ Connected — bidirectional ════  │
        │                                     │
        │──── ListEntities ──────────────────►│
        │◄─── ListEntitiesResponse* ──────────│
        │◄─── ListEntitiesDoneResponse ───────│
        │                                     │
        │──── SubscribeStates ───────────────►│
        │◄─── StateResponse* (streaming) ─────│
```

---

## Connection Parameters

| Config key | Default | Range | Description |
|---|---|---|---|
| `port` | 6053 | 1–65535 | TCP listen port |
| `listen_backlog` | platform | 1–10 | Pending connection queue |
| `max_connections` | 5 (ESP32) | — | Simultaneous API connections |
| `max_send_queue` | 8 (ESP32) | — | Queued messages per connection |
| `batch_delay` | 100 ms | 0–65535 ms | State-update batching window |

---

## Voice Assistant Communication

When a voice interaction begins, the ESPHome firmware uses the Native API to:

1. **Signal pipeline start** — sends a voice assistant event to HA indicating audio is about to be
   streamed.
2. **Stream audio** — sends PCM audio frames (16 kHz, 16-bit, mono) to HA in real time.
3. **Receive pipeline events** — HA sends back structured events as the pipeline progresses
   (wake word detected, transcription complete, TTS ready, etc.).
4. **Play TTS audio** — HA streams TTS audio back over the same Native API channel; the firmware
   routes it to the speaker via the media player mixer.

### Audio Format

| Parameter | Value |
|---|---|
| Sample rate | 16 000 Hz |
| Bit depth | 16-bit signed PCM |
| Channels | 1 (mono) |
| Source | XMOS-processed I2S output |

### Voice Assistant Events (Native API)

These protobuf message types carry voice-assistant-specific payloads:

| Direction | Message | Description |
|---|---|---|
| PE → HA | `VoiceAssistantRequest` | Triggers pipeline start; contains `start` flag |
| HA → PE | `VoiceAssistantAudio` | TTS audio chunks streamed to device |
| HA → PE | `VoiceAssistantEvent` | Pipeline stage events (see table below) |
| PE → HA | `VoiceAssistantResponse` | Acknowledgement / audio frames |
| HA → PE | `VoiceAssistantTimerEvent` | Timer events (started, updated, etc.) |

### VoiceAssistantEvent Types

| Event type | Stage | Payload fields |
|---|---|---|
| `WAKE_WORD_START` | Wake word | engine, timeout |
| `WAKE_WORD_END` | Wake word | wake_word_id, timestamp |
| `STT_START` | Speech-to-Text | engine, metadata |
| `STT_VAD_START` | STT | timestamp |
| `STT_VAD_END` | STT | timestamp |
| `STT_END` | Speech-to-Text | transcription text |
| `INTENT_START` | Intent | engine, language, input text |
| `INTENT_PROGRESS` | Intent | chat_log_delta, tts_start_streaming |
| `INTENT_END` | Intent | conversation response |
| `TTS_START` | TTS | engine, language, voice |
| `TTS_END` | TTS | audio token, URL, MIME type |
| `RUN_END` | Pipeline | — |
| `ERROR` | Any | code, message |

---

## Entity Types Published by Voice PE

The firmware registers these ESPHome entity types with Home Assistant via `ListEntities`:

| Entity | Type | Description |
|---|---|---|
| Voice Assistant | Voice Satellite | Core pipeline integration |
| Media Player | Media Player | Speaker / audio output |
| Mute switch | Switch | Microphone mute |
| Volume | Number | Speaker volume 0–100 |
| Noise suppression | Select | webrtc noise suppression level |
| Wake word | Select | Active wake-word model |
| Pipeline | Select | Active Assist pipeline |
| LED brightness | Number | Ring LED brightness |
| Buttons (action/mute) | Binary Sensor / Event | Physical button presses |

---

## Security

- **Encryption**: AES-256 symmetric encryption may be enabled with a 32-byte base64-encoded key.
  When enabled without a pre-shared key the key is negotiated at runtime.
- **Authentication**: Uses Home Assistant's built-in device authentication; one-click adoption
  through the HA UI after mDNS discovery.
- **Local-only**: The Native API is a LAN protocol — no cloud dependency.

---

## Client Library

The Python library **`aioesphomeapi`** implements the Native API for third-party clients:

```python
import asyncio
import aioesphomeapi

async def main():
    api = aioesphomeapi.APIClient("voice-pe.local", 6053, password="")
    await api.connect(login=True)
    entities, services = await api.list_entities_services()
    # subscribe to state changes
    api.subscribe_states(lambda state: print(state))
    await asyncio.sleep(30)

asyncio.run(main())
```

---

## Audio Processing Chain (Hardware)

```
Microphone array (I2S)
        │
        ▼
XMOS Voice Processor  ◄── I2C configuration from ESP32-S3
  • AEC — Acoustic Echo Cancellation
  • IC  — Interference Cancellation
  • NS  — Noise Suppression
  • AGC — Automatic Gain Control
        │ I2S (processed PCM)
        ▼
ESP32-S3
  • Micro Wake Word (on-device)
  • Audio chunking
  • Native API streaming to HA
        │ Wi-Fi TCP port 6053
        ▼
Home Assistant
```

The XMOS chip is configured over **I2C** from the ESP32-S3. Processed audio arrives back on
the ESP32-S3 via **I2S** and is forwarded to Home Assistant.
