# OpenAI API Improvements

> **Note to Claude (continuing this task):**
> This document was created in a remote Claude Code session (web) that couldn't push to GitHub due to missing write permissions on the GitHub App integration.
>
> **What we did:** Audited the OpenAI Realtime API implementation in `src/llm/openai-realtime-agent.mts` against the current OpenAI documentation and identified 12 improvements.
>
> **What to do next:** Implement the changes listed below, in roughly priority order. Start with the trivial/low-effort items (4, 7, 10, 12, 1, 2, 3, 5, 6) before tackling the medium-effort refactors (8, 9). Item 11 is optional/nice-to-have. All changes are in `src/llm/openai-realtime-agent.mts` unless otherwise noted.

---

Audit of the current implementation against the OpenAI Realtime API GA release and related audio API updates (as of May 2026). Grouped by impact.

---

## 1. Upgrade to Latest Realtime Model Snapshot

**File:** `src/llm/openai-realtime-agent.mts:171`

**Current:**
```typescript
url: opts.url ?? `wss://api.openai.com/v1/realtime?model=gpt-realtime`,
```

The `gpt-realtime` alias always resolves to the _latest_ model, which can change without notice. For production stability, pin to a dated snapshot.

**Recommended:**
```typescript
url: opts.url ?? `wss://api.openai.com/v1/realtime?model=gpt-realtime-2025-08-28`,
```

Available snapshots:
- `gpt-realtime-2025-08-28` — GA release, best instruction-following and tool precision
- `gpt-realtime-mini-2025-12-15` — cheaper/faster for cost-sensitive deployments

**Why it matters:** Pinning prevents silent regressions when OpenAI updates the model pointed to by the alias.

---

## 2. Upgrade Transcription Model to `gpt-realtime-whisper`

**File:** `src/llm/openai-realtime-agent.mts:825`

**Current:**
```typescript
transcription: {
    model: "whisper-1",
    language: this.options.languageCode,
},
```

`whisper-1` is the oldest transcription model available in the Realtime API. OpenAI introduced `gpt-realtime-whisper` specifically for streaming sessions — it offers controllable latency via a `delay` parameter and substantially lower word error rates (especially in non-English languages).

**Recommended:**
```typescript
transcription: {
    model: "gpt-realtime-whisper",
    language: this.options.languageCode,
    delay: "low",  // "minimal" | "low" | "medium" | "high" | "xhigh"
},
```

The `delay` values trade transcript latency for accuracy:
- `"minimal"` / `"low"` — fastest, slightly more errors; good for responsive conversational use
- `"medium"` — balanced default
- `"high"` / `"xhigh"` — highest accuracy, noticeable delay before transcript arrives

For a voice assistant answering commands, `"low"` is a sensible starting point; `"medium"` if transcript quality matters more than speed.

---

## 3. Enable Noise Reduction for Input Audio

**File:** `src/llm/openai-realtime-agent.mts:829`

**Current:**
```typescript
noise_reduction: null,
```

The `noise_reduction` field is already in the session payload but disabled. For devices in living rooms or kitchens, background noise is common. The GA API supports two modes:

**Recommended:**
```typescript
noise_reduction: {
    type: "near_field"  // or "far_field" for distant/speakerphone setups
},
```

- `"near_field"` — optimised for close-microphone devices (handheld or desk mic)
- `"far_field"` — optimised for room-microphone or speakerphone setups (likely better for ESP32 devices mounted on walls or shelves)

This can meaningfully improve transcription quality without any code changes beyond the session payload.

---

## 4. Handle `response.output_audio.done` (Missing GA Event Alias)

**File:** `src/llm/openai-realtime-agent.mts:588`

**Current:**
```typescript
case "response.audio.done":
    this.emit("audio.done");
    break;
```

The GA Realtime API renamed `response.audio.done` to `response.output_audio.done`. The preview name still works today but may be dropped. The audio delta case already handles both names; the done event should too.

**Recommended:**
```typescript
case "response.output_audio.done":
case "response.audio.done":
    this.emit("audio.done");
    break;
