
# AI Voice Assistant for Homey

<img src="./assets/images/large.png" alt="App banner" />

A Homey app that connects small ESP32‑based voice devices to the cloud so you can talk to your smart home. The app bridges on‑device microphones/speakers with cloud speech‑to‑text, reasoning, and text‑to‑speech, lets the assistant control your Homey devices, answer questions and run timers, and exposes handy Flow cards — all simple enough to flash and use on inexpensive hardware.

You choose the AI engine: **OpenAI** or **Google Gemini**.

> **Status:** Active development. See [todo.md](./TODO.md) for planned features and open tasks.

---

## Supported devices

### 1) Home Assistant Voice: Preview Edition (PE)

<img src="./drivers/home-assistant-voice-preview-edition/assets/images/large.png" height="160" alt="Voice PE" />

**Firmware**: Official ESPHome firmware.

**How to flash / (re)install**

1. Use a Chromium‑based browser (Chrome/Edge) that supports Web Serial.
2. Open the installer: [https://esphome.github.io/home-assistant-voice-pe/](https://esphome.github.io/home-assistant-voice-pe/)
3. Click **Connect**, choose the device’s COM/USB port.
4. Pick a firmware version and click **Install**.
5. When prompted, enter your Wi‑Fi credentials.
6. After boot, optionally assign a **static IP** in your router/DHCP.

**Tips**

* You can update/monitor later using the ESPHome Web tools.
* If the device doesn’t appear for OTA updates, try power‑cycling and ensure your network resolves the device hostname.

---

### 2) XiaoZhi AI devices (RealDeco firmware)

<img src="./drivers/xiaozhi-ai/assets/images/large.png" height="160" alt="XiaoZhi AI" />
<img src="./.resources/devices_1.jpg" height="160" alt="XiaoZhi AI" />
<img src="./.resources/devices_2.jpg" height="160" alt="XiaoZhi AI" />
<img src="./.resources/devices_3.png" height="160" alt="XiaoZhi AI" />
<img src="./.resources/devices_4.png" height="160" alt="XiaoZhi AI" />

**Firmware**: Community ESPHome configs by RealDeco.

**How to flash**

1. Connect the XiaoZhi via USB.
2. Go to the RealDeco repo for your model: [https://github.com/RealDeco/xiaozhi-esphome](https://github.com/RealDeco/xiaozhi-esphome)
3. Use **ESPHome Web** ([https://web.esphome.io/](https://web.esphome.io/)) to do the first flash if needed.
4. In ESPHome, create or take over the device, paste the config from the repo, keep the **device name** unchanged, and install.
5. First‑time install may require USB flashing to update partitions; later you can update OTA.

**Notes**

* Some models have different screens/touch options—use the matching YAML.
* If a device gets stuck after a wrong name/config, enter bootloader (usually holding/combining buttons) and re‑flash over USB.

---

## What you can do by voice

Once a device is set up, just speak naturally. The assistant can:

* **Control devices** — turn lights, plugs and other devices on/off, dim lights, and set thermostat temperature.
* **Lock & unlock doors** — control supported smart locks by voice.
* **Ask about the weather** — current conditions and a short forecast for your location.
* **Ask the time & date** — answered from your Homey’s local time and timezone.
* **Set timers & alarms** — e.g. *“set a 10 minute timer”* or *“wake me at 7”*. The device counts down on its LED ring and chimes when time’s up; cancel it by voice.
* **Ask anything** — general questions answered by the AI.

The assistant understands and replies in many languages — pick yours in **Settings**.

---

## Choosing an AI engine (provider)

The app supports two cloud providers; select one in **Settings → Voice provider**:

* **OpenAI Realtime** — uses OpenAI for speech‑to‑text, reasoning and text‑to‑speech.
* **Google Gemini Live** — uses Google Gemini for the same pipeline.

You only need an API key for the provider you actually use.

### OpenAI API key

1. Sign in at [https://platform.openai.com/](https://platform.openai.com/)
2. Go to **API keys** (account/organization settings) and **Create new secret key**.
3. Copy the key and keep it secret; paste it into the app settings in Homey.

> If your OpenAI account is new, you may need to add billing to enable API usage.

### Google Gemini API key

1. Sign in at [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. **Create API key** and copy it.
3. Paste it into the app settings in Homey.

---

## App settings
<img src="./.resources/settings.jpg" height="500" alt="Settings" />

  - **Voice provider** — choose **OpenAI Realtime** or **Google Gemini Live**.
  - **OpenAI API key** — required for the OpenAI provider.
  - **Gemini API key** — required for the Gemini provider.
  - **Language** — the language you’ll speak with the assistant. Supported: English, Dutch, German, French, Italian, Swedish, Norwegian, Spanish, Danish, Russian, Polish, Korean.
  - **Voice** — the voice the assistant speaks with. The available voices depend on the selected provider.
  - **Optional AI instructions** — personality or behaviour tweaks. Be careful: this **will** affect the AI. Write it in English.

---

## Features in Homey

### Devices

* **Voice PE** and **XiaoZhi AI** appear as devices with controls for power/session (on/off), volume, and mute.
* When a timer is running, the device tile shows the timer’s **name** and **time remaining**.

### Flow cards

**Triggers**

* **When** a timer is started
* **When** a timer finishes
* **When** a timer is cancelled
* Plus standard device triggers (turned on/off, volume changed)

**Conditions**

* **And** Is muted
* **And** A timer is / is not running
* Plus the standard “is turned on” condition

**Actions**

* **Then** Ask the assistant a question — output as **text** (use the answer elsewhere in a Flow)
* **Then** Ask the assistant a question — output as **audio** on the device speaker
* **Then** **Say** something — turns text into speech and plays it on the device speaker
* **Then** Playback an audio URL on the device speaker (format must be **.flac**)
* **Then** Start a timer
* **Then** Cancel the timer
* Plus standard device actions (turn on/off to start/stop a session, set volume, mute/unmute)

> Names may vary slightly as the app evolves—see the in‑app Flow picker for the authoritative list.

---

## Quick start

1. **Flash** your device (PE or XiaoZhi) using the steps above and connect it to Wi‑Fi.
2. **Install** this app on your Homey.
3. **Choose** your voice provider and enter the matching API key in the app settings.
4. **Add** your device in Homey (pairing flow per driver).
5. **Test** by running the *Ask the assistant* / *Say* action from a Flow, or use the device’s hardware button/wake word.

---

## Developing

Want to contribute or experiment? You can run the app **without Homey hardware** using the built‑in emulator.

```bash
npm install
npm run build      # compile TypeScript (.mts -> .homeybuild/)
npm test           # run the test suite (vitest)
npm run emulator   # run the app without a Homey
```

See [emulator/README.md](./emulator/README.md) for details. Running on real hardware uses the Homey CLI (`homey app run --remote`).

---

## Troubleshooting

* **Flashing/USB issues**: Try another USB cable/port; if needed, enter bootloader mode and re‑flash.
* **Device not updating OTA**: Ensure it’s online and reachable; verify hostname/DNS on your LAN.
* **No audio/response**: Check device volume (if applicable) and confirm the **selected provider’s** API key is set and valid.

---

## Privacy & security

* Your API keys stay in your Homey app settings, and sensitive details (such as keys) are masked in the app logs.
* Depending on the provider you choose, audio and text are sent to **OpenAI** or **Google** to fulfil your requests. Do not use this app if that’s not acceptable for your environment.

---

## Roadmap

Planned features and ideas live in **[todo.md](./TODO.md)**.

---

## Acknowledgements

* **ESPHome** and the Home Assistant community
* **RealDeco** for the XiaoZhi ESPHome configs
* Everyone experimenting with tiny ESP32 voice devices 💛
