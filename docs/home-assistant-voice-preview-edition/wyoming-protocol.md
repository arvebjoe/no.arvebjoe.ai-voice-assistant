# Wyoming Protocol — Complete Specification

Wyoming is an open, peer-to-peer protocol used by Home Assistant to connect voice-processing
microservices (STT, TTS, wake-word, intent). It is the standard transport used internally by the
Assist pipeline when communicating with add-ons and external services.

Repository: https://github.com/OHF-Voice/wyoming

---

## Wire Format

Every Wyoming message is a **newline-terminated JSON header** optionally followed by a binary payload:

```
{ "type": "<event-type>", "data": { ... }, "data_length": N, "payload_length": N }\n
<data_length bytes — additional JSON merged into data>
<payload_length bytes — binary, usually raw PCM audio>
```

| Field | Required | Description |
|---|---|---|
| `type` | Yes | Event type string (see tables below) |
| `data` | No | Event-specific JSON object |
| `data_length` | No | Byte length of additional JSON block after the header line |
| `payload_length` | No | Byte length of binary payload (e.g. PCM audio) |

When `data_length` is present, the extra bytes are parsed as JSON and **merged into** `data`.
When `payload_length` is present, the binary bytes follow the extra-data block.

### Default Port

Wyoming services listen on **TCP port 10700** by default (configurable).

---

## Service Discovery

### describe (client → server)

Requests a description of all services hosted by the server.

```json
{ "type": "describe" }
```

### info (server → client)

Returns a description of all available models and capabilities.

```json
{
  "type": "info",
  "data": {
    "asr":    [ <AsrProgram>, ... ],
    "tts":    [ <TtsProgram>, ... ],
    "wake":   [ <WakeProgram>, ... ],
    "intent": [ <IntentProgram>, ... ],
    "handle": [ <HandleProgram>, ... ],
    "mic":    [ <MicProgram>, ... ],
    "snd":    [ <SndProgram>, ... ],
    "satellite": <SatelliteInfo | null>
  }
}
```

Each program object contains:

| Field | Type | Description |
|---|---|---|
| `name` | string | Service identifier |
| `description` | string | Human-readable description |
| `version` | string | Version string |
| `installed` | bool | Whether the service is ready |
| `attribution` | object | Author/license metadata |
| `models` | array | Available models (language, speakers, etc.) |
| `supports_*_streaming` | bool | Whether streaming mode is supported |

---

## Audio Events

### audio-start (sender → receiver)

Signals the beginning of an audio stream and declares its format.