```

---

## 5. Handle Streaming Input Transcription Events

**File:** `src/llm/openai-realtime-agent.mts` (switch block, no current handler)

Two transcription events from the GA API are currently unhandled and fall through to the default `event` emitter:

| Event | When it fires |
|---|---|
| `conversation.item.input_audio_transcription.delta` | Partial transcript during speech |
| `conversation.item.input_audio_transcription.failed` | Transcription error |

**Recommended additions:**
```typescript
case "conversation.item.input_audio_transcription.delta":
    this.emit("transcript.delta", msg.delta);
    break;

case "conversation.item.input_audio_transcription.failed":
    this.logger.error("Input transcription failed", msg.error);
    this.emit("response.error", msg);
    break;
```

The delta events would let the UI display a live "what I heard" transcript during speech, which improves perceived responsiveness.

---

## 6. Add `instructions` Parameter to the TTS Call

**File:** `src/llm/openai-realtime-agent.mts:401`

**Current:**
```typescript
body: JSON.stringify({
    model: "gpt-4o-mini-tts",
    voice: this.options.voice,
    input: text,
    response_format: "flac"
}),
```

`gpt-4o-mini-tts` supports an `instructions` field that steers delivery style — tone, pacing, formality — without modifying the text itself. This is separate from the voice selection and allows per-call customisation.

**Recommended:**
```typescript
body: JSON.stringify({
    model: "gpt-4o-mini-tts-2025-12-15",  // pin to stable snapshot
    voice: this.options.voice,
    input: text,
    response_format: "flac",
    instructions: "Speak in a natural, helpful tone suitable for a smart home assistant."
}),
```

The `instructions` value can also be surfaced as a user-configurable setting (alongside the existing `ai_instructions` field) for users who want a different delivery style.

Also note: pinning to `gpt-4o-mini-tts-2025-12-15` gives ~35% lower word error rate compared to the original `gpt-4o-mini-tts` alias.

---

## 7. Add Missing Voices to the Voice Selector

**File:** `src/settings/settings-manager.mts` (voice list)

**Current voices (10):** alloy, ash, ballad, coral, echo, sage, shimmer, verse, cedar, marin

The TTS API now supports **13 voices**. Three are missing from the selector:

| Missing voice | Character |
|---|---|
| `fable` | Expressive, storytelling |
| `nova` | Bright, energetic |
| `onyx` | Deep, authoritative |

**Recommended:** Add `fable`, `nova`, and `onyx` to the available voice list in settings and the Homey app settings UI.

---

## 8. Simplify VAD Response Trigger

**File:** `src/llm/openai-realtime-agent.mts:836–838` and `614–629`

**Current approach:**
- `turn_detection.create_response` is set to `false`
- `conversation.item.input_audio_transcription.completed` fires when speech ends
- The handler manually copies the transcript as a new `input_text` conversation item, stores its `item_id`, then waits for `conversation.item.done` to call `response.create`

This is a roundabout flow that adds an extra round-trip and duplicates the transcript in the conversation history.

**Recommended approach:**
Set `create_response: true` in the VAD config so the model responds automatically when speech ends:
```typescript
turn_detection: {
    type: "server_vad",
    threshold: 0.6,
    prefix_padding_ms: 400,
    silence_duration_ms: 600,
    idle_timeout_ms: null,
    create_response: true,    // model responds automatically on speech end
    interrupt_response: true  // allow user to interrupt mid-response
},
```

Then remove the manual `sendTranscript()` call and `transcript_id` tracking. The transcript can still be captured from `conversation.item.input_audio_transcription.completed` for display purposes without re-injecting it.

This also enables `interrupt_response: true`, which lets the user cut off a long response — a natural behaviour for a voice assistant.

---

## 9. Consider `gpt-realtime-mini` for Cost Optimisation

The `gpt-realtime-mini` model (snapshots: `gpt-realtime-mini-2025-10-06`, `gpt-realtime-mini-2025-12-15`) is substantially cheaper and faster than `gpt-realtime` while covering most smart home control tasks (turning lights on/off, adjusting temperature, basic queries).

**Suggested approach:** Expose a "model quality" setting — "Standard" (`gpt-realtime-mini`) vs "Full" (`gpt-realtime`) — so users can choose the cost/quality tradeoff. The mini model is likely sufficient for the majority of home automation commands.

---

## 10. Pin `OpenAI-Beta` Header Removal (Already Done — Verify)

**File:** `src/llm/openai-realtime-agent.mts:222`

The GA API requires that the `OpenAI-Beta: realtime=v1` header is **not** sent. The current code only sends `Authorization`, which is correct. However, this should be explicitly documented in the code or in a migration note so it isn't accidentally re-added.

```typescript
// GA endpoint: do NOT include OpenAI-Beta: realtime=v1 header
this.ws = new WebSocket(this.options.url, {
    headers: {
        Authorization: `Bearer ${this.options.apiKey}`
    },
});
```

---

## 11. Rate Limit Event Handling

**File:** `src/llm/openai-realtime-agent.mts:559`

**Current:**
```typescript
case "rate_limits.updated":
    this.emit("rate_limits.updated", msg);
    break;
