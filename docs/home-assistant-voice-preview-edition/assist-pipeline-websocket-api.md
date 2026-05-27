# Assist Pipeline — WebSocket API

The **Assist pipeline WebSocket API** is the interface used when external clients (browsers,
scripts, custom integrations) communicate directly with Home Assistant's voice pipeline over its
WebSocket connection. The Home Assistant Voice PE uses this same pipeline internally through the
ESPHome Native API, but the WebSocket form is useful for custom satellites, debugging, and
third-party clients.

Reference: `assist_pipeline/run` command, documented at
https://developers.home-assistant.io/docs/voice/pipelines/

---

## WebSocket Connection

All Home Assistant WebSocket commands follow this lifecycle:

```
client                              Home Assistant
  │                                       │
  │──── ws://ha-host:8123/api/websocket ─►│
  │◄─── { "type": "auth_required" } ──────│
  │──── { "type": "auth",                 │
  │       "access_token": "<token>" } ───►│
  │◄─── { "type": "auth_ok" } ────────────│
  │                                       │
  │  ══ Authenticated — command phase ═══ │
```

Each command message must include a unique integer `id` so responses can be correlated.

---

## Starting a Voice Pipeline Run

### Request

```json
{
  "id": 1,
  "type": "assist_pipeline/run",
  "start_stage": "stt",
  "end_stage":   "tts",
  "input": {
    "sample_rate": 16000
  }
}
```

| Field | Required | Type | Description |
|---|---|---|---|
| `start_stage` | Yes | string | Where the pipeline begins |
| `end_stage` | Yes | string | Where the pipeline ends |
| `pipeline` | No | string | Pipeline ID (omit to use default) |
| `conversation_id` | No | string | Continue an existing conversation |
| `device_id` | No | string | HA device registry ID of the satellite |
| `timeout` | No | number | Pipeline timeout in seconds (default: 300) |
| `input` | Varies | object | Stage-specific input configuration |

### Valid Stage Values

| Stage | Description |
|---|---|
| `wake_word` | Start with wake-word detection |
| `stt` | Start with speech recognition |
| `intent` | Start from pre-transcribed text |
| `tts` | Start with text-to-speech only |

`end_stage` must be equal to or after `start_stage` in the pipeline sequence:
`wake_word → stt → intent → tts`

### Input Configuration by Start Stage

**Wake word start:**
```json
{
  "input": {
    "timeout":              3,
    "noise_suppression_level": 2,
    "auto_gain_dbfs":       31,
    "volume_multiplier":    2.0
  }
}
```

**STT start:**
```json
{
  "input": {
    "sample_rate":    16000,
    "wake_word_phrase": "ok nabu"
  }
}
```

**Intent start (text input):**
```json
{
  "input": { "text": "turn off the kitchen lights" }
}
```

**TTS only:**
```json
{
  "input": { "text": "Turning off the kitchen lights." }
}
```

---

## Pipeline Event Stream

After the initial request HA responds with a stream of events. Each event has this outer envelope:

```json
{
  "id": 1,
  "type": "event",
  "event": {
    "type":       "<event-type>",
    "data":       { ... },
    "timestamp":  "2025-01-15T10:23:00.123Z"
  }
}
```

### run-start

Signals the pipeline has initialised.

```json
{
  "type": "run-start",
  "data": {
    "pipeline":   "01JXYZ...",
    "language":   "en",
    "runner_data": {
      "stt_binary_handler_id": 1,
      "timeout":               300
    }
  }
}
```

`stt_binary_handler_id` is the byte prefix used when sending audio (see below).

### wake_word-start

```json
{
  "type": "wake_word-start",
  "data": {
    "engine":   "openwakeword",
    "metadata": {},
    "timeout":  3
  }
}
```

### wake_word-end

```json
{
  "type": "wake_word-end",
  "data": {
    "wake_word_output": {
      "wake_word_id": "ok_nabu",
      "timestamp":    1234700
    }
  }
}
```

### stt-start

```json
{
  "type": "stt-start",
  "data": {
    "engine":   "faster-whisper",
    "metadata": { "language": "en" }
  }
}
```

### stt-vad-start / stt-vad-end

```json
{ "type": "stt-vad-start", "data": { "timestamp": 1234600 } }
{ "type": "stt-vad-end",   "data": { "timestamp": 1234850 } }
```

### stt-end

```json
{
  "type": "stt-end",
  "data": {
    "stt_output": {
      "text": "turn off the kitchen lights"
    }
  }
}
```

### intent-start

```json
{
  "type": "intent-start",
  "data": {
    "engine":       "conversation",
    "language":     "en",
    "intent_input": { "text": "turn off the kitchen lights" }
  }
}
```

### intent-progress

Emitted during LLM-backed conversation agents that stream their response.

```json
{
  "type": "intent-progress",
  "data": {
    "chat_log_delta":     { "role": "assistant", "content": "Turning " },
    "tts_start_streaming": false
  }
}
```