```json
{
  "type": "audio-start",
  "data": {
    "rate":      16000,
    "width":     2,
    "channels":  1,
    "timestamp": 1234567
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `rate` | int | required | Sample rate in Hz |
| `width` | int | required | Sample width in bytes (2 = 16-bit) |
| `channels` | int | required | Number of channels (1 = mono) |
| `timestamp` | int? | null | Stream start time in milliseconds |

### audio-chunk (sender → receiver)

One chunk of raw PCM audio.

```json
{
  "type": "audio-chunk",
  "data": {
    "rate":      16000,
    "width":     2,
    "channels":  1,
    "timestamp": 1234567
  },
  "payload_length": 3200
}
<3200 bytes of raw PCM>
```

| Field | Type | Description |
|---|---|---|
| `rate` | int | Sample rate in Hz |
| `width` | int | Sample width in bytes |
| `channels` | int | Number of audio channels |
| `timestamp` | int? | Chunk timestamp in milliseconds |
| payload | bytes | Raw PCM audio data |

### audio-stop (sender → receiver)

Signals the end of an audio stream.

```json
{
  "type": "audio-stop",
  "data": { "timestamp": 1234999 }
}
```

---

## Speech-to-Text (ASR)

### transcribe (client → STT server)

Initiates a transcription session. Audio chunks follow.

```json
{
  "type": "transcribe",
  "data": {
    "name":     "whisper",
    "language": "en",
    "context":  {}
  }
}
```

| Field | Type | Description |
|---|---|---|
| `name` | string? | Model name to use |
| `language` | string? | BCP-47 language code |
| `context` | object? | Carry-over context from previous interaction |

Flow after `transcribe`:
```
client → transcribe
client → audio-start
client → audio-chunk (×N)
client → audio-stop
server → transcript
```

### transcript (STT server → client)

Returns the final transcription result.

```json
{
  "type": "transcript",
  "data": {
    "text":     "turn off the kitchen lights",
    "language": "en",
    "context":  {}
  }
}
```

### Streaming Transcription

For real-time partial results:

| Direction | Type | Description |
|---|---|---|
| server → client | `transcript-start` | Streaming session begins |
| server → client | `transcript-chunk` | Partial transcription text |
| server → client | `transcript-stop` | Streaming session ends |

```json
{ "type": "transcript-start", "data": { "context": {}, "language": "en" } }
{ "type": "transcript-chunk", "data": { "text": "turn off" } }
{ "type": "transcript-chunk", "data": { "text": "turn off the kitchen lights" } }
{ "type": "transcript-stop" }
```

---

## Text-to-Speech (TTS)

### synthesize (client → TTS server)

Requests synthesis of text into audio.

```json
{
  "type": "synthesize",
  "data": {
    "text": "Turning off the kitchen lights.",
    "voice": {
      "name":     "en_US-lessac-medium",
      "language": "en",
      "speaker":  null
    },
    "context": {}
  }
}
```

| Field | Type | Description |
|---|---|---|
| `text` | string | Text to synthesise |
| `voice.name` | string? | Voice model name |
| `voice.language` | string? | BCP-47 language code |
| `voice.speaker` | string? | Speaker ID within multi-speaker model |
| `context` | object? | Carry-over context |

After `synthesize`, the server streams audio back:
```
client → synthesize
server → audio-start
server → audio-chunk (×N)
server → audio-stop
```

### Streaming Synthesis (text chunks → audio)

When the client has partial text to synthesise progressively:

| Direction | Type | Description |
|---|---|---|
| client → server | `synthesize-start` | Begin streaming synthesis session |
| client → server | `synthesize-chunk` | Chunk of text to synthesise |
| client → server | `synthesize-stop` | End of text input |
| server → client | `synthesize-stopped` | Server confirms synthesis complete |

```json
{ "type": "synthesize-start", "data": { "voice": { "name": "en_US-lessac-medium" } } }
{ "type": "synthesize-chunk", "data": { "text": "Turning off " } }
{ "type": "synthesize-chunk", "data": { "text": "the kitchen lights." } }
{ "type": "synthesize-stop" }
```

---

## Wake Word Detection

### detect (client → wake-word server)

Initiates wake-word detection. Audio follows.

```json
{
  "type": "detect",
  "data": {
    "names":   ["ok nabu", "hey jarvis"],
    "context": {}
  }
}
```

| Field | Type | Description |
|---|---|---|
| `names` | string[]? | Restrict detection to these model names (null = all) |
| `context` | object? | Context passed through on detection |

Flow:
```
client → detect
client → audio-start
client → audio-chunk (×N)  ← continuous until detected or stopped
server → detection  (or)
server → not-detected
```

### detection (wake-word server → client)

Wake word was detected.

```json
{
  "type": "detection",
  "data": {
    "name":      "ok nabu",
    "timestamp": 1234700,
    "speaker":   null,
    "context":   {}
  }
}
```

| Field | Type | Description |
|---|---|---|
| `name` | string? | Model / wake phrase that triggered |
| `timestamp` | int? | Detection time in milliseconds |
| `speaker` | string? | Speaker ID if personalised |
| `context` | object? | Context passed forward |

### not-detected (server → client)

Audio stream ended without a detection.

```json
{ "type": "not-detected", "data": { "context": {} } }
```

---

## Voice Activity Detection (VAD)

These events are emitted by a VAD service running continuously alongside the audio stream.

### voice-started

```json
{ "type": "voice-started", "data": { "timestamp": 1234600 } }
```

### voice-stopped

```json
{ "type": "voice-stopped", "data": { "timestamp": 1234850 } }
```

| Field | Type | Description |
|---|---|---|
| `timestamp` | int? | Event time in milliseconds |

---

## Intent Recognition

### recognize (client → intent server)

Submit text for intent recognition.

```json
{
  "type": "recognize",
  "data": {
    "text":     "turn off the kitchen lights",
    "language": "en",
    "context":  {}
  }
}
```

### intent (server → client)

```json
{
  "type": "intent",
  "data": {
    "name":     "HassTurnOff",
    "entities": [
      { "name": "area", "value": "kitchen" }
    ],
    "text":    "Turning off the kitchen lights.",
    "context": {}
  }
}
```

### not-recognized (server → client)

```json
{ "type": "not-recognized", "data": { "text": "Sorry, I didn't understand that.", "context": {} } }
```

---

## Intent Handling

### handled (handle server → client)

Intent was successfully handled.

```json
{
  "type": "handled",
  "data": {
    "text":    "Done.",
    "context": {}
  }
}
```

### not-handled (handle server → client)

```json
{ "type": "not-handled", "data": { "text": "I can't do that.", "context": {} } }
```

### Streaming Handle Response

| Direction | Type | Payload |
|---|---|---|
| server → client | `handled-start` | `{ "context": {} }` |
| server → client | `handled-chunk` | `{ "text": "Done, " }` |
| server → client | `handled-stop` | — |

---

## Satellite Control

These events coordinate a **remote voice satellite** (like the Voice PE via the Wyoming satellite
bridge) with the Wyoming server running in Home Assistant.

| Type | Direction | Description |
|---|---|---|
| `run-satellite` | server → satellite | Server is ready to run a pipeline |
| `pause-satellite` | server → satellite | Server is temporarily unavailable |
| `streaming-started` | satellite → server | Satellite has begun streaming audio |
| `streaming-stopped` | satellite → server | Satellite has stopped streaming |
| `satellite-connected` | satellite → server | Satellite connected to server |
| `satellite-disconnected` | satellite → server | Satellite disconnected |

All satellite events have an empty `data` object.

### run-pipeline (server → satellite)

Instructs the satellite to start a specific pipeline run.

```json
{
  "type": "run-pipeline",
  "data": {
    "start_stage":     "wake",
    "end_stage":       "tts",
    "wake_word_name":  "ok nabu",
    "wake_word_names": ["ok nabu"],
    "restart_on_end":  true,
    "announce_text":   null
  }
}
```

| Field | Type | Description |
|---|---|---|
| `start_stage` | string | One of: `wake`, `asr`, `intent`, `handle`, `tts` |
| `end_stage` | string | One of: `asr`, `intent`, `handle`, `tts` |
| `wake_word_name` | string? | Single wake word to detect |
| `wake_word_names` | string[]? | Multiple wake words to detect |
| `restart_on_end` | bool | Restart pipeline after completion (default: false) |
| `announce_text` | string? | Text to announce before listening |

---

## Timer Events

Home Assistant sends timer events to the satellite so it can reflect timer state locally.

### timer-started

```json
{
  "type": "timer-started",
  "data": {
    "id":            "timer_1",
    "total_seconds": 300,
    "name":          "Pizza timer",
    "start_hours":   0,
    "start_minutes": 5,
    "start_seconds": 0
  }
}
```

### timer-updated

```json
{
  "type": "timer-updated",
  "data": {
    "id":            "timer_1",
    "is_active":     true,
    "total_seconds": 240
  }
}
```

### timer-cancelled

```json
{ "type": "timer-cancelled", "data": { "id": "timer_1" } }
```

### timer-finished

```json
{ "type": "timer-finished", "data": { "id": "timer_1" } }
```

---

## Playback Confirmation

### played (satellite → server)

Sent after TTS audio has finished playing on the satellite's speaker.

```json
{ "type": "played" }
```

---

## Connectivity

### ping / pong

```json
{ "type": "ping" }
{ "type": "pong" }
```

---

## User Events

### user-event

Custom extensibility hook — arbitrary payloads forwarded between components.

```json
{ "type": "user-event", "data": { "data": { "key": "value" } } }
```

---

## Complete Event Reference

| Event type | Direction | Category |
|---|---|---|
| `describe` | client → server | Discovery |
| `info` | server → client | Discovery |
| `audio-start` | bidirectional | Audio |
| `audio-chunk` | bidirectional | Audio |
| `audio-stop` | bidirectional | Audio |
| `transcribe` | client → STT | ASR |
| `transcript` | STT → client | ASR |
| `transcript-start` | STT → client | ASR streaming |
| `transcript-chunk` | STT → client | ASR streaming |
| `transcript-stop` | STT → client | ASR streaming |
| `synthesize` | client → TTS | TTS |
| `synthesize-start` | client → TTS | TTS streaming |
| `synthesize-chunk` | client → TTS | TTS streaming |
| `synthesize-stop` | client → TTS | TTS streaming |
| `synthesize-stopped` | TTS → client | TTS streaming |
| `detect` | client → wake | Wake word |
| `detection` | wake → client | Wake word |
| `not-detected` | wake → client | Wake word |
| `voice-started` | VAD → client | VAD |
| `voice-stopped` | VAD → client | VAD |
| `recognize` | client → intent | Intent |
| `intent` | intent → client | Intent |
| `not-recognized` | intent → client | Intent |
| `handled` | handle → client | Handle |
| `not-handled` | handle → client | Handle |
| `handled-start` | handle → client | Handle streaming |
| `handled-chunk` | handle → client | Handle streaming |
| `handled-stop` | handle → client | Handle streaming |
| `run-satellite` | server → satellite | Satellite control |
| `pause-satellite` | server → satellite | Satellite control |
| `streaming-started` | satellite → server | Satellite control |
| `streaming-stopped` | satellite → server | Satellite control |
| `satellite-connected` | satellite → server | Satellite control |
| `satellite-disconnected` | satellite → server | Satellite control |
| `run-pipeline` | server → satellite | Satellite control |
| `timer-started` | server → satellite | Timers |
| `timer-updated` | server → satellite | Timers |
| `timer-cancelled` | server → satellite | Timers |
| `timer-finished` | server → satellite | Timers |
| `played` | satellite → server | Playback |
| `ping` | bidirectional | Connectivity |
| `pong` | bidirectional | Connectivity |
| `user-event` | bidirectional | Extensibility |
