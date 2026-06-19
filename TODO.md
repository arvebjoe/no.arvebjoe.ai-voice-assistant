# TODO — single source of truth

This is the one place to look at the start of each session for what's left to do.
Stuff I want to bake into the app over time. Please come with suggestions :)

Two detailed reference docs feed into this list (don't duplicate their detail here, link to them):
- [`OPENAI_API_IMPROVEMENTS.md`](./OPENAI_API_IMPROVEMENTS.md) — OpenAI Realtime API audit (12 items, most done)
- [`docs/home-assistant-voice-preview-edition/implementation-gap-analysis.md`](./docs/home-assistant-voice-preview-edition/implementation-gap-analysis.md) — ESPHome native-API coverage vs. the PE docs

Legend: `[ ]` open · `[~]` partially done · `[x]` done (kept for context so we don't re-investigate)

---

## 1. ESPHome device client (`src/voice_assistant/`)

- [ ] **Timer support** — let users say "set a 5 minute timer" and have the PE track it on the
  LED ring + alert. Add a `set_timer` tool, track timers locally, send `VoiceAssistantTimerEvent`
  to the ESP on start/update/finish. _(gap analysis #5, Medium)_ — overlaps with the alarm/countdown
  agent tool in §3.
  **Full mechanism + Homey mapping researched:** [`docs/home-assistant-voice-preview-edition/timer-feature.md`](./docs/home-assistant-voice-preview-edition/timer-feature.md)
  (protocol, device behavior, feature-flag gating, integration points, custom-capability mapping).
- [ ] **Configuration sync / wake-word selection** — parse `ListEntitiesSelectResponse`, store the
  wake-word + pipeline select keys, optionally expose wake-word choice in Homey device settings.
  _(gap analysis #7, Medium)_
- [ ] **ESPHome API encryption (Noise) + API key** — client is currently plaintext-only. If a
  satellite has an encryption key set, the connection fails entirely. Add an optional
  `encryption_key` device setting and implement the Noise handshake
  (`Noise_NNpsk0_25519_ChaChaPoly_SHA256`) before the Hello exchange.
  _(gap analysis #10, High — only needed when a user asks for it)_
- [x] **2026.1 handshake fix** — ESPHome 2026.1.0 (PE firmware 26.x) removed password auth;
  client no longer waits for `ConnectResponse`, stays backward compatible with 25.x. Verified on
  firmware 26.4.0. See `CLAUDE.md` → "ESPHome firmware compatibility".
  (The encryption item above is the remaining piece of the same area.)
- [x] Done in gap analysis: `WAKE_WORD_END`, `ERROR` events, `INTENT_PROGRESS`, version-check,
  `SubscribeStates`, extra entity-type handlers.

---

## 2. OpenAI Realtime API (`src/llm/openai-realtime-agent.mts`)

Remaining items from the audit (1–7, 10, 12 are already done — see the reference doc):

- [ ] **#8 Simplify VAD response trigger** — set `create_response: true` (+ `interrupt_response: true`)
  in `turn_detection`, drop the manual transcript re-injection / `transcript_id` tracking.
  _(Medium — also enables barge-in)_
- [ ] **#9 Expose `gpt-realtime-mini`** — add a "model quality" setting (Standard = mini vs Full)
  for the cost/quality tradeoff. _(Medium)_
- [ ] **#11 Act on `rate_limits.updated`** — log low-token warnings / surface a Homey notification
  when quota runs low. _(Low, optional)_
- [ ] **Improve STT accuracy (esp. Norwegian)** — command transcription is unreliable, particularly
  in Norwegian. Tune the transcription model + VAD settings: try `gpt-realtime-whisper`'s `delay`
  (`"medium"`/`"high"` for accuracy over latency), `noise_reduction` mode (`near_`/`far_field` for
  the room), and VAD thresholds. _(Medium — ongoing pain point)_

---

## 3. Agent tools

- [ ] **Start flows from the agent**
  - Start flow by name: "start \<flow name\>".
  - Start flow by synonym: "I'm going to bed" → starts "night mode". Needs a way for the user to
    map synonyms → flow names.
- [ ] **Follow-up / keep conversation alive** — answer a follow-up question without repeating the
  wake word (set `VoiceAssistantAnnounceRequest.startConversation = true`). Needs a timeout if the
  user has nothing to say.
- [ ] **Change settings by voice** (lots of work, but cool) — expose allowed settings (`voice`,
  `language`, `optional_ai_instructions`) as tools. Flow: agent lists options → user picks → tool
  stores the change → agent finishes its run → apply the change (socket reconnects) → optionally
  speak back in the new voice. Needs the keep-conversation-alive flag above.
- [ ] **Help!** — ask the agent what it can do.
- [ ] **When triggered from a flow, don't chunk audio** — set `pcm-segmenter` to a high
  `MIN_SILENCE_MS` (one `.flac`), or bypass the segmenter and pipe directly. Fast response time
  isn't needed from a flow — nice-to-have.

---

## 4. Custom ESPHome / PE firmware

- [ ] **Homey look for the LED ring** — the PE isn't restricted to blue; do the Homey "rainbow"
  ring spinning around. <img src="./.resources/pe_rainbow.png" height="200" alt="PE rainbow" />
- [ ] **Custom wake word** — is there a tool to build one? Candidates: "Hey Homey", "Hei Homey"
  (Norwegian), "My Homey", "Major domo".

---

## 5. Local / offline AI

- [ ] Explore locally-hosted stack: **Whisper** (STT), **Piper** (TTS), **Ollama** (LLM) — possibly
  as a realtime agent, possibly using `gpt-oss`.
  - [Build a Simple AI Agent with gpt-oss-20b](https://www.youtube.com/watch?v=e2sgwsC92Bc)
  - [Build Anything with OpenAI's New OSS Models (n8n Agents)](https://www.youtube.com/watch?v=Myjo1amUZ08)
  - [Learn MCP (Model Context Protocol)](https://www.youtube.com/watch?v=GuTcle5edjk)

---

## 6. Phase 2 (later)

- [ ] **Image analysis** — analyze an image + prompt: "Can you see any persons in the surveillance
  image?", "Is it dark out?", "Who is at the door?"
- [ ] **Web search tool** — "What movies are in the cinema today?" (with geo it could find the
  nearest cinema).
