# Voice provider architecture

How the app decouples the device from the LLM/voice backend, so providers
(OpenAI Realtime, Google Gemini Live, and future local pipelines) are
interchangeable.

## Why

`voice-assistant-device.mts` orchestrates a session (ESP mic ↔ provider ↔
speaker, plus Homey tool calls). It used to talk directly to a concrete OpenAI
class. The abstraction inserts a **seam** so the device depends only on an
interface, and the actual backend is chosen at runtime by a setting. This lets
us swap in different companies/APIs — a single realtime speech-in/speech-out
socket, or a composed pipeline (local Whisper STT → Claude/Ollama LLM →
Piper/OpenAI TTS), mixing WebSocket and REST transports — without the device
knowing.

## The seam

```
voice-assistant-device.mts
        │  depends on IVoiceProvider (never a concrete class)
        ▼
createVoiceProvider(homey, toolManager, options)   ← src/llm/voice-provider-factory.mts
        │  picks by the `voice_provider` setting
        ├── OpenAIRealtimeProvider    (src/llm/providers/openai-realtime-agent.mts)
        ├── GeminiLiveProvider        (src/llm/providers/gemini-live-provider.mts)
        ├── MistralRealtimeProvider   (src/llm/providers/mistral-realtime-provider.mts)
        └── LocalPipelineProvider     (src/llm/providers/local-pipeline-provider.mts)
```

Key files:

| File | Role |
|------|------|
| `src/llm/voice-provider.mts` | The port: `IVoiceProvider` interface, `VoiceProviderOptions`, `VoiceProviderEvents` |
| `src/llm/voice-provider-factory.mts` | `createVoiceProvider()` — selects provider + resolves its API key |
| `src/llm/providers/openai-realtime-agent.mts` | `OpenAIRealtimeProvider` (default) |
| `src/llm/providers/gemini-live-provider.mts` | `GeminiLiveProvider` |
| `src/llm/agent-instructions.mts` | Shared system-prompt loader used by every provider |

## The `IVoiceProvider` contract

A provider is a black box: PCM mic audio in → audio/text + tool calls out, plus
lifecycle and on-the-fly settings updates. It is a `TypedEmitter`.

**Provider-declared facts** (the device reads these):

- `inputSampleRate: number` — the rate the provider wants for `sendAudioChunk`.
  The PE mic is 16 kHz; the device upsamples to this rate or passes 16 kHz
  through. OpenAI = `24000`, Gemini = `16000`.
- `apiKeySettingKey: string` — which global setting holds this provider's key
  (`'openai_api_key'` / `'gemini_api_key'`). The device watches the active one.

**Methods:**

- Lifecycle: `start()`, `close(code?, reason?)`, `restart()`, `isConnected()`, `hasApiKey()`
- Audio/conversation: `sendAudioChunk(pcm16Mono)`, `resetConversation()`
- Text: `sendTextForAudioResponse(text)`, `sendTextForTextResponse(question)`, `textToSpeech(text): Promise<Buffer>`
- Settings: `updateApiKey`, `updateVoice`, `updateLanguage`, `updateAdditionalInstructions`, `updateZone`, `updateTimerSupport`

