# FutureProofHomes Satellite1 (Dev Kit / Satellite1.1 Smart Speaker)

Technical reference, researched 2026-07-20. Primary sources: [futureproofhomes.net](https://futureproofhomes.net) (product pages; note: the site 403-blocks non-browser fetchers, so product details below come via search snippets and the [CNX Software review](https://www.cnx-software.com/2025/05/16/satellite1-dev-kit-is-an-home-assistant-compatible-diy-voice-assistant-with-esp32-s3-module-xmos-xu316-audio-processor/)), the **full firmware source** at [FutureProofHomes/Satellite1-ESPHome](https://github.com/FutureProofHomes/Satellite1-ESPHome) (branch `develop`, `config/` tree) and the hardware repo [FutureProofHomes/Satellite1-Hardware](https://github.com/FutureProofHomes/Satellite1-Hardware) (CERN-OHL-S). Every protocol claim below is verified against the firmware YAML, with file paths given.

## TL;DR for this app

**This is the most compatible third-party device we have looked at — it is genuine ESPHome,
and its config is visibly derived from the Voice PE's.** The firmware uses the stock ESPHome
`api:`, `voice_assistant:`, `micro_wake_word:` and `media_player:` components — the exact
stack `src/voice_assistant/esp-voice-assistant-client.mts` already speaks to the Home
Assistant Voice PE. Even the API block is character-for-character the Voice PE's
(`encryption:` with no key, comment `# Uses key set by Home Assistant`). mDNS, timers,
FLAC announcement playback and Improv BLE all line up with what we already do.

**The one blocker is our own pairing sniff** (same situation as the ThirdReality was in):
the device identifies as project `futureproofhomes.satellite1` / friendly name `Satellite1`,
which matches none of our identity strings (`nabu casa`, `home assistant voice`,
`thirdreality`/`3rspk`, `xiaozhi`), so `deviceType` stays `null` and every driver rejects it
during the capability probe. Supporting it means one new match string + one thin driver.
See [Integration notes](#integration-notes-for-this-app).

**One behavioral caveat, shared with the Voice PE:** once the satellite has been adopted by
Home Assistant, HA pushes a Noise encryption key into flash and the device stops accepting
plaintext connections — and our client is plaintext-only. A factory-fresh or
factory-reset Satellite1 works; one previously paired to HA will refuse us until reset.
This is not new — it is exactly the known "Noise not yet supported" limitation documented
in `CLAUDE.md` for the Voice PE.

---

## Product

| | |
|---|---|
| Name | FutureProofHomes Satellite1 |
| Variants | **Satellite1 PCB Dev Kit** (Core board + HAT, bare PCBs) · **HAT board** sold separately · **DIY Smart Speaker Enclosure Kit** · **Satellite1.1 Smart Speaker** (fully pre-assembled, Charcoal Gray / Bone White, optional 30 W USB-C PD charger) |
| Purchase | [Dev kit](https://futureproofhomes.net/products/satellite1-pcb-dev-kit) · [Smart speaker](https://futureproofhomes.net/products/satellite1-smart-speaker) · [Enclosure kit](https://futureproofhomes.net/products/satellite1-smart-speaker-enclosure-kit) |
| Positioning | Open-source (hardware **and** firmware) private voice assistant + multisensor for Home Assistant / Music Assistant; ESPHome + XMOS firmware factory-installed |
| Docs | [docs.futureproofhomes.net](https://docs.futureproofhomes.net) (also 403-blocks fetchers) |

## Hardware

From the firmware YAML (`config/common/*.yaml`), the hardware repo and the CNX review:

- **Core board:** ESP32-S3 (dual-core LX7 @ 240 MHz), 512 KB SRAM, **16 MB flash, 8 MB
  PSRAM**, Wi-Fi 2.4 GHz + BLE 5. So: a real ESP32 running real ESPHome (`min_version: 2026.4.0`
  on `develop`), unlike the ThirdReality's Linux reimplementation.
- **HAT board:** **XMOS XU316** 16-core audio DSP @ 800 MHz (the same chip family as the
  Voice PE) doing echo cancellation / noise suppression on-device; the ESP flashes XMOS
  firmware on demand. **4-microphone far-field array** (`microphone: platform: satellite1`,
  48 kHz stereo 32-bit I²S in `config/common/voice_assistant.yaml` — the XMOS feeds a
  processed stream).
- **Audio out** (`config/common/speaker.yaml`): dual DACs behind a `satellite1` "dac_proxy" —
  **TAS2780** class-D amp (25 W mono speaker output) plus **PCM5122** line-out DAC for the
  3.5 mm jack, with automatic switchover on jack detect. I²S out at 48 kHz, mixer +
  resampler speaker graph identical in structure to the Voice PE's (separate announcement
  and media channels with ducking).
- **Satellite1.1 Smart Speaker** adds a 20 W 2-way speaker: 3" mid-woofer + 1.2" neodymium
  tweeter with passive crossover.
- **UX/sensors:** 360° addressable LED ring, 4 tactile buttons including a **hardware mic
  mute** (a template `master_mute_switch` mirrors it to HA; hardware switch overrides
  software — `config/common/home_assistant.yaml`), temperature/humidity/light sensors
  (`hat_sensors.yaml`), optional mmWave presence radar (LD2410 or LD2450, `mmwave*.yaml`).

## Firmware facts that matter to us

All paths relative to `config/` in [Satellite1-ESPHome](https://github.com/FutureProofHomes/Satellite1-ESPHome) (`develop` branch, checked 2026-07-20).

### Native API — plaintext until HA sets a key (`common/home_assistant.yaml`)

```yaml
api:
  id: api_id
  encryption:   # Uses key set by Home Assistant
```

Identical (including the comment) to the Voice PE factory firmware
([`home-assistant-voice.yaml`](https://github.com/esphome/home-assistant-voice-pe/blob/dev/home-assistant-voice.yaml) line ~108).
A keyless `encryption:` block means: the device boots accepting **plaintext** native-API
connections on **port 6053**; when Home Assistant adopts it, HA generates a Noise PSK and
stores it on the device, after which plaintext is refused. Consequences for us:

- Out of the box (or after factory reset): **our plaintext client connects fine.**
- After the user has ever added it to Home Assistant: connection fails until Noise support
  is added to our client or the device is factory-reset. Same rule as the Voice PE.
- No API password — and `min_version: 2026.4.0` (`satellite1.base.yaml`) means the
  post-2026.1 handshake (no `ConnectResponse` from the server) which our client already
  handles by not waiting for it.

### Voice assistant (`common/voice_assistant.yaml`)

- Stock `voice_assistant:` component wired to `microphone: sat1_mics` (channel 0) and
  `media_player: external_media_player`; `noise_suppression_level: 0` / `auto_gain: 0 dbfs`
  because the XMOS already did the cleanup. The VA component streams **16 kHz mono PCM over
  the native API** to the subscribed client — same as the Voice PE, so our `chunk` →
  `Pcm16kTo24k` path is untouched.
- `micro_wake_word:` with on-device models **hey_jarvis**, **okay_nabu**, and an internal
  **stop** model (used to voice-stop timer rings/TTS). Same phase-tracking globals
  (`voice_assist_idle_phase_id: '1'` …) as the Voice PE yaml — this file is clearly a
  Voice PE derivative.
- Wake-word-detected behavior honors the mute switch and stops ringing timers first —
  no surprises for our session flow.

### Media player / announcements (`common/media_player.yaml`, `common/speaker.yaml`)

```yaml
announcement_pipeline:
  speaker: announcement_resampling_speaker
  format: FLAC
  num_channels: 1
  sample_rate: 48000
```

- `media_player:` platform `speaker_source` with separate announcement (FLAC mono 48 kHz,
  250 KB buffer) and media (FLAC stereo 48 kHz, 500 KB buffer) pipelines feeding a mixer
  with −20 dB ducking. **Resampler speakers sit in front of the mixer**, so the FLAC we
  serve over LAN HTTP (libflacjs, 16/24 kHz mono — `src/helpers/audio-encoders.mts`) is
  resampled on-device; no format work needed on our side. This is the same
  announcement-URL playback contract we already use with the Voice PE.
- Volume exposed 0.1–1.0 in 0.05 steps; our volume/mute handling maps as on the PE.

### Timers (`common/timer.yaml`)

Full `voice_assistant::Timer` support: `on_timer_finished/started/cancelled/updated`
triggers, a `timer_ringing` switch that repeats a FLAC ring sound, ducks media, and enables
the "stop" wake word (auto-stops after 15 min). The device will therefore advertise the
timer feature flag, satisfying our `esp.supportsTimers` gate — the LLM timer tools and
instruction block light up with no extra work.

### Discovery + provisioning (`satellite1.yaml`, `common/wifi_improv.yaml`)

- Standard ESPHome **mDNS `_esphomelib._tcp`** advertisement with `platform=ESP32` and
  `project_name=futureproofhomes.satellite1` TXT records. Our discovery config
  (`.homeycompose/discovery/esphome.json` — matches `txt.platform` against
  `esp32|ESP32|…`) picks it up unchanged.
- **Improv over BLE is present** (`esp32_improv:` in `satellite1.yaml`) with
  `authorizer: btn_action` — the user must press the action button to authorize
  provisioning, after which BLE is disabled 5 s post-connect. Our
  `pair/improv_setup.html` wizard should work as-is (the authorizer step just means the
  wizard's "press the button on the device" moment is mandatory, like on the Voice PE).
  `improv_serial:` is also enabled for USB flashing/setup.

## Compatibility checklist vs. our client

| Area | Satellite1 | Our client | Verdict |
|---|---|---|---|
| Transport | ESPHome native API, TCP 6053, plaintext until HA-adopted | plaintext ESPHome native API | ✅ (until HA adoption stores a Noise key — then ❌ until factory reset or Noise support) |
| Handshake | ESPHome ≥ 2026.4 (no `ConnectResponse`) | doesn't wait for `ConnectResponse` | ✅ |
| mDNS discovery | `_esphomelib._tcp`, `platform=ESP32` | regex matches `esp32\|ESP32` | ✅ |
| Capability probe | ≥1 media player, VA subscribe + VA configuration (micro_wake_word) | requires all three counts > 0 | ✅ |
| Identity sniff | `Satellite1` / `futureproofhomes.satellite1` / `FutureProofHomes` | only knows `pe`/`tr`/`xiaozhi` | ❌ **the blocker** |
| Mic audio | 16 kHz mono PCM over API (XMOS-cleaned) | `chunk` → `Pcm16kTo24k` | ✅ |
| Playback | announcement URL, FLAC, on-device resampler | FLAC over LAN HTTP (`WebServer`) | ✅ |
| Timers | full VA timer triggers + ring | `esp.supportsTimers` gate | ✅ |
| Volume/mute | media_player volume + HW/SW mute switch | `volume`/`mute` events | ✅ |
| Wi-Fi setup | `esp32_improv` (button-authorized) + `improv_serial` | Improv BLE wizard | ✅ |
| Delayed playback quirk | mixer/resampler pipeline like the PE | `needDelayedPlayback` flag | expected `false` (verify on hardware) |

## Integration notes for this app

The work list mirrors what the ThirdReality integration needed:

1. **Identity sniff** — `src/voice_assistant/esp-voice-assistant-client.mts` (~line 421,
   the `HelloResponse`/`DeviceInfoResponse` matcher): add a branch matching
   `futureproofhomes` or `satellite1` → `deviceType = 'sat1'`. Both strings appear in
   `DeviceInfoResponse` (project name, manufacturer, friendly name); `satellite1` is also
   the default node name in `HelloResponse`. Update the `'pe' | 'xiaozhi' | null` comment
   in `src/helpers/interfaces.mts`.
2. **New driver** — `drivers/futureproofhomes-satellite1/` with the usual thin pair:
   `device.mts` (`needDelayedPlayback = false`, pending hardware verification) and
   `driver.mts` (`thisAssistantType = 'sat1'`), plus `driver.compose.json`, images, and a
   copy of `pair/improv_setup.html` (kept in sync with the other drivers per `CLAUDE.md`).
3. **No discovery changes** — `.homeycompose/discovery/esphome.json` already matches.
4. **Docs** — README.md + README.txt must list the new supported device when it ships.
5. **Pairing UX note** — if probing a Satellite1 that was previously adopted by Home
   Assistant, the TCP probe will fail at the Noise hello. Worth a pairing-help hint
   ("factory-reset the device or remove its encryption key") until Noise support lands.

## Open questions / verify on real hardware

- **`needDelayedPlayback`** — assumed `false` (PE-style pipeline with generous buffers);
  confirm first announcement isn't clipped.
- **Shipped firmware version** — releases are still beta (`v0.1.x-beta` targeted ESPHome
  2025.x; `develop` requires 2026.4). Older stock firmware still works for us — the
  pre-2026.1 handshake path (send `ConnectRequest`, don't wait) covers both.
- **Capability counts on real hardware** — the probe expects `mediaPlayersCount > 0`,
  `subscribeVoiceAssistantCount > 0`, `voiceAssistantConfigurationCount > 0`; all three
  should hold given the YAML, but this is exactly what bit us before on other devices.
- **Whether HA adoption is common in the field** — most buyers are Home Assistant users,
  so the "already has a Noise key" case may be the *default* out in the wild. That makes
  Noise support (already on the TODO radar for the Voice PE) more valuable, not less.
- **Prices** — not captured; futureproofhomes.net blocks automated fetchers (HTTP 403).