```

The event is forwarded but nothing acts on it. The `rate_limits.updated` payload contains real-time token and request consumption data. Consider:

- Logging remaining tokens at warning thresholds
- Surfacing a "API quota low" Homey notification when token limits approach depletion
- Using the data to throttle tool calls or batch responses

---

## 12. `idle_timeout_ms` for Inactive Sessions

**File:** `src/llm/openai-realtime-agent.mts:835`

**Current:**
```typescript
idle_timeout_ms: null,
```

Setting a reasonable idle timeout (e.g. `30000` ms = 30 seconds) will cause the server to close the session automatically if no audio is received, rather than keeping an idle WebSocket alive. This reduces unnecessary API costs and frees server-side session resources between voice interactions.

```typescript
idle_timeout_ms: 30000,
```

The existing reconnect logic will re-establish the connection when the next voice session starts.

---

## Summary Table

| # | Change | Impact | Effort |
|---|---|---|---|
| 1 | Pin model to dated snapshot | Stability | Low |
| 2 | Switch to `gpt-realtime-whisper` transcription | Accuracy / Latency | Low |
| 3 | Enable `noise_reduction` | Transcription quality | Low |
| 4 | Add `response.output_audio.done` alias | Correctness | Trivial |
| 5 | Handle transcription delta/failed events | UX / Error handling | Low |
| 6 | Add `instructions` to TTS call | Voice quality / Customisation | Low |
| 7 | Add missing voices (fable, nova, onyx) | Feature completeness | Trivial |
| 8 | Simplify VAD → response trigger | Code quality / UX | Medium |
| 9 | Expose `gpt-realtime-mini` as option | Cost reduction | Medium |
| 10 | Document beta header removal | Future-proofing | Trivial |
| 11 | Act on `rate_limits.updated` | Observability | Low |
| 12 | Set `idle_timeout_ms` | Cost / Resource efficiency | Trivial |

---

*Sources consulted:*
- [Realtime API — developer notes (GA release)](https://developers.openai.com/blog/realtime-api)
- [Introducing gpt-realtime](https://openai.com/index/introducing-gpt-realtime/)
- [Next-generation audio models](https://openai.com/index/introducing-our-next-generation-audio-models/)
- [Advancing voice intelligence](https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/)
- [gpt-realtime-whisper model page](https://developers.openai.com/api/docs/models/gpt-realtime-whisper)
- [gpt-4o-mini-tts model page](https://developers.openai.com/api/docs/models/gpt-4o-mini-tts)
- [Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [Text to speech guide](https://developers.openai.com/api/docs/guides/text-to-speech)
