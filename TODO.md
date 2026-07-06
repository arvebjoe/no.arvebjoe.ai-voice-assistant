# TODO — single source of truth

This is the one place to look at the start of each session for what's left to do.
Stuff I want to bake into the app over time. Please come with suggestions :)

Finished work is archived in [`COMPLETED.md`](./COMPLETED.md) — the full context of every done item
(root causes, gotchas, verification notes) lives there so we don't re-investigate.

Two detailed reference docs feed into this list (don't duplicate their detail here, link to them):
- [`OPENAI_API_IMPROVEMENTS.md`](./OPENAI_API_IMPROVEMENTS.md) — OpenAI Realtime API audit (12 items, most done)
- [`docs/home-assistant-voice-preview-edition/implementation-gap-analysis.md`](./docs/home-assistant-voice-preview-edition/implementation-gap-analysis.md) — ESPHome native-API coverage vs. the PE docs

Legend: `[ ]` open · `[~]` partially done · (fully done items move to `COMPLETED.md`)

---

## 0. Release testing checklist

Implemented but not yet verified in the real world — must all pass before the store release.
(Each links back to the owning item below or its archive entry in COMPLETED.md.)

- [ ] **Re-run the 3-question quiz** — verifies the playback-aware `lastTurnEndedAt` fix (long
  in-band replies must not eat the 10 s context TTL and wipe the LLM context). _(§1 hardening)_
- [ ] **LED-phase fidelity on the PE** with the debug solid colors (amber=mic open, green=speech
  heard, blue=thinking, red=replying) — in-band replies should now reach the *replying* phase;
  expected artifact: brief red flash on each mic-reopen. _(§1 hardening sub-item)_
- [ ] **Fresh `[CONVO]` trace** for the user-reported (still unspecified) conversation bugs. _(§1 hardening)_
- [ ] **STT changes on real speech** — `gpt-4o-transcribe` sidecar model + text-anchored replies,
  especially in Norwegian. _(§2 STT accuracy)_
- [ ] **Timer LED-drift resync** — hardware-verify the quiet `UPDATED` every 30 s on a
  long/alarm-length countdown. _(COMPLETED.md §1, timer support)_
- [ ] **Local pipeline against real services** — see the verify item in §5.

---

## 1. ESPHome device client (`src/voice_assistant/`)

- [~] **Conversation-flow hardening — "real close", bugs remain.** The 2026-07-02 fix round
  (pairing sniff broadened, `[CONVO]` trace, spurious-VAD-trip retry, tool-turn `response.done`
  suppression, `continue_conversation` on INTENT_END, playback-aware `lastTurnEndedAt`) is archived
  in COMPLETED.md §1. Still open:
  - Playback-aware `lastTurnEndedAt` not yet re-tested — see §0.
  - **Multi-segment announce race:** a short first segment's ack arrives before segment 2 exists →
    premature turn-complete; currently self-heals by luck.
  - **keepOpen-with-no-audio edge:** `peConversationActive=true` but the PE may not reopen when
    there's no TTS URL.
  - User reports further unspecified bugs — get a fresh `[CONVO]` trace (§0).
  Details: memory `followup-turn-no-audio-rootcause.md`.
  - [~] **LED-phase fidelity (2026-07-02 afternoon, untested on PE):** debug solid-color LED effects
    added to the PE config (amber=mic open, green=speech heard, blue=thinking, red=replying — see
    `.esp_home/CUSTOMIZATIONS.md`). They exposed that in-band replies never reached the PE's
    *replying* phase: the firmware discards a TTS_START without a `text` data entry, and only
    announces went red (the firmware's announcement handler fires tts_start_trigger_ itself).
    Fixed: `tts_start(text?)` carries the reply text; `stt_vad_start` now sent on the new provider
    `speech` event (server VAD speech_started) instead of at mic open, so waiting vs. listening is
    real. Verify on the PE with the debug colors (§0).
- [~] **Timer support** — voice-driven timers + alarms shipped 2026-06-23 (TimerManager, flow cards,
  tile capabilities, LED-ring re-arm on reconnect, LED-drift resync — full record in COMPLETED.md §1;
  design notes in [`docs/.../timer-feature.md` §9](./docs/home-assistant-voice-preview-edition/timer-feature.md)).
  Remaining:
  - **Single timer only** — a second request makes the agent ask whether to replace. Multiple
    concurrent timers would need TimerManager + tool-schema + PE timer-id plumbing.
  - LED-drift resync hardware verify (§0).
- [ ] **Configuration sync / wake-word selection** — parse `ListEntitiesSelectResponse`, store the
  wake-word + pipeline select keys, optionally expose wake-word choice in Homey device settings.
  (Select entities are already registered generically into `entityKeys` by the client; the
  wake-word-specific handling and settings UI are the missing parts.) _(gap analysis #7, Medium)_
- [ ] **ESPHome API encryption (Noise) + API key** — client is currently plaintext-only. If a
  satellite has an encryption key set, the connection fails entirely. Add an optional
  `encryption_key` device setting and implement the Noise handshake
  (`Noise_NNpsk0_25519_ChaChaPoly_SHA256`) before the Hello exchange.
  _(gap analysis #10, High — only needed when a user asks for it)_

---

## 2. OpenAI Realtime API (`src/llm/providers/openai-realtime-agent.mts`)

Remaining items from the audit (1–7, 10, 12 are already done — see the reference doc):

- [ ] **#8 Simplify VAD response trigger** — set `create_response: true` (+ `interrupt_response: true`)
  in `turn_detection`, drop the manual transcript re-injection / `transcript_id` tracking.
  _(Medium — also enables barge-in. NOTE: partially superseded by the text-anchored-replies flow,
  which deliberately keeps manual response creation so the model answers the transcript, not the
  audio — reconcile the two before doing this.)_
- [ ] **#9 Expose `gpt-realtime-mini`** — add a "model quality" setting (Standard = mini vs Full)
  for the cost/quality tradeoff. Model is currently hardcoded (`gpt-realtime-2025-08-28`). _(Medium)_
- [ ] **#11 Act on `rate_limits.updated`** — the event is emitted by the agent but nothing acts on
  it; log low-token warnings / surface a Homey notification when quota runs low. _(Low, optional)_
- [~] **Improve STT accuracy (esp. Norwegian)** — command transcription is unreliable, particularly
  in Norwegian. _(Medium — ongoing pain point.)_ Done so far (archived in COMPLETED.md §2, both
  pending real-speech verification, §0): sidecar model switched to `gpt-4o-transcribe`;
  text-anchored replies (model answers the transcript, not the audio). Remaining:
  - [ ] Transcription `prompt` with actual device/zone names from DeviceManager (needs plumbing:
    session.update once the device list is known).
  - [ ] VAD threshold / `silence_duration_ms` / `noise_reduction` tuning if needed.

---

## 3. Agent tools

- [ ] **Start flows from the agent**
  - Start flow by name: "start \<flow name\>".
  - Start flow by synonym: "I'm going to bed" → starts "night mode". Needs a way for the user to
    map synonyms → flow names.
- [ ] **Change settings by voice** (lots of work, but cool) — expose allowed settings (`voice`,
  `language`, `optional_ai_instructions`) as tools. Flow: agent lists options → user picks → tool
  stores the change → agent finishes its run → apply the change (socket reconnects) → optionally
  speak back in the new voice. Builds on the keep-conversation-alive feature (done — COMPLETED.md §3).
- [ ] **Help!** — ask the agent what it can do.
- [ ] **When triggered from a flow, don't chunk audio** — set `pcm-segmenter` to a high
  `MIN_SILENCE_MS` (one `.flac`), or bypass the segmenter and pipe directly. Fast response time
  isn't needed from a flow — nice-to-have.

---

## 4. Custom ESPHome / PE firmware

Customizations live in `.esp_home/` (downloaded stock config + edits). Re-application guide after any
fresh config download: [`.esp_home/CUSTOMIZATIONS.md`](./.esp_home/CUSTOMIZATIONS.md).
(The custom "Hey Homey" wake word is done — see COMPLETED.md §4 for the microWakeWord-vs-openWakeWord
gotcha before touching wake words again.)

- [~] **Homey look for the LED ring** — per-phase rotating rainbows implemented (waiting + listening =
  full rainbow CW; thinking = cold rainbow CCW; replying = warm rainbow CCW). Effects + phase mapping
  documented in CUSTOMIZATIONS.md. <img src="./.resources/pe_rainbow.png" height="200" alt="PE rainbow" />
  - [ ] **BUG (revisit): thinking still shows the old white pulse on-device.** The config is correct
    (`control_leds_voice_assistant_thinking_phase` → `effect: "Cold Rainbow"`, and the `"Thinking White"`
    effect is orphaned — nothing references it), but the PE keeps showing the white breathing pulse
    after stop-speaking. Strongly suspected **stale flash** (the new build isn't reaching the device —
    same trap hit earlier in this work), but unconfirmed after re-flash attempts. Next: confirm the
    running build (boot-log `compiled on` timestamp), verify the editor's config actually contains
    `Cold Rainbow`, and watch device LOGS during the thinking phase.

---

## 5. Local / offline AI

- [~] **Locally-hosted stack — first round done (2026-07-05, merged PR #12), untested against real
  services.** New `local` voice provider: energy VAD → STT → LLM (full tool loop) → TTS, all three
  stages pluggable. Backends shipped (full details in COMPLETED.md §5): Whisper HTTP / Wyoming
  faster-whisper / Mistral Voxtral / OpenAI-compatible (STT); Ollama / LM Studio / Mistral /
  OpenAI-compatible (LLM); Piper HTTP / Wyoming Piper / Mistral Voxtral / OpenAI-compatible (TTS);
  per-stage Test buttons in the settings page. Remaining:
  - [ ] **Verify against real services on Windows** (whisper-asr-webservice + Ollama desktop +
    piper http docker, plus the Wyoming dockers); tune `SimpleVad` thresholds with a real PE mic. (§0)
  - [ ] Wake-word → reply latency measurement; consider Whisper streaming/partials, and Mistral's
    **Voxtral Realtime** WebSocket STT (sub-200 ms, $0.006/min, also open-weights) as an upgrade
    over the batch transcription endpoint used now.
  - [ ] Optional auth (API keys / basic auth) for the LAN endpoints.
  - [ ] Per-request Piper voice selection (needs `GET /voices` + a voice dropdown).
  - Reference videos:
    - [Build a Simple AI Agent with gpt-oss-20b](https://www.youtube.com/watch?v=e2sgwsC92Bc)
    - [Build Anything with OpenAI's New OSS Models (n8n Agents)](https://www.youtube.com/watch?v=Myjo1amUZ08)
    - [Learn MCP (Model Context Protocol)](https://www.youtube.com/watch?v=GuTcle5edjk)

---

## 6. Phase 2 (later)

- [ ] **Image analysis** — analyze an image + prompt: "Can you see any persons in the surveillance
  image?", "Is it dark out?", "Who is at the door?"
- [ ] **Web search tool** — "What movies are in the cinema today?" (with geo it could find the
  nearest cinema).
