# Voice PE Hardware Reference

Source: https://www.home-assistant.io/voice-pe/

---

## Overview

The **Home Assistant Voice Preview Edition** is a dedicated voice satellite device designed and
built by **Nabu Casa** in collaboration with the **Open Home Foundation**. It is fully open-source
(firmware for both the ESP32-S3 and the XMOS chip are on GitHub) and is privacy-focused, with
support for fully local processing.

**Price:** $69 USD / €59 EUR

---

## Physical Specifications

| Parameter | Value |
|---|---|
| Dimensions | 84 × 84 × 21 mm |
| Weight | 96 g |
| Packaged dimensions | 94 × 94 × 30 mm |
| Packaged weight | 120 g |
| Enclosure material | Injection-moulded polycarbonate (white, semi-transparent elements) |
| Opening method | Screws only — no clips |

---

## Internal Hardware

| Component | Details |
|---|---|
| **Main SoC** | ESP32-S3 |
| **Flash** | 16 MB |
| **PSRAM** | 8 MB octal |
| **Audio processor** | XMOS XU316 |
| **DAC** | Texas Instruments AIC3204 — 48 kHz sampling |
| **Wi-Fi** | 2.4 GHz 802.11 b/g/n |
| **Bluetooth** | Bluetooth 5.0 |
| **Power** | USB-C, 5 V DC, 2 A |

> Note: Only 2.4 GHz Wi-Fi is supported. The device does not support 5 GHz networks.

---

## Audio Hardware

| Component | Details |
|---|---|
| Microphones | Dual-microphone array |
| Mic connection | I2S to XMOS XU316 |
| XMOS processing | Echo cancellation, stationary noise removal, auto gain control |
| Internal speaker | Yes — for voice feedback and TTS playback |
| Headphone jack | 3.5 mm (⅛") stereo jack with dedicated DAC (TI AIC3204) |
| Mute switch | Hardware — physically cuts power to microphones |

---

## External Controls & Indicators

| Control / Port | Function |
|---|---|
| **Rotary dial** | Volume adjustment; press = multipurpose button (stop / start conversation / confirm) |
| **Mute switch** | Hardware microphone mute — LED ring changes colour to indicate muted state |
| **LED ring** | Multicolour — shows device phase (idle, listening, thinking, replying, error, muted) |
| **Grove port** | I2C expansion — connect sensors or accessories |
| **USB-C port** | Power input (5 V, 2 A) and firmware flashing |
| **Headphone jack** | 3.5 mm stereo audio output |
| **PCB pads** | Exposed for hardware modification / debugging |

### LED Ring States

| Colour / Animation | Meaning |
|---|---|
| Static colour | Idle — waiting for wake word |
| "Waiting" animation | Wake word detected, awaiting voice command |
| "Listening" animation | Recording voice command |
| Pulsing | Processing (HA running the pipeline) |
| "Replying" animation | Playing TTS response |
| Mute colour | Microphone muted |
| Flashing red | Error state |
| Initialisation sequence | Booting / not ready |

---

## Connectivity & Expansion

### Wi-Fi
- 2.4 GHz only (see note above)
- Credentials configured during first-time setup via the Home Assistant Companion app or browser
- Encryption key is stored on the device — tied to the specific Home Assistant instance

### Grove Port
- Protocol: I2C
- Use cases: temperature/humidity sensors, displays, other Grove-compatible accessories
- Theoretical future use: wired network adapter

### USB-C
- Primary purpose: power (5 V, 2 A)
- Secondary use: firmware flashing via browser at https://esphome.github.io/home-assistant-voice-pe/
- Not included in box: USB-C cable or charger

---

## Firmware

- **Framework:** ESPHome (preloaded at factory)
- **Firmware source:** https://github.com/esphome/home-assistant-voice-pe
- **Licence:** Open-source
- **XMOS firmware:** Also open-source, available in the same repository
- **Update method:** OTA via Home Assistant, or browser-based installer at the ESPHome GitHub page
- **Factory reset:** Hold the button during boot to enter bootloader mode

---

## Software & Integration

### Communication with Home Assistant
The Voice PE communicates via the **ESPHome Native API** (TCP port 6053, protobuf-encoded).
See [esphome-native-api.md](esphome-native-api.md) for the full protocol reference.

### Voice Processing Modes

| Mode | Description | Hardware requirement |
|---|---|---|
| **Focused local** | Speech-to-Phrase — limited to predefined home-control sentences | Any HA hardware |
| **Full local** | Whisper STT + Piper TTS — full natural language | Intel N100 or equivalent recommended |
| **Cloud (Nabu Casa)** | Microsoft Azure STT/TTS — privacy-first, no data retained | Home Assistant Cloud subscription |

### AI / LLM Integration
The device can be connected to any Assist conversation agent, including:
- OpenAI (GPT)
- Google Gemini
- Anthropic Claude
- Local LLMs (Ollama, etc.)

### Language Support
- 60+ languages and dialects
- Availability varies between local and cloud processing modes
- Community translations are ongoing

---

## Environmental

| Parameter | Value |
|---|---|
| Operating temperature | 0 °C – 30 °C (32 °F – 86 °F) |
| Humidity | Non-condensing |
| Indoor use only | Yes |

---

## Privacy

- The hardware mute switch physically disconnects microphone power — no software bypass is possible.
- Local processing modes keep all audio on-premises.
- Home Assistant Cloud (Nabu Casa) uses Microsoft Azure services; per their terms, **no audio or
  transcription data is retained or stored**.
- Fully open firmware means the device can be audited.

---

## Where to Buy

Available from global authorised retailers including:
- **ameriDroid** (North America)
- **Seeed Studio** (Asia / worldwide)
- **Apollo Automation** (North America)
- Regional electronics retailers across Europe and Australia

---

## Resources

| Resource | URL |
|---|---|
| Product page | https://www.home-assistant.io/voice-pe/ |
| Firmware source | https://github.com/esphome/home-assistant-voice-pe |
| Browser installer | https://esphome.github.io/home-assistant-voice-pe/ |
| Wyoming protocol | https://github.com/OHF-Voice/wyoming |
| ESPHome Native API | https://esphome.io/components/api/ |
| Assist pipeline dev docs | https://developers.home-assistant.io/docs/voice/pipelines/ |
| Assist satellite entity | https://developers.home-assistant.io/docs/core/entity/assist-satellite/ |
