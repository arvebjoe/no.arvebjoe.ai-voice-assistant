# M5Stack AtomS3R + Atomic Echo Base

Integration assessment, researched 2026-08-06, prompted by
[issue #44](https://github.com/arvebjoe/no.arvebjoe.ai-voice-assistant/issues/44). Product:
[AtomS3R-AI Chatbot kit](https://docs.m5stack.com/en/core/AtomS3R-AI%20Chatbot) — an **AtomS3R**
controller (ESP32-S3, 8 MB flash + 8 MB PSRAM, 128×128 LCD) on an **Atomic Echo Base**
(ES8311 codec, microphone + speaker).

The decisive source is **M5Stack's own official ESPHome voice-assistant config** —
[`m5stack/esphome-yaml/common/atoms3r-with-echo-base.yaml`](https://github.com/m5stack/esphome-yaml/blob/main/common/atoms3r-with-echo-base.yaml)
(setup guide: [m5-docs voice assistant page](https://docs.m5stack.com/en/homeassistant/voice_assistant/atoms3r_with_atomic_echo_base_voice_assistant)) —
read remotely on 2026-08-06. All claims below derive from that file at `main`.

## TL;DR for this app

**Yes — it integrates the same way the ReSpeaker did, and it is even closer to the PE in
firmware shape** because the YAML is maintained by the vendor, not a community fork, and uses
only upstream ESPHome components.

- `voice_assistant:` with `micro_wake_word` **on-device wake words**: Okay Nabu, Hey Jarvis,
  Hey Mycroft, plus an internal "stop" model.
- `media_player: platform: speaker` with a **FLAC announcement pipeline @ 48 kHz mono** — the
  same design as the PE, so our FLAC-over-LAN-HTTP playback path is a direct fit
  (`needDelayedPlayback = false`).
- **Timers implemented** (`on_timer_finished` + timer ringing switch) — `esp.supportsTimers`
  will be true; the driver is on the timer flow cards.
- Mic feed: i2s 16 kHz/16-bit with the ESPHome software stages ON
  (`noise_suppression_level: 2`, `auto_gain: 31dBFS`, `volume_multiplier: 2.0`) — expect
  PE-like levels, **no `defaultMicGain` override**.
- `min_version: 2026.1.0` → post-2026.1 handshake (no `ConnectResponse`); our client already
  handles that.
- **No `esp32_improv`** — Wi-Fi credentials are baked in at flash time, so the pair flow has
  no Bluetooth step (mDNS scan + manual IP only), exactly like the ReSpeaker.
- `api:` block has **no encryption key** in the stock YAML; a device adopted by Home Assistant
  will typically have one — our Noise path covers that (`supportsEncryptedPairing = true`).

**The important user-facing caveat:** the kit **ships with M5Stack's "AI Chatbot" firmware,
which is not ESPHome** (it talks to XiaoZhi/OpenAI/Volcano cloud services over its own
protocol). Support means flashing M5Stack's ESPHome config over USB once. Users coming from
Home Assistant (like the issue reporter) have already done this.

## Identity (defaults — user-editable)

```yaml
esphome:
  name: ${name}                    # default "atoms3r-with-echo-base" → HelloResponse name
  friendly_name: ${friendly_name}  # default "AtomS3R Echo Base Voice Assistant"
  min_version: 2026.1.0
  # no project: block
```

No `project:` block, so `DeviceInfoResponse` carries only the name/friendly name (plus
ESPHome's own Espressif/board fields). The stable product tokens are **`atoms3r`** and
**`echo base`/`echo-base`**; **`m5stack`** is added as a family token for renamed devices.
The sniff branch in `esp-voice-assistant-client.mts` matches those → `deviceType = 'm5stack'`.

**The board fields are no help, and this bit us** (found 2026-08-07 by the issue-#44 reporter
on real hardware). The `esp32:` block sets only `variant: esp32s3` — there is **no `board:`** —
so ESPHome fills `DeviceInfoResponse.model` with its own default board for that variant
(`esp32-s3-devkitc-1`) and `manufacturer` with Espressif. Neither carries an M5Stack token.
Combined with the missing `project:` block, that leaves **`name` and `friendly_name` as the
only identifying strings on the whole device** — and both are user-editable substitutions.
The reporter had renamed his to "Mikro EG", so the sniff returned `null` and the device was
rejected as incompatible. The entity list still says "Echo Base Player", but the sniff
deliberately ignores entity messages (S6: any string field anywhere must not be able to
"validate" an identity), so that is not a signal we can use.

The fix was to make **manual IP entry** accept an unidentified-but-voice-capable device
(`probeManualEntry`, tested in `tests/pair-manual-entry.test.mts`): typing an address is the
user asserting the model, so a null `deviceType` is accepted while a device positively
identifying as a *different* model is still rejected. **Discovery stays strict** — listing
unidentifiable devices under every driver is exactly the confusion the sniff exists to
prevent — so a renamed AtomS3R still will not appear in the network scan, and manual entry
is the documented route for it.

**Ordering matters:** the branch sits **after** the `xiaozhi` match. RealDeco's XiaoZhi
ESPHome configs also run on M5-family hardware; an identity carrying both tokens (e.g.
`xiaozhi-m5stack-atom`) is XiaoZhi-shaped firmware and must pair through the XiaoZhi driver —
the firmware shape, not the board, decides the driver.

## Entities and controls

- **Mute:** template switch "Mute Microphone" → `object_id` `mute_microphone`.
  `scoreMuteCandidate()` already matches it (score 1 via the mic+mute rule) — no client change
  was needed.
- **Button:** GPIO41 `user_button` — **internal** (id only, no name), so no Event entity is
  exposed and the `button-pressed` flow card has no source. Short press stops a ringing timer
  locally; a 10 s hold factory-resets. The driver is deliberately absent from that card.
- **Display:** the firmware drives the 128×128 LCD itself (idle/listening/thinking/replying/
  error/muted pages) off `voice_assistant` phase changes — nothing for us to do.
- Selects for wake-word engine location ("On device" / "In Home Assistant") and wake-word
  sensitivity, plus an LCD backlight light entity — all irrelevant to the API we drive, except
  that users should keep the wake-word engine **On device**.

## Implementation status

**A driver was written on 2026-08-06 from this research alone — no hardware was available.**
The open verification list lives in [`TODO.md`](../../TODO.md) under
*"M5Stack AtomS3R driver — needs hardware verification"*. The issue reporter
([#44](https://github.com/arvebjoe/no.arvebjoe.ai-voice-assistant/issues/44)) owns three units
and volunteered to test.

What shipped:

| | |
|---|---|
| `drivers/m5stack-atoms3r/` | New driver: `thisAssistantType = 'm5stack'`, `supportsEncryptedPairing = true`, `improvNameFilter = null`, `needDelayedPlayback = false`, no `defaultMicGain` override (base 1×) |
| Pair views | `start` (no Bluetooth option), `manual_entry` (verbatim shared copy), `list_devices` → `encryption_check` → `add_devices` |
| `esp-voice-assistant-client.mts` | Identity sniff branch for `atoms3r` / `echo base` / `echo-base` / `m5stack`, ordered after `xiaozhi` |
| `tests/esp-client-events.test.mts` | 3 new cases: stock identity, renamed-device tokens, xiaozhi-vs-m5stack precedence |
| Flow cards | Added to the same 13 cards as the ReSpeaker (timers included, `button-pressed` excluded) |
| Artwork | Drawn stylised front view (module + grille base), **not** a product photo — placeholder pending real images |

## Unverified — confirm on real hardware

- Actual `voice_assistant_feature_flags` (TIMERS and ANNOUNCE are certain from the config;
  START_CONVERSATION assumed).
- Mic levels with `mic_gain` 0 (1×) — the on-device `auto_gain: 31dBFS` should make it
  PE-like, but 31 dBFS is aggressive; clipping on close-up speech is conceivable.
- `initial_audio_skip` / `followup_audio_skip` vs the wake sound.
- Whether the `volume_min: 0.5` / `volume_max: 0.8` clamp in the media player interacts oddly
  with our `volume_set` mapping (a 0–1 Homey range may span only the clamped window).
- Whether the older **Atom Echo** (non-S3R, PICO-based) also pairs via the `m5stack` token —
  it has far less RAM, usually no `micro_wake_word`, and was NOT part of this assessment.

## Sources

- [m5-docs — AtomS3R + Atomic Echo Base voice assistant](https://docs.m5stack.com/en/homeassistant/voice_assistant/atoms3r_with_atomic_echo_base_voice_assistant)
- **[m5stack/esphome-yaml — atoms3r-with-echo-base.yaml](https://github.com/m5stack/esphome-yaml/blob/main/common/atoms3r-with-echo-base.yaml)** — the config every protocol claim above is verified against
- [m5-docs — AtomS3R-AI Chatbot product page](https://docs.m5stack.com/en/core/AtomS3R-AI%20Chatbot)
- [Issue #44](https://github.com/arvebjoe/no.arvebjoe.ai-voice-assistant/issues/44) — the feature request this work answers
