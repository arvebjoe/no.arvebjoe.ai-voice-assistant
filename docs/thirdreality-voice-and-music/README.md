# ThirdReality Voice & Music Assistant (Dev Edition)

Technical reference, researched 2026-07-04. Primary sources: the [product page](https://www.thirdreality.com/products/voice-music-assistant-dev-edition), the [launch press release](https://www.prweb.com/releases/thirdreality-launches-voice--music-assistant-dev-edition-302767779.html), and above all the **full firmware source** at [thirdreality/voice-music-assistant](https://github.com/thirdreality/voice-music-assistant) (default branch `linux-voice-assistant`, Apache-2.0) — every protocol claim below is verified against that code, with file paths given.

## TL;DR for this app

**It speaks our protocol.** Despite being a Linux box (not an ESP32), the firmware implements the
**ESPHome native API as a plaintext TCP server on port 6053** — the same protocol
`src/voice_assistant/esp-voice-assistant-client.mts` already speaks to the Voice PE. No Noise
encryption anywhere in the connection code, API version **1.10** (≥ 1.5, so our announce path
works). It advertises `_esphomelib._tcp` over mDNS, so it will show up in our pairing scan.

**The one blocker is our own pairing sniff.** The device identifies as manufacturer
`ThirdReality`, model `Linux Voice Assistant`, project `ThirdReality.Linux Voice Assistant (C++)`,
device name `3RSPK…` — none of our current match strings (`nabu casa`, `home assistant voice`,
`xiaozhi`) hit. See [Integration notes](#integration-notes-for-this-app) below.

---

## Product

| | |
|---|---|
| Name | THIRDREALITY Voice & Music Assistant Dev Edition |
| Editions | **Standard** $69.99 (thirdreality.com exclusive; flash + software updates) · **Debug** $79.99 (adds debug board: serial console, real-time logs, on-device development) |
| Purchase | [thirdreality.com](https://www.thirdreality.com/products/voice-music-assistant-dev-edition) (sold out at research time), [Amazon B0GQYW153Z](https://www.amazon.com/Third-Reality-Voice-Music-Assistant/dp/B0GQYW153Z), [ameriDroid](https://ameridroid.com/products/voice-music-assistant-dev-edition) |
| Positioning | Open-source Home Assistant voice satellite + Music Assistant multi-room speaker; satellite-style model — all STT/intent/TTS runs on the HA host, the device only captures/plays audio |

## Hardware

Verified from `buildroot/configs/3reality_trspk_defconfig` and `buildroot/board/thirdreality/trspk/` unless noted.

- **SoC:** Amlogic **A113** (AXG family — the classic smart-speaker SoC), quad-core ARM Cortex-A53.
  Board name `S420` / u-boot `axg_s420_v1_trspk`, device tree `axg_s420_v03trspk`.
- **RAM:** 256 MB. **Flash:** 512 MB NAND (UBIFS rootfs; PEB 256 KiB, LEB 0x3e000, subpage 4 KiB).
- **Audio in:** dual digital microphones (product page). 16 kHz mono is what reaches HA.
- **Audio out:** 3 W / 4 Ω mono speaker.
- **Controls/UX:** LED ring (`src/tr/LedRing.*`; states: Listening / Thinking / Speaking / Muted),
  a Home button (`src/tr/HomeButton.*`), and a hardware mic-mute switch on GPIO
  (`src/tr/MicMuteGpio.*`).
- **Connectivity:** 2.4 GHz Wi-Fi only (Broadcom chipset; `wlan0` DHCP). Bluetooth LE present
  (BlueZ) — used for **Improv-via-BLE** Wi-Fi provisioning (shows as `3RSPK-XXXXX Improv via BLE`).
  No Ethernet, no Zigbee.
- **USB-C:** data-capable — carries ADB (android-tools5 adbd), fastboot, and Amlogic USB burn mode.

## Software stack

Buildroot-based Linux, kernel `amlogic-5.4` (`meson64_a64_smarthome` defconfig), u-boot `next-2015`
Amlogic fork. Notable packages from the defconfig:

- `linux-voice-assistant-cpp` — the voice satellite (see below)
- `sendspin-client` — Music Assistant streaming endpoint
- `tr-ledring` — LED ring daemon (D-Bus)
- PulseAudio, ALSA (+ libsamplerate, fftw), **FFmpeg + mpv** (all media playback goes through mpv)
- Avahi (mDNS), hostapd + dnsmasq (provisioning AP), wpa_supplicant (WPA3-capable), NTP
- dropbear SSH, swupdate (OTA), adbd
- TensorFlow Lite (`libtensorflowlite_c.so`, kept unstripped) — wake-word inference

### Access & debugging

- **SSH:** `ssh root@<device-ip>`, password **`hello3r`** (also the buildroot root password).
- **Serial (Debug edition board):** 115200 baud.
- **Supervisor HTTP server on port 8086** (`src/tr/SupervisorHttpServer.*`) — GET/POST endpoints
  for the on-device supervisor (OTA, state).
- **ADB** over the USB-C port.

### Flashing / building

- Firmware images (`*.img`) flash with the Windows **Amlogic Burn Tool** (`tools/Aml_Burn_Tool.zip`
  in the repo; install `Setup_Aml_Burn_Tool_V3.1.0.exe`, then run `v2/Aml_Burn_Tool.exe`), over the
  Type-C **data** cable or the debug board.
- Build from source: `./go --docker trspk <version>` (Docker) or native Ubuntu 20.04; output lands
  in `image/`. OTA thereafter via swupdate/UpdateEntity.

## The voice satellite: `linux-voice-assistant-cpp`

A C++ rewrite of the Open Home Foundation's
[OHF-Voice/linux-voice-assistant](https://github.com/OHF-Voice/linux-voice-assistant) (Python).
Full source lives in-repo at `buildroot/package/thirdreality/linux-voice-assistant-cpp/`.

### ESPHome native API server (`src/protocol/`)

- **TCP port 6053** (default, `--port` flag), plain varint-framed protobuf — **plaintext only, no
  Noise encryption, no password** (`DeviceInfoResponse.uses_password = false`; an
  `AuthenticationRequest` (the renamed `ConnectRequest`, msg id 3) is answered with an empty
  `AuthenticationResponse`). Uses the same `api.proto` we ship (`proto/api.proto` in the package).
- **API version 1.10** (`Connection.cpp`: `kApiVersionMajor = 1`, `kApiVersionMinor = 10`).
- **HelloResponse** carries only the device name (default `"3RSPK"` + suffix; `main.cpp:135`).
- **DeviceInfoResponse** (`Connection.cpp:201-226`):
  - `name` = `3RSPK…`, `friendly_name`, `mac_address`
  - `project_name` = `"ThirdReality.Linux Voice Assistant (C++)"`, `project_version`
  - `manufacturer` = `"ThirdReality"`, `model` = `"Linux Voice Assistant"`
  - `voice_assistant_feature_flags` = bits 0|2|3|4|5 = **VOICE_ASSISTANT | API_AUDIO | TIMERS |
    ANNOUNCE | START_CONVERSATION** (bit 1, legacy UDP speaker audio, deliberately NOT set — all
    audio flows over the API connection, like the PE).
- **mDNS** (`MdnsPublisher.cpp`, via Avahi): service `_esphomelib._tcp`, TXT records `mac=`,
  `version=`, `board=aarch64`, `platform=ThirdReality`, `network=wifi`. HA discovers it as
  `3RSPK-XXXXXXXXXXXX ESPHome`.

### Voice pipeline (`src/satellite/`, `src/audio/`)

- Wake word: **microWakeWord** on TFLite by default (`--wakeword-type micro`), models in
  `/usr/share/thirdreality/wakewords/microwakeword/` — shipped models include `okay_nabu`
  (default), `alexa`, `hey_jarvis`, `hey_mycroft`, `hey_home_assistant`, `hey_luna`,
  `choo_choo_homie`. **openWakeWord** selectable (`--wakeword-type open`,
  `/usr/share/thirdreality/wakewords/openwakeword/`), plus an external-wake-word mechanism
  (`ExternalWakeWord.*`) for HA-pushed models. Per-wake-word sensitivity exposed as a Number
  entity.
- Mic path: PCM ring buffer → optional **WebRTC gain + noise suppression** (5-level select entity,
  0–4, default 2 "Medium") → streamed to HA over the API after wake (`OpenStreamToHa`,
  `PumpAudioToHa`).
- Playback: `VoiceAssistantAnnounceRequest { media_id, preannounce_media_id, start_conversation }`
  → **mpv plays the URL** (`LibMpvPlayer`; any codec FFmpeg handles — FLAC included), then
  `AnnounceFinished`. `start_conversation` reopens the pipeline — the continue-conversation flow
  exists here too (`Satellite.cpp:264-276, 751-759`).
- Timers: full support (TIMERS flag; `timer_finished.flac` ring, start/stop in `Satellite.*`).
- Built-in sounds: `wake_word_triggered.flac`, `processing.wav` (thinking sound — toggleable
  entity), `timer_finished.flac`, `mute_switch_on/off.flac`.
- Entities exposed over the API (`main.cpp:411+`): MediaPlayer, mute Switch, "thinking sound"
  Switch, several Numbers (volume, wake sensitivity, mic gain…), Selects (noise suppression, wake
  word), Button, Event, Update (OTA).

## Music: Sendspin

The music half is **[Sendspin](https://www.sendspin-audio.com/)** (`sendspin-client` package +
`SendspinSignal.cpp` glue in the satellite) — the Open Home Foundation's open standard for
multi-room audio, integrated with **Music Assistant**:

- 100% local-network; devices auto-discover (no IPs/ports to configure); paired + encrypted.
- Multi-room sync spec'd at **<1 ms** (±0.5 ms) across rooms.
- Variable quality per endpoint — lossless FLAC up to 24-bit/96 kHz to hi-fi, efficient codecs to
  small speakers.
- Open spec ([sendspin-audio.com/spec](https://www.sendspin-audio.com/spec/)); reference
  client/server Apache-2.0; SDKs in C#, C++, Go, JavaScript, Kotlin, Python, Rust, Swift.

This is **orthogonal to the voice path** — our app doesn't need to touch Sendspin; music keeps
working via Music Assistant alongside whatever grabs the voice-assistant subscription.

## Integration notes for this app

What it takes for our ESPHome client (`esp-voice-assistant-client.mts`) to drive this device:

1. **Transport: works as-is.** Plaintext API on 6053, varint framing, same `api.proto` family. Our
   handshake (send `ConnectRequest`, don't wait for the response) is fine — this firmware actually
   still answers msg id 3, and either way we proceed immediately. API 1.10 passes our ≥ 1.5 gate.
2. **Discovery: works as-is.** `_esphomelib._tcp` matches our `.homeycompose/discovery/esphome.json`.
3. **Pairing sniff: MUST be extended.** The identity sniff (HelloResponse/DeviceInfoResponse
   substring match in `esp-voice-assistant-client.mts`) has no pattern that matches this device.
   Add e.g. `thirdreality` and/or `3rspk` → a new `deviceType` (e.g. `'3rspk'`), plus a new driver
   folder subclassing `VoiceAssistantDevice`/`VoiceAssistantDriver` (per-model flags TBD — start
   with `needDelayedPlayback = false` and test).
4. **Feature flags line up.** TIMERS (bit 3) → our timer flow cards work;
   ANNOUNCE + START_CONVERSATION → both our announce path and the in-band conversation flow have
   firmware support. API_AUDIO (bit 2) means mic audio arrives as API messages — same as the PE.
   Note bit 1 (UDP audio) is absent; we never used it.
5. **Playback is mpv, not ESP-side FLAC decode** — anything we serve over the LAN URL that FFmpeg
   decodes will play, so our FLAC pipeline is fine (and mp3 etc. would be too).
6. **Behavioral unknowns to verify live** (the PE-specific firmware quirks may not apply):
   whether a text-less TTS_START is required/ignored, whether the continue-conversation flag is
   sticky like the PE's, mic-open burst behavior (our `initial_audio_skip` tuning), and how the
   wake-word ding interacts with our skip logic. The `processing.wav` thinking-sound and LED
   states are driven by the device itself.
7. **Dev conveniences we didn't have with the PE:** root SSH (`root`/`hello3r`), on-device logs,
   ADB, and the full firmware source to read when behavior surprises us.

## Sources

- [Product page — thirdreality.com](https://www.thirdreality.com/products/voice-music-assistant-dev-edition)
- [Firmware source — github.com/thirdreality/voice-music-assistant](https://github.com/thirdreality/voice-music-assistant) (branch `linux-voice-assistant`)
- [Upstream — github.com/OHF-Voice/linux-voice-assistant](https://github.com/OHF-Voice/linux-voice-assistant)
- [Launch press release — prweb.com](https://www.prweb.com/releases/thirdreality-launches-voice--music-assistant-dev-edition-302767779.html)
- [Sendspin protocol — sendspin-audio.com](https://www.sendspin-audio.com/)
- [Amazon listing](https://www.amazon.com/Third-Reality-Voice-Music-Assistant/dp/B0GQYW153Z) · [ameriDroid listing](https://ameridroid.com/products/voice-music-assistant-dev-edition)
- [ThirdReality GitHub org](https://github.com/thirdreality)