### intent-end

```json
{
  "type": "intent-end",
  "data": {
    "intent_output": {
      "conversation_id": "01JXYZ...",
      "response": {
        "speech": {
          "plain": { "speech": "Turning off the kitchen lights." }
        },
        "response_type": "action_done",
        "data":          {}
      }
    }
  }
}
```

### tts-start

```json
{
  "type": "tts-start",
  "data": {
    "engine":   "piper",
    "language": "en",
    "voice":    "en_US-lessac-medium",
    "tts_input": "Turning off the kitchen lights."
  }
}
```

### tts-end

```json
{
  "type": "tts-end",
  "data": {
    "tts_output": {
      "media_id": "media-source://tts/...",
      "mime_type": "audio/mpeg",
      "url":       "/api/tts_proxy/..."
    }
  }
}
```

### run-end

```json
{ "type": "run-end", "data": {} }
```

### error

```json
{
  "type": "error",
  "data": {
    "code":    "stt-no-text-recognized",
    "message": "No text was recognized from the audio."
  }
}
```

---

## Sending Audio

After receiving `run-start` (and after `stt-start` if starting at wake-word stage), binary audio
is sent as **raw WebSocket binary frames**:

```
[handler_id_byte] [raw PCM audio bytes...]
```

- The `handler_id_byte` must match the `stt_binary_handler_id` from `run-start`.
- Audio format: **16 kHz, 16-bit signed little-endian, mono PCM**.
- To signal end-of-audio: send a single-byte binary frame containing only the `handler_id_byte`.

```
# Audio chunk frame:
| 0x01 | <PCM bytes> |

# End-of-audio signal:
| 0x01 |
```

---

## Error Codes

| Code | Stage | Description |
|---|---|---|
| `wake-engine-missing` | Wake word | No wake-word engine configured |
| `wake-stream-failed` | Wake word | Audio stream error during wake detection |
| `stt-provider-missing` | STT | No speech-to-text provider configured |
| `stt-provider-unsupported-metadata` | STT | Audio format not supported |
| `stt-stream-failed` | STT | Audio stream error |
| `stt-no-text-recognized` | STT | Engine returned empty transcription |
| `intent-not-supported` | Intent | No conversation agent available |
| `intent-failed` | Intent | Conversation agent returned error |
| `tts-not-supported` | TTS | No TTS engine configured |
| `tts-failed` | TTS | TTS synthesis error |
| `tts-audio-conversion-error` | TTS | Audio format conversion failed |
| `unknown` | Any | Unclassified error |
| `timeout` | Any | Pipeline stage timed out |

---

## Satellite Management Commands

### Get satellite configuration

```json
{
  "id": 2,
  "type": "assist_satellite/get_configuration",
  "entity_id": "assist_satellite.voice_pe"
}
```

Response:
```json
{
  "id": 2,
  "type": "result",
  "success": true,
  "result": {
    "active_wake_words": ["ok_nabu"],
    "available_wake_words": [
      { "id": "ok_nabu", "name": "Ok Nabu", "trained_languages": ["en"] },
      { "id": "hey_jarvis", "name": "Hey Jarvis", "trained_languages": ["en"] }
    ],
    "max_active_wake_words": 1,
    "pipeline_entity_id": "select.voice_pe_pipeline"
  }
}
```

### Set wake words

```json
{
  "id": 3,
  "type": "assist_satellite/set_wake_words",
  "entity_id": "assist_satellite.voice_pe",
  "wake_word_ids": ["ok_nabu"]
}
```

### Intercept next wake word

Used by the UI to capture the next detected wake word for configuration purposes.

```json
{
  "id": 4,
  "type": "assist_satellite/intercept_wake_word",
  "entity_id": "assist_satellite.voice_pe"
}
```

Response when detected:
```json
{
  "id": 4,
  "type": "result",
  "success": true,
  "result": { "wake_word_phrase": "ok nabu" }
}
```

---

## Minimal Python Example

```python
import asyncio
import websockets
import json

HA_URL   = "ws://homeassistant.local:8123/api/websocket"
HA_TOKEN = "<long-lived-access-token>"

async def run_pipeline():
    async with websockets.connect(HA_URL) as ws:
        # Authenticate
        await ws.recv()  # auth_required
        await ws.send(json.dumps({"type": "auth", "access_token": HA_TOKEN}))
        await ws.recv()  # auth_ok

        # Start pipeline (text intent, TTS response)
        await ws.send(json.dumps({
            "id": 1,
            "type": "assist_pipeline/run",
            "start_stage": "intent",
            "end_stage":   "tts",
            "input":       { "text": "turn on the living room lights" }
        }))

        # Consume events
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("type") == "event":
                event = msg["event"]
                print(event["type"], event.get("data", {}))
                if event["type"] in ("run-end", "error"):
                    break

asyncio.run(run_pipeline())
```