**Events** (`VoiceProviderEvents`): `open`, `close`, `Healthy`/`Unhealthy`,
`missing_api_key`, `error`, `silence`, `audio.delta`, `transcript.delta`,
`transcript.done`, `input_transcript.delta`, `text.delta`/`text.done`,
`tool.called` (+ `tool.arguments.*`, `tool.call.started`), `response.done`,
reconnection events, etc. The map is a **superset** of what any single consumer
uses (the OpenAI tests subscribe to several beyond the device's set).

### Cross-seam contracts (must hold)

- `sendAudioChunk` input: **PCM16, mono, `inputSampleRate` Hz**.
- `audio.delta` output: **PCM16, mono, 24 kHz** (the device segments → FLAC).
- `textToSpeech` returns a **FLAC** buffer (reuse `pcmToFlacBuffer` from
  `src/helpers/audio-encoders.mts`).

## How the device uses it

1. Builds `VoiceProviderOptions` (voice, language, instructions, zone, timers).
2. `this.provider = createVoiceProvider(homey, toolManager, options)` — the
   factory sets `options.apiKey` from the right setting for the chosen provider.
3. Configures the mic resampler from `provider.inputSampleRate`: `!== 16000` →
   `Pcm16kTo24k`; `=== 16000` → passthrough (no resampler).
4. Wires the provider's events to the ESP client / speaker pipeline and drives
   tool calls through `ToolManager`.
5. On settings change, watches `newSettings[provider.apiKeySettingKey]` and the
   voice/language/instructions, then `provider.restart()`.

## Providers

### OpenAIRealtimeProvider (default, `openai-realtime`)
The original OpenAI Realtime WebSocket agent, now implementing the interface.
24 kHz audio in/out; output modality switched live; back-compat names
(`OpenAIRealtimeAgent`, `RealtimeOptions`, `RealtimeEvents`) preserved for tests.

### MistralRealtimeProvider (`mistral-realtime`)
First-class Mistral engine. Mistral has **no unified speech-to-speech realtime
API** (only realtime *transcription* over websocket), so this provider is a
thin `LocalPipelineProvider` subclass that hardwires the Mistral-native chain
— Voxtral Realtime STT (streaming websocket, fed while the user talks via the
`ISttClient.createStream` seam) → Mistral chat completions (tools) → Voxtral
TTS — exactly Mistral's own voice-agent reference design. Key
`mistral_api_key`, models `mistral_stt_realtime_model` / `mistral_model` /
`mistral_tts_model`: the SAME settings the custom pipeline's Mistral backends
use, so one account/key configuration serves both. Only `buildPipeline()` (and
the key setting + voice list) differ from the base class; VAD, tool loop,
sentence-by-sentence TTS and health checks are inherited.

### GeminiLiveProvider (`gemini-realtime`)
Google Gemini Live API via the `@google/genai` SDK. Key `gemini_api_key`.

- **Realtime path**: `ai.live.connect({ model, callbacks, config })`;
  `config = { responseModalities:[AUDIO], inputAudioTranscription:{},
  outputAudioTranscription:{}, systemInstruction, tools }`.
  - Mic: `sendRealtimeInput({ audio: { data: base64, mimeType:'audio/pcm;rate=16000' }})`.
  - Out: `message.data` (PCM16/24k) → `audio.delta`; input/output transcription →
    `transcript.*`; `serverContent.turnComplete` → `response.done`.
  - Tools: `toolCall.functionCalls` → run handlers → `sendToolResponse(...)`.
  - Server VAD: first model output of a turn → emit `silence` + final
    `transcript.done` (so the device closes the mic).
- **Text-as-text** (`sendTextForTextResponse`, used by the ask-as-text flow card
  and the emulator `ask`): one-shot `generateContent` with a function-calling
  loop → emits `text.done` (a live session is fixed to one response modality).
- **Tool schema**: `ToolManager` emits OpenAI's `{type:"function", ...}` shape;
  the provider translates to `{ functionDeclarations:[...] }` and strips
  `additionalProperties` (`sanitizeSchema`).
- **TTS**: a Gemini TTS model → PCM(24k) → `pcmToFlacBuffer` → FLAC.

## Settings

Global settings (Homey app settings, `settings/index.html`):

- `voice_provider` — `openai-realtime` (default), `gemini-realtime`,
  `mistral-realtime`, or `local`.
- `openai_api_key`, `gemini_api_key`, `mistral_api_key` — one per provider
  (the Mistral key is shared with the custom pipeline's Mistral stages).
- Shared: `selected_voice`, `selected_language_code/name`, `ai_instructions`.

`SettingsManager.getAvailableProviders()` lists the options for the UI; the
known keys are read into the globals snapshot in `refreshGlobals()`.

The **voice list is per-provider**: each provider exposes a static
`getAvailableVoices()`, surfaced via `getVoicesForProvider()` in the factory and
served to the settings page through the `GET /voices?provider=<id>` app API
(`api.mts`). `settings/index.html` re-fetches the list when the provider
dropdown changes. `selected_voice` is shared across providers, so each provider
normalizes an unknown voice to its own default (`openaiVoiceName()` →
`ash`; `geminiVoiceName()` → `Kore`) rather than sending an invalid value.

Switching providers currently takes effect on the next device/app init (live
in-session switching is not implemented).

## Adding a new provider

1. Create a class in `src/llm/providers/` that `implements IVoiceProvider`
   (set `inputSampleRate` + `apiKeySettingKey`; honor the audio/FLAC contracts).
   Add a static `getAvailableVoices()` and normalize unknown voices to a default.
2. Add a `case` and key mapping in `voice-provider-factory.mts`, plus a `case` in
   `getVoicesForProvider()`.
3. Add it to `SettingsManager.getAvailableProviders()` and add the option (and a
   key field if needed) to `settings/index.html`.
4. Keep `VoiceProviderEvents` a superset; reuse `agent-instructions.mts` for the
   system prompt and `pcmToFlacBuffer` for TTS.

## Testing

- `npm run build` — the `implements IVoiceProvider` check is the real type gate.
- `npm test` — 125 tests; the OpenAI provider's back-compat keeps them green.
- Emulator (no Homey/PE needed): set `voice_provider` (+ matching key) in
  `emulator/settings.json` and run `npm run emulator`, then `ask turn off all
  lights` to exercise tool calls. See `emulator/README.md`.

## Status / known gaps

- **Gemini live audio with a real PE is not yet field-tested** (only build,
  tests, and emulator boot). The server-VAD → `silence` mapping and audio
  round-trip need verification against the live API.
- Gemini model ids are constants in the provider — preview models may be
  renamed upstream.
- Gemini voice selection is a no-op (its voice names differ from OpenAI's).
- **Deferred**: STT/LLM/TTS sub-interfaces for fully composable local pipelines
  (Whisper/Ollama/Piper); generalizing audio beyond 16/24 kHz; live provider
  switching without a restart.
