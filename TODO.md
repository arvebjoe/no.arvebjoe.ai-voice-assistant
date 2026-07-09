# TODO — single source of truth

## Music via Music Assistant (PE + TR) — researched 2026-07-09, not started

Goal: stream music (Spotify, Apple Music, radio, local library…) to the Voice PE and ThirdReality
speakers, and control it by voice (find/play artist/album/track, pause, next, prev).

**Key finding: our app never needs to touch the music audio.** Both devices are native
[Sendspin](https://www.sendspin-audio.com/) players, and Music Assistant ≥ 2.7 ships a Sendspin
player provider (experimental, on by default):

- **PE:** stock firmware includes the Sendspin client — see `sendspin:` hub +
  `media_player: platform: sendspin` in our own `.esp_home/home-assistant-voice.yaml` (merged into
  upstream ESPHome 2026.5; PE firmware 26.x has it).
- **TR:** ships `sendspin-client` in firmware (see `docs/thirdreality-voice-and-music/README.md`
  §Music — already documented as orthogonal to our voice path).
- MA discovers both over mDNS and streams to them directly (multi-room sync included). No Home
  Assistant required — MA runs standalone (docker) or as an HA add-on.

**What our app adds: the control plane** (so the LLM can drive MA):

1. Small Music Assistant WebSocket client (`ws://<ma-host>:8095/ws`, JSON-RPC; docs auto-generated
   at `http://<ma-host>:8095/api-docs`, reference impls: python `music-assistant/client`, TS in
   `music-assistant/frontend` `src/plugins/api/index.ts`). New global settings: MA host/port,
   opt-in like Bring!.
2. ToolManager tools (follow the Bring! opt-in pattern): `search_music`,
   `play_music` (artist/album/track/playlist/radio → player queue), `pause/resume/next/previous`,
   maybe queue transfer between rooms. Transport commands go to **MA** (the queue lives there),
   not to the device's media_player entity.
3. Player↔device mapping: resolve which MA player corresponds to the satellite the user is
   talking to (match on mDNS name/MAC), so "play X" targets the room you spoke in.

**To verify live:** announcement ducking over Sendspin playback on both devices (PE firmware has a
separate announcement pipeline; TR docs claim ducking works out of the box); wake word while music
plays (PE has XMOS AEC; TR uses WebRTC/PulseAudio AEC); exact MA player IDs for Sendspin players.

**Notes:** the Homey MA app (`com.cyrilhendriks.musicassistant`) speaks the same MA API and can
coexist (useful for flows), but voice needs direct MA API access so the LLM can search and
disambiguate. XiaoZhi has no Sendspin client — music support there stays out of scope.

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
