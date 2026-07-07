# TODO — single source of truth

This is the one place to look at the start of each session for what's left to do.

Finished work is archived in [`COMPLETED.md`](./COMPLETED.md) — the full context of every done item
(root causes, gotchas, verification notes) lives there so we don't re-investigate. The 2026-07-07
triage that emptied the old list (what was done, what was dropped and why) is archived there too.

Legend: `[ ]` open · `[~]` partially done · (fully done items move to `COMPLETED.md`)

---

## In progress (2026-07-07 session)

- [ ] **Wake-word selection** — parse `ListEntitiesSelectResponse` / `SelectStateResponse`, store the
  wake-word select key, expose the wake-word choice in Homey device settings
  (`SelectCommandRequest` to change it). _(gap analysis #7)_
- [ ] **Per-request Piper voice selection** — `GET /voices` from the Piper HTTP server + a voice
  dropdown for the piper TTS backend.
- [ ] **Voxtral Realtime websocket STT** — Mistral's streaming STT (sub-200 ms) as a new
  `local_stt_provider` backend, upgrading on the batch transcription endpoint.
- [ ] **Web search tool** — "What movies are in the cinema today?", "When does the next bus leave?"
  Backend selectable between OpenAI web search (reuses `openai_api_key`) and the Brave Search API.
