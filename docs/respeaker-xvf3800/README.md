# Seeed reSpeaker XMOS XVF3800 with XIAO ESP32S3

Integration assessment, researched 2026-07-28. Product:
[reSpeaker XVF3800 with Case + XIAO ESP32S3](https://www.seeedstudio.com/ReSpeaker-XVF3800-With-Case-XIAO-ESP32S3-p-6628.html)
(also sold [without case](https://www.seeedstudio.com/ReSpeaker-XVF3800-4-Mic-Array-With-XIAO-ESP32S3-p-6489.html)).

The decisive source is **not** the product page — it is the community ESPHome integration at
[formatBCE/Respeaker-XVF3800-ESPHome-integration](https://github.com/formatBCE/Respeaker-XVF3800-ESPHome-integration),
whose [`config/respeaker-xvf-satellite-example.yaml`](https://github.com/formatBCE/Respeaker-XVF3800-ESPHome-integration/blob/main/config/respeaker-xvf-satellite-example.yaml)
(62 KB) was read in full for this assessment. Line numbers below refer to that file at `main`,
retrieved 2026-07-28.

## TL;DR for this app

**Yes — it can integrate, and it is the closest architectural match to the Voice PE we have seen.**
The satellite config is essentially a **port of the Home Assistant Voice PE's own
`home-assistant-voice.yaml`**: same `speaker_source` media player, same FLAC announcement pipeline,
same LED phase state machine, and it literally pulls the PE's sound files from
`github.com/esphome/home-assistant-voice-pe` (lines 20–30). It runs **stock ESPHome**, so it speaks
the **native API on TCP 6053** — exactly what `src/voice_assistant/esp-voice-assistant-client.mts`
already drives — and advertises `_esphomelib._tcp` with `platform=ESP32`, so our mDNS discovery
condition matches unchanged.

**Two blockers, both small and both on our side:**

1. **Our identity sniff doesn't know it.** `respeaker` / `xvf3800` match none of our current strings
   (`nabu casa`, `home assistant voice`, `thirdreality`, `3rspk`, `xiaozhi`), so pairing rejects it.
2. **It needs its own driver** (`thisAssistantType`), the same ~30 lines the ThirdReality driver took.

**The one thing that is genuinely different from the PE and TR: this is DIY firmware.** There is no
factory image with a fixed identity — the user compiles the YAML themselves and can rename the
device to anything. Every identity string below is a *default*, not a guarantee. That shapes how
tolerant the sniff has to be (see [Integration notes](#integration-notes-for-this-app)).

---

## Product

| | |
|---|---|
| Name | reSpeaker XMOS XVF3800 4-Mic Array with XIAO ESP32S3 |
| Variants | With / without enclosure; with / without pre-soldered XIAO ESP32S3. There is also a [Flex XVF3800 Circular-4](https://www.seeedstudio.com/reSpeaker-Flex-XVF3800-Circular-4-with-XIAO-ESP32S3-p-6739.html) sibling. |
| Modes | **Dual: I2S** (standalone, ESP32-S3 drives it — the mode that matters here) **or USB** (plain USB mic array for a PC/SBC) |
| Positioning | Far-field voice front-end for ESPHome / Home Assistant satellites, robotics, conference audio |

## Hardware

Marketing specs from the Seeed listings and [CNX Software](https://www.cnx-software.com/2025/07/29/respeaker-xmos-xvf3800-4-mic-array-board-features-esp32-s3-module-works-over-usb/);
everything in the **Verified from the config** column is read directly out of the working ESPHome YAML,
so it is the more trustworthy set.

- **Voice DSP:** XMOS **XVF3800** — circular **4-mic array**, 360° far-field pickup to ~5 m, with
  on-chip **AEC, AGC (60 dB), beamforming, de-reverberation, noise suppression, VAD and DoA**
  (direction of arrival). This is real hardware DSP, not a software stack — the same class of
  front-end that makes the PE's mic feed clean.
- **MCU:** XIAO **ESP32-S3**, Wi-Fi + BLE.
- **Speaker:** on-board amplified output (the "with case" SKU ships an enclosure + speaker).
  Exact amplifier wattage not verified — the listings don't state it.
- **Connectors:** USB Type-C (power + USB-mode data).

### Verified from the config

| Thing | Value | Line |
|---|---|---|
| Board / framework | `esp32-s3-devkitc-1`, `variant: esp32s3`, **esp-idf**, 240 MHz | 65–72 |
| Flash | **8 MB** | 70 |
| PSRAM | **octal, 80 MHz**, `ignore_not_found: false` (i.e. required) | 166–168 |
| XVF3800 control bus | **I²C `0x2C`** on `sda: GPIO5` / `scl: GPIO6` @ 100 kHz | 160–164, 1384–1386 |
| Audio DAC | **TI AIC3104** (`aic3104_dac`, own external component) | 1254, 1425 |
| I2S pins | LRCLK `GPIO7`, BCLK `GPIO8`, DIN `GPIO43`, DOUT `GPIO44` | 1206–1247 |
| I2S clocking | ESP32 is **`i2s_mode: secondary`** — the XVF3800 is I2S **master** | 1237, 1246 |
| Audio format | **48 kHz, 32-bit, stereo** in and out | 1229–1251 |
| LEDs | LED ring, driven **over I²C by the XMOS chip** — not an ESPHome `light` | Readme |
| Buttons | **none** | Readme |
| Min ESPHome | **2026.6.0** | 39 |

The `i2s_mode: secondary` detail is the interesting engineering bit: the XVF3800 needs a 12.288 MHz
MCLK that ESPHome cannot generate, so the firmware makes the XMOS chip the I2S master and lets it
clock itself (the `i2s_mclk_pin` lines are commented out at 1214 / 1225). It also means
this integration depends on a **forked `i2s_audio` component**
([formatBCE/esphome@respeaker_microphone](https://github.com/formatBCE/esphome/tree/respeaker_microphone)),
not upstream ESPHome — a real maintenance dependency worth flagging to users.

## Firmware and what it exposes

Stock ESPHome 2026.6+ plus three external components (lines 1367–1381): the forked `i2s_audio`,
and `respeaker_xvf3800` + `aic3104` from the integration repo.

### Identity (defaults — user-editable)

```yaml
esphome:
  name: respeaker-xvf3800-assistant          # → HelloResponse name
  friendly_name: reSpeaker XVF3800 Assistant # → DeviceInfoResponse
  project:
    name: formatbce.Respeaker XVF3800 Satellite
    version: 2026.6.0
```

`manufacturer` / `model` in `DeviceInfoResponse` come from ESPHome itself (Espressif / the board
name), so **the only device-specific tokens are `respeaker` and `xvf3800`** — and they appear in the
device name, the friendly name *and* the project name, i.e. in both identity-bearing messages.

### What discovery will actually show — derivable from the YAML alone

Nothing here has to be guessed or observed on hardware: ESPHome derives every discovery field
mechanically from those three keys. Verified against
[`mdns_component.cpp`](https://github.com/esphome/esphome/blob/dev/esphome/components/mdns/mdns_component.cpp)
(`dev`, read 2026-07-28):

| Field | Derived from | Value for this YAML |
|---|---|---|
| mDNS hostname / service instance | `App.get_name()` ← `esphome: name:` (line 262) | `respeaker-xvf3800-assistant` → `respeaker-xvf3800-assistant._esphomelib._tcp.local` |
| `txt.friendly_name` | `esphome: friendly_name:` (line 132) | `reSpeaker XVF3800 Assistant` |
| `txt.platform` | compile target, literal (line 146) | `ESP32` → satisfies our discovery regex |
| `txt.board` | `ESPHOME_BOARD` (line 158) | `esp32-s3-devkitc-1` |
| `txt.network` | literal (line 162) | `wifi` |
| `txt.mac` | chip MAC (line 140) | per-unit → our `{{txt.mac}}` discovery id |
| `txt.project_name` / `_version` | `esphome: project:` (lines 190–192) | `formatbce.Respeaker XVF3800 Satellite` / `2026.6.0` |
| `txt.api_encryption` | only when a Noise PSK is set (line 176) | **absent** — this config sets no key |
| `txt.version`, `txt.config_hash` | ESPHome version + config hash | build-dependent |

Our pair list labels a device `r.txt?.friendly_name || r.name || r.host || 'ESPHome ####'`
(`voice-assistant-driver.mts:155`), and ESPHome always publishes `friendly_name` in TXT when it is
set. So with the stock example config **the device appears in Homey's pair list as exactly
"reSpeaker XVF3800 Assistant"** — predictable up front, no hardware needed.

Both identity tokens survive into the API handshake too: `HelloResponse.name` is the same
`App.get_name()` string (`respeaker-xvf3800-assistant`), and `DeviceInfoResponse` carries the
friendly name and project name. So a sniff on `respeaker` / `xvf3800` hits regardless of which of
the two identity messages arrives first.

The caveat is narrower than "we can't know the name": the mapping is exact, but **a user editing
`name:` / `friendly_name:` changes it**, and only `esphome: name:` is constrained (lowercase,
hyphens). Someone who sets `name: kitchen-speaker` and drops the project block leaves no matchable
token at all — which is the argument for matching the two product tokens rather than the full
default string, and for keeping manual IP entry as the fallback.

**Bonus finding, relevant to the existing PE/TR pair flow:** current ESPHome publishes
`api_encryption_supported` (not `api_encryption`) when Noise is compiled in but **no** key is set,
and adds `api_provisioning=zero-psk` for the newer key-provisioning flow (lines 171–186). Our
`requiresEncryption: !!r.txt?.api_encryption` check (`voice-assistant-driver.mts:167`) is therefore
still correct — it keys off the record that only appears when a PSK really is set — but the newer
records are worth knowing about if we ever want to detect "encryption available but unprovisioned".

### API / transport

- `api:` block at line 118 — **no `encryption:` key in the example**, so out of the box it is
  **plaintext** on 6053. Users who adopt the device in the ESPHome dashboard will typically get a
  Noise key added; our client already handles both (`noise-frame-codec.mts`).
- It defines three custom user actions (`set_led_color`, `start_va`, `stop_va`, lines 120–148) —
  irrelevant to us, we don't call user actions.
- `ota:` uses an OTA password (line 154); that's the OTA channel, not the API, and doesn't affect us.
- min_version 2026.6.0 means it is firmly in the **post-2026.1 handshake** world — no
  `ConnectResponse`. Our client already doesn't wait for one (see CLAUDE.md); nothing to change.

### Voice assistant (lines 1609–1771)

- `microphone: i2s_mics` with **`channels: 0`** — ESPHome downmixes/resamples the 48 kHz stereo feed
  to the 16 kHz mono the API audio path expects, which is what our `chunk` handler already assumes.
- `media_player: external_media_player` → **ANNOUNCE** works; that media player is a
  `speaker_source` platform with an **announcement pipeline in FLAC @ 48 kHz mono** (lines 1312–1332).
  Our FLAC-over-LAN-HTTP playback path is a direct fit — this is the same design as the PE.
- **On-device wake word:** `micro_wake_word: mww`, `use_wake_word: false` (lines 1430–1505) — models
  include Okay Nabu, Hey Jarvis, Hey Mycroft, Kenobi, plus a **"stop" word** used to interrupt a
  reply mid-speech.
- **Timers: fully implemented** — `on_timer_started` / `_updated` / `_cancelled` / `_tick` /
  `_finished` (lines 1725–1771), with LED countdown and a ring sound. So `esp.supportsTimers` will
  be true and our timer flow cards / tool gating work.
- `noise_suppression_level: 0`, `auto_gain: 0 dbfs`, `volume_multiplier: 1` — **deliberately all
  off**, because the XMOS chip already did the work. This is the opposite of the ThirdReality, whose
  quiet WebRTC-processed feed forced `defaultMicGain = 4`. Expect PE-like levels here, i.e.
  **start at the PE's defaults, not the TR's**.
- Beamforming is actively managed around the pipeline: the beam is locked to the speaker during
  capture and released on `on_stt_vad_end` / `on_end` (`id(respeaker).unlock_beam()`) so the stop-word
  detector still hears the room during TTS.

### Expected feature flags

From the config, `voice_assistant_feature_flags` will certainly carry **VOICE_ASSISTANT | API_AUDIO |
TIMERS | ANNOUNCE**. START_CONVERSATION is likely (same ESPHome generation as the PE) but was not
verified from source — check it live on first connect.

### Entities

`external_media_player` (media player), `Microphone Mute` switch (from the `respeaker_xvf3800:`
block), several template switches (`Mute-unmute sound`, `Wake sound`, `Beam lock`, `Alarm on`),
numbers, selects (wake-word / LED colour presets), and `Next timer` / `Next timer name` sensors.
**No Event entity and no buttons** — the device has no physical buttons at all.

### Music

The config includes `sendspin:` (line 1280) and a `sendspin` media player — the same Open Home
Foundation multi-room protocol the ThirdReality uses. Orthogonal to the voice path; we don't touch it.

## Integration notes for this app

What it would take for `esp-voice-assistant-client.mts` + a driver to drive this device:

1. **Transport: works as-is.** Stock ESPHome native API, varint-framed protobuf, same `api.proto`,
   API version well above our ≥ 1.5 gate. Plaintext by default, Noise supported if the user sets a key.
2. **Discovery: works as-is.** ESPHome publishes `_esphomelib._tcp` with `platform=ESP32`, which
   satisfies the existing regex in `.homeycompose/discovery/esphome.json` — no change needed.
3. **Identity sniff: the actual blocker.** Add a branch in `handleFrame()` (currently
   `esp-voice-assistant-client.mts:550-576`) matching **`respeaker`** or **`xvf3800`** →
   `deviceType = 'respeaker'`. Because the firmware is user-compiled, match on those two product
   tokens rather than on the full default name or the `formatbce.` project prefix — a user who sets
   `name: kitchen-respeaker` must still pair, and one who renames it to something with no
   distinguishing token at all falls back to manual IP entry.
4. **New driver:** `drivers/respeaker-xvf3800/` with `thisAssistantType = 'respeaker'`,
   `needDelayedPlayback = false` (PE-like playback path), and **no `defaultMicGain` override** — the
   XMOS front-end is clean, unlike the TR. `supportsEncryptedPairing = true` is appropriate (copy the
   PE/TR pair views: `start`, `manual_entry`, `encryption_check`). Set
   `improvNameFilter = null` — see the next point. Also note `encryptedResultMatchesDriver()`
   (`voice-assistant-driver.mts:191-194`) currently splits the world into "ThirdReality vs
   everything else", so an encrypted, un-probeable ReSpeaker will be offered by the PE, XiaoZhi
   *and* ReSpeaker drivers alike; that ambiguity already exists between PE and XiaoZhi and is
   resolved by the keyed probe, so it needs no new logic — just don't expect the pre-key filter to
   disambiguate.
5. **No Improv BLE.** The example config has **no `esp32_improv:` component** — the only `improv_*`
   references (lines 100, 208–209, 823, 861–862) are leftover LED-animation state carried over from
   the PE config. Users flash over USB with their Wi-Fi credentials already baked into `secrets.yaml`,
   so the BLE provisioning wizard has nothing to talk to. The pair flow should offer **mDNS +
   manual IP only**.
6. **Mute control will silently no-op.** `setMute()` looks up `entityKeys['mute']`
   (`esp-voice-assistant-client.mts:1164`), which is only populated when a switch's `object_id` is
   exactly `mute`. The ReSpeaker's mic-mute switch is named **"Microphone Mute"** → `object_id`
   `microphone_mute`, and no other switch in the config is called `mute`. So the `volume_mute`
   capability would log *"No mute switch entity found"* and do nothing. **Fix:** relax the lookup to
   match a switch whose `object_id` contains `mute` (mirroring what the number handler already does
   for `volume` at line 647), preferring an exact `mute` when present. Cheap, and it makes the
   client tolerant of any renamed satellite rather than only this one.
7. **Volume works.** It is routed through the primary media-player entity (line 624), and
   `external_media_player` is registered normally.
8. **No button flow card.** There are no buttons and no Event entity, so the `button-pressed` trigger
   that the ThirdReality driver relies on simply has no source here. Nothing breaks — the card just
   never fires. (The "stop" wake word is the device's own interrupt mechanism, handled on-device.)
9. **Timers, announce, FLAC playback:** all supported, no work.

Rough size: a sniff branch, a ~30-line driver + compose/assets, three copied pair views, and the
one-line mute lookup relaxation. No changes to the audio pipeline, the protocol layer, or the
provider seam.

### Caveats worth telling users

- The integration is **community-maintained and explicitly marked "under development, use on your own
  risk"** in its Readme, and it depends on a **forked `i2s_audio`** component. It is not a Seeed or
  Nabu Casa product; upstream ESPHome changes can break it.
- **Setup is DIY**: install ESPHome, add `secrets.yaml`, compile and flash over USB. There is no
  web installer and no factory firmware. That is a materially higher bar than the PE or the TR.
- Seeed also publishes a **XiaoZhi tutorial** for this hardware
  ([wiki](https://wiki.seeedstudio.com/respeaker_xvf_3800_xiaozhi/)). That flashes the
  `xiaozhi-esp32` firmware, which talks its own protocol to XiaoZhi cloud servers — it does **not**
  expose the ESPHome native API, so it is **not** a shortcut into this app via our existing
  `xiaozhi` device type. Our XiaoZhi driver targets XiaoZhi *hardware running ESPHome*. Worth a live
  check before telling a user either way.

### Unverified — confirm on real hardware

- Actual `voice_assistant_feature_flags` value (esp. START_CONVERSATION).
- Whether Seeed's own wiki YAML (proxy-blocked at research time; only the community config was
  readable) uses different `name` / `project` strings — if it drops the `respeaker` token, the sniff
  needs widening.
- Mic-open burst behaviour vs our `initial_audio_skip` tuning, and how the wake-word ding interacts
  with it.
- Speaker amplifier wattage and enclosure acoustics.

## Sources

- [Product page — with case](https://www.seeedstudio.com/ReSpeaker-XVF3800-With-Case-XIAO-ESP32S3-p-6628.html) · [without case](https://www.seeedstudio.com/ReSpeaker-XVF3800-4-Mic-Array-With-XIAO-ESP32S3-p-6489.html) · [Flex Circular-4](https://www.seeedstudio.com/reSpeaker-Flex-XVF3800-Circular-4-with-XIAO-ESP32S3-p-6739.html)
- **[formatBCE/Respeaker-XVF3800-ESPHome-integration](https://github.com/formatBCE/Respeaker-XVF3800-ESPHome-integration)** — components + [the example satellite YAML](https://github.com/formatBCE/Respeaker-XVF3800-ESPHome-integration/blob/main/config/respeaker-xvf-satellite-example.yaml) that every protocol claim above is verified against
- [formatBCE/esphome @ respeaker_microphone](https://github.com/formatBCE/esphome/tree/respeaker_microphone) — the forked `i2s_audio` component
- [Seeed wiki — Home Assistant voice control](https://wiki.seeedstudio.com/respeaker_xvf3800_xiao_home_assistant/) · [getting started](https://wiki.seeedstudio.com/respeaker_xvf3800_xiao_getting_started/) · [XiaoZhi deployment](https://wiki.seeedstudio.com/respeaker_xvf_3800_xiaozhi/)
- [CNX Software — hardware overview](https://www.cnx-software.com/2025/07/29/respeaker-xmos-xvf3800-4-mic-array-board-features-esp32-s3-module-works-over-usb/)
- [tutoduino — Voice Assistant with ReSpeaker XVF3800 and ESPHome](https://tutoduino.fr/en/respeaker-xvf3800/) · [Smart Home Circle review](https://smarthomecircle.com/respeaker-xvf3800-home-assistant-voice-assistant) · [XDA](https://www.xda-developers.com/respeaker-xvf3800-esp32-amazon-echo/)
- [respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY](https://github.com/respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY) — upstream hardware repo
