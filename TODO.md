# TODO — single source of truth

## Music via Music Assistant (PE + TR) — implemented 2026-07-09, live verification pending

The control-plane integration is implemented and unit-tested (full context archived in
[`COMPLETED.md` §3](./COMPLETED.md)); the music audio itself never touches this app — Music
Assistant ≥ 2.7 streams to the PE and TR directly over Sendspin.

**Remaining: verify against a real MA server + speakers** (needs the owner's network):

- [ ] MA discovers the PE (stock 26.x firmware) and TR as Sendspin players; check what the
      players' `device_info.ip_address` / names look like so the satellite→player auto-matching
      in `resolveMusicPlayer` (IP first, then device name, then zone name) actually hits.
- [ ] End-to-end voice flow on both devices: "play <album> by <artist>", pause/resume/next/
      previous, shuffle, "what's playing?", explicit room targeting ("…in the kitchen").
- [ ] Announcement ducking while Sendspin music plays (PE has a separate announcement pipeline;
      TR docs claim ducking works out of the box) — and that music resumes after the reply.
- [ ] Wake word while music is playing (PE has XMOS AEC; TR uses WebRTC/PulseAudio AEC).
- [ ] `resume` behavior on a long-stopped queue (the tool maps resume→`play` when paused,
      `resume` otherwise — check the idle case restarts where it left off).
- [ ] Partial-result accumulation against a big real library (implemented per the API models;
      only exercised with a fake server so far).

---

Nothing else outstanding right now.

The 2026-07-07 session cleared this list: every item was either implemented (archived with full
context in [`COMPLETED.md`](./COMPLETED.md)) or explicitly dropped by the owner (dropped items and
their rationale are in [`COMPLETED.md` §6](./COMPLETED.md) in case any come back).

Add new work here as it comes up. Reference docs that used to feed this list:
- [`OPENAI_API_IMPROVEMENTS.md`](./OPENAI_API_IMPROVEMENTS.md) — OpenAI Realtime API audit (all items resolved)
- [`docs/home-assistant-voice-preview-edition/implementation-gap-analysis.md`](./docs/home-assistant-voice-preview-edition/implementation-gap-analysis.md) — ESPHome native-API coverage vs. the PE docs

**Not tracked but worth remembering before a store release:** the README screenshots
(`.resources/settings.jpg`) predate the provider-choice settings redesign and are stale.
