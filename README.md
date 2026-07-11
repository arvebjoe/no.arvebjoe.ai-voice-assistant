# AI Voice Assistant for Homey

<img src="./assets/images/large.png" alt="App banner" />

Talk to your smart home. This Homey app connects small, inexpensive voice devices
(Home Assistant Voice Preview Edition, XiaoZhi AI, ThirdReality Voice & Music Assistant) to an AI
assistant that controls your Homey devices, answers questions, plays music, runs timers, and
speaks back — in your language.

You choose the brain: **OpenAI**, **Google Gemini**, or a fully **local / self-hosted** pipeline
(Whisper + Ollama + Piper and friends) where no audio ever leaves your network.

> **Status:** Active development. Open work lives in [TODO.md](./TODO.md); finished work is
> archived in [COMPLETED.md](./COMPLETED.md).

---

## What you can do by voice

Wake the device with its wake word (e.g. *"Okay Nabu"* on the Voice PE) or press its button, then
just speak naturally:

* **Control devices** — turn lights, plugs and other devices on/off, dim lights, set thermostat
  temperatures, in any room/zone.
* **Lock & unlock doors** — control supported smart locks.
* **Ask about the weather** — current conditions and forecasts for your location.
* **Ask the time & date** — answered from your Homey's local time and timezone.
* **Set timers & alarms** — *"set a 10 minute timer"*, *"wake me at 7"*. The device counts down on
  its LED ring and chimes when time's up; cancel or check it by voice.
* **Have a conversation** — the assistant keeps listening after it answers, so you can ask
  follow-up questions without repeating the wake word.
* **Ask anything** — general questions answered by the AI.
* **Search the web** — *"what's playing at the cinema today?"*, *"when does the next bus leave?"* —
  current and local information via OpenAI web search or the Brave Search API (pick one in settings).
* **Manage your Bring! shopping list** — *"what's on the shopping list?"*, *"add milk"*, *"take bread
  off the list"*. If you add something that's already there, the assistant asks whether to increase
  the amount or leave it. Opt-in — enable it and enter your Bring! account details in settings.
* **Play music** — *"play Abbey Road by the Beatles"*, *"play some Queen in the kitchen"*, *"next
  song"*, *"what's playing?"*. Works through a [Music Assistant](https://www.music-assistant.io/)
  server on your network, which brings your music providers (Spotify, Apple Music, local library,
  radio, …) and streams straight to the speakers. Opt-in — see
  [Playing music](#playing-music-music-assistant).
* **Ask for help** — *"what can you do?"* and the assistant explains its own capabilities.

The assistant understands and replies in **English, Dutch, German, French, Italian, Swedish,
Norwegian, Spanish, Danish, Russian, Polish and Korean** — pick yours in the app settings.

---

## Quick start

1. **Flash** your device with ESPHome firmware and get it on your Wi-Fi
   (see [Hardware setup](#hardware-setup) below).
2. **Install** this app on your Homey.
3. In the app settings, **choose an AI engine** and enter the matching API key
   (or point it at your local services — see [Choosing an AI engine](#choosing-an-ai-engine)).
4. **Add the device** in Homey — it's discovered automatically on your LAN.
5. **Say the wake word** and ask something — or test from a Flow with the
   *Ask the assistant* / *Say* cards.

---

## Hardware setup

The app talks to any supported device over your LAN using the ESPHome native API (port 6053) —
no Home Assistant installation is needed, and nothing extra runs on the device beyond its
standard ESPHome firmware.

> **Note:** the app connects to the ESPHome API in plaintext. If your device has an API
> **encryption key** configured (common when a device was previously adopted by Home Assistant),
> remove the key from its ESPHome config — encrypted connections are not supported yet.

### 1) Home Assistant Voice: Preview Edition (PE)

<img src="./drivers/home-assistant-voice-preview-edition/assets/images/large.png" height="160" alt="Voice PE" />

A ready-made voice satellite by Nabu Casa with a good microphone array, speaker, LED ring and
on-device wake word (default: *"Okay Nabu"*). **Firmware:** official ESPHome firmware — stock,
no modifications needed.

**How to flash / (re)install**

1. Use a Chromium-based browser (Chrome/Edge) that supports Web Serial.
2. Open the installer: [https://esphome.github.io/home-assistant-voice-pe/](https://esphome.github.io/home-assistant-voice-pe/)
3. Click **Connect**, choose the device's COM/USB port.
4. Pick a firmware version and click **Install**.
5. When prompted, enter your Wi-Fi credentials.
6. After boot, optionally assign a **static IP** in your router/DHCP.

**Tips**

* You can update/monitor later using the ESPHome Web tools.
* If the device doesn't appear for OTA updates, try power-cycling and ensure your network
  resolves the device hostname.

### 2) XiaoZhi AI devices (RealDeco firmware)

<img src="./drivers/xiaozhi-ai/assets/images/large.png" height="160" alt="XiaoZhi AI" />
<img src="./.resources/devices_1.jpg" height="160" alt="XiaoZhi AI device" />
<img src="./.resources/devices_2.jpg" height="160" alt="XiaoZhi AI device" />
<img src="./.resources/devices_3.png" height="160" alt="XiaoZhi AI device" />
<img src="./.resources/devices_4.png" height="160" alt="XiaoZhi AI device" />

Cheap and cheerful ESP32-S3 gadgets in many shapes (some with screens). They ship with
proprietary firmware, so they must be re-flashed. **Firmware:** community ESPHome configs by
RealDeco.

**How to flash**

1. Connect the XiaoZhi via USB.
2. Go to the RealDeco repo for your model: [https://github.com/RealDeco/xiaozhi-esphome](https://github.com/RealDeco/xiaozhi-esphome)
3. Use **ESPHome Web** ([https://web.esphome.io/](https://web.esphome.io/)) to do the first flash if needed.
4. In ESPHome, create or take over the device, paste the config from the repo, keep the
   **device name** unchanged, and install.
5. First-time install may require USB flashing to update partitions; later you can update OTA.

**Notes**

* Some models have different screens/touch options — use the matching YAML.
* If a device gets stuck after a wrong name/config, enter bootloader mode (usually
  holding/combining buttons) and re-flash over USB.

### 3) ThirdReality Voice & Music Assistant

<img src="./drivers/thirdreality-voice--music-assistant/assets/images/large.png" height="160" alt="ThirdReality Voice & Music Assistant" />

An open-source Linux-based smart speaker that speaks the same ESPHome native API as the Voice PE,
so it **works with this app out of the box — no flashing needed**. It has an LED ring, a Home
button, a hardware mic-mute switch, and on-device wake words (default *"Okay Nabu"*). It is also
a native **Music Assistant / Sendspin multi-room speaker**, which pairs nicely with the
[music feature](#playing-music-music-assistant) below. Technical deep-dive:
[docs/thirdreality-voice-and-music](./docs/thirdreality-voice-and-music/README.md).

---

## Choosing an AI engine

Select the **Voice provider** in the app settings. You only need credentials for the engine you
actually use.

### OpenAI Realtime (cloud)

One WebSocket session handles speech-to-text, reasoning and text-to-speech with very low
latency. Get an API key:

1. Sign in at [https://platform.openai.com/](https://platform.openai.com/)
2. Go to **API keys** and **Create new secret key**.
3. Paste it into the app settings in Homey (keep it secret).

A **Model quality** setting picks between **Full** (`gpt-realtime`, best quality) and **Mini**
(`gpt-realtime-mini`, a fraction of the cost and a bit faster). If your OpenAI quota runs low,
the app warns you with a Homey notification before requests start failing.

> If your OpenAI account is new, you may need to add billing to enable API usage.

### Google Gemini Live (cloud)

The same real-time pipeline, powered by Gemini. Get an API key:

1. Sign in at [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. **Create API key** and copy it.
3. Paste it into the app settings in Homey.

### Local / self-hosted (private)

Run the whole pipeline on your own hardware — speech never has to leave your LAN. The pipeline
has three stages, and **each stage is independently pluggable**, so you can mix and match (e.g.
local Whisper + cloud Mistral LLM + local Piper):

| Stage | Options |
|---|---|
| **Speech-to-text** | Whisper over HTTP (whisper-asr-webservice, speaches, whisper.cpp) · Wyoming faster-whisper (the Home Assistant `rhasspy/wyoming-whisper` docker) · Mistral Voxtral (cloud) · Mistral Voxtral **Realtime** (cloud, streaming websocket, sub-500 ms) · any OpenAI-compatible server |
| **Language model** | Ollama · LM Studio · Mistral (cloud) · any OpenAI-compatible server (Groq, OpenRouter, DeepSeek, llama.cpp, vLLM, …) |
| **Text-to-speech** | Piper over HTTP · Wyoming Piper (the `rhasspy/wyoming-piper` docker) · Mistral Voxtral (cloud) · any OpenAI-compatible server (e.g. kokoro-fastapi) |

Each stage has its own host/port (or URL/key/model) settings, and a **Test button** that runs a
real mini-request from your Homey — wrong ports, model names, keys and voices show up immediately
with the actual error and latency.

For Ollama there is also a **Context window (num_ctx)** setting (default 8192). Ollama's own
default window is too small for the assistant's instructions and tools, which makes small models
silently "forget" their rules — leave this at the default unless you know you want a different
trade-off between memory use and headroom (see [docs/cost-of-growth.md](./docs/cost-of-growth.md)).

Smart-home control, weather, timers and the rest of the tool set work the same on all three
engines.

---

## Playing music (Music Assistant)

The assistant can find and play music by voice — *"play Abbey Road by the Beatles"*, *"play some
Queen in the kitchen"*, *"pause"*, *"next song"*, *"what's playing?"*.

It works through [Music Assistant](https://www.music-assistant.io/) (MA), the open-source music
server: MA connects your music providers (Spotify, Apple Music, Tidal, YouTube Music, local
files, internet radio, …) and streams to your speakers. This app is only the **control plane** —
it searches MA and starts/steers playback, while the audio streams from the MA server **directly
to the speaker** (never through Homey or this app).

Setup:

1. Run a **Music Assistant server 2.7 or newer** on your network (Docker, or the Home Assistant
   add-on) and add your music providers in its web UI. A ready-to-run compose file with setup
   notes is in [docs/music-assistant](./docs/music-assistant/README.md).
2. Add your speakers to MA as **Sendspin players** — both the Voice PE (stock firmware) and the
   ThirdReality speaker have the Sendspin client built in, so MA discovers them on the LAN.
3. In this app's settings, enable **Music Assistant** and enter the server's address
   (default port 8095).

Notes:

* *"Play …"* targets the speaker you're talking to (matched automatically by IP/name/zone). Name
  another room to play elsewhere — **any** MA player works as a target (Sonos, AirPlay,
  Chromecast, …), not just the voice satellites.
* The queue lives in MA, so pause/next/previous also work on grouped/multi-room playback, and
  *"play music like X"* (radio mode) keeps the queue going with similar tracks.
* Voice keeps working while music plays: announcements and replies duck the music on the device.
* XiaoZhi devices have no Sendspin client, so they can't be music targets (controlling *other*
  players by voice from a XiaoZhi still works).

---

## App settings

<img src="./.resources/settings.jpg" height="500" alt="Settings" />

The settings page is organized by a **section dropdown** at the top: **General**, **Custom
pipeline** (only selectable while the Custom pipeline provider is active), and one section per
feature. A **token budget bar** stays visible at the bottom: every feature you enable adds
instructions and tools to every request the AI makes, and the bar shows the total — tap it for a
per-feature breakdown where you can flip features on and off directly. When the Custom pipeline
runs on Ollama, the bar also shows whether everything fits in the configured context window
(green/amber/red — red means the model will start "forgetting" its rules).

**General**

* **Language** — the language you'll speak with the assistant.
* **AI provider** — **OpenAI Realtime**, **Google Gemini Live**, or **Custom pipeline**.
* **API key** — for the selected cloud provider (OpenAI or Gemini).
* **Model quality** *(OpenAI only)* — **Full** for the best understanding, **Mini** for a much
  cheaper, slightly faster model.
* **Voice** — the voice the assistant speaks with. The list adapts to the selected provider
  (and, for the Custom pipeline, to the selected TTS backend).
* **Optional AI instructions** — personality or behaviour tweaks. Be careful: this **will**
  affect the AI (and counts toward the token budget). Write it in English.

**Features** — each has an on/off switch and shows its token cost. Disabled features aren't
loaded at all: no tools, no prompt text, no cost.

* **Smart home control** — always on; this is the base cost.
* **Weather** — current weather, forecast, rain and outside-light questions (on by default).
* **Timers & alarms** — countdown timers/alarms on devices whose firmware supports them
  (on by default).
* **Shopping list** *(opt-in)* — enter your Bring! account e-mail and password to let the
  assistant read and edit your shopping list. Optionally name a specific list (defaults to your
  account's default list). Note: the account must have an e-mail + password login — accounts
  created with "Sign in with Apple/Google/Facebook" have no password and can't be used until you
  set one in the Bring! app.
* **Music** *(opt-in)* — enter your Music Assistant server's address (default port 8095) to
  enable the music tools (see [Playing music](#playing-music-music-assistant)).
* **Web search** — **OpenAI web search** (uses your OpenAI key) or **Brave Search API** (its own
  free-tier key); switch the feature off to remove the tool entirely.

**Custom pipeline** *(Custom provider only)* — per-stage backend choice plus host/port or
URL/key/model for each, with Test buttons, and the Ollama context-window size (num_ctx).

Settings changes apply on the fly — no app restart needed.

**Per-device settings** (on the device in Homey): *Initial audio skip* and *Follow-up audio skip*
trim a few milliseconds from the start of each turn to swallow the wake-word sound / mic-open
noise, should you ever hear the assistant react to itself.

---

## Using it in Flows

### Device tile

Each voice device appears in Homey with on/off (session), **volume** and **mute** controls.
While a timer runs, the tile also shows the timer's **name** and **time remaining**, counting
down live.

### Flow cards

**Triggers (When…)**

* A timer is started / finished / cancelled
* Plus standard device triggers (turned on/off, volume changed)

**Conditions (And…)**

* Is muted
* A timer is / is not running
* Plus the standard "is turned on" condition

**Actions (Then…)**

* **Ask the assistant** a question — answer returned as **text** (a tag you can use later in the
  Flow)
* **Ask the assistant** a question — answer **spoken** on the device
* **Say** something — text-to-speech on the device speaker
* **Play an audio URL** on the device speaker (must be **.flac**)
* **Start a timer** / **Cancel the timer**
* Plus standard device actions (turn on/off, set volume, mute/unmute)

> Names may vary slightly as the app evolves — see the in-app Flow picker for the authoritative
> list.

---

## How it works

```
 ESP32 device  ── LAN (TCP :6053, ESPHome native API) ──  Homey app  ── cloud or LAN ──  AI engine
 mic · speaker                                            this app                       OpenAI / Gemini /
 wake word · LED ring                                                                    Whisper+Ollama+Piper
```

1. **Wake & stream.** The wake word is detected *on the device*. It then streams raw microphone
   audio (16 kHz PCM) to the Homey app over the ESPHome native API — the same LAN protocol Home
   Assistant uses, so stock firmware just works.
2. **Understand.** The app forwards the audio to the selected engine. Cloud engines (OpenAI /
   Gemini) do speech detection, transcription and reasoning in one real-time session; the local
   engine chains its own voice-activity detection → STT → LLM.
3. **Act.** The AI doesn't just chat — it gets a set of **tools**: query and control your Homey
   devices and zones, read the weather and local time, and manage timers. When you say *"turn off
   the kitchen lights"*, the model calls a tool and the app executes it through Homey's API.
4. **Reply.** The spoken answer is encoded to FLAC and served from a small HTTP server inside the
   app; the device fetches and plays it over the LAN. After answering, the mic reopens so you can
   ask a follow-up — the session ends when you stay silent.
5. **Timers** live in the app (not the device), so they survive brief disconnects; the device
   renders the countdown on its LED ring and chimes when a timer finishes.

Everything between the device and the app stays on your LAN. What leaves your network depends
entirely on the engine you pick — with the local pipeline, nothing does.

---

## Troubleshooting

* **Device not found during pairing:** make sure it's powered, on the same LAN/subnet as Homey,
  and has no ESPHome API **encryption key** set (see the note under Hardware setup).
* **No audio/response:** check the device volume and mute state, and confirm the selected
  engine's API key (or local service hosts) are set — use the settings page's **Test** buttons
  for the local pipeline.
* **The assistant reacts to its own wake word sound:** increase the device's *Initial audio
  skip* setting slightly.
* **Flashing/USB issues:** try another USB cable/port; if needed, enter bootloader mode and
  re-flash.
* **Device not updating OTA:** ensure it's online and reachable; verify hostname/DNS on your LAN.

---

## Privacy & security

* Your API keys stay in your Homey app settings; sensitive values are masked in the app logs.
* With a **cloud** engine, audio and text are sent to **OpenAI** or **Google** (or **Mistral**,
  if selected for a local-pipeline stage) to fulfil your requests. Don't use those engines if
  that's not acceptable for your environment.
* With a fully **local** pipeline, audio and text stay on your own network.

---

## Developing

Want to contribute or experiment? You can run the app **without Homey hardware** using the
built-in emulator:

```bash
npm install
npm run build      # compile TypeScript (.mts -> .homeybuild/)
npm test           # run the test suite (vitest)
npm run emulator   # run the app without a Homey
```

See [emulator/README.md](./emulator/README.md) for details. Running on real hardware uses the
Homey CLI (`homey app run --remote`). Architecture notes for contributors are in
[CLAUDE.md](./CLAUDE.md); protocol references live under
[docs/](./docs/home-assistant-voice-preview-edition/).

---

## Roadmap

Planned features and open tasks live in **[TODO.md](./TODO.md)** (with a release-testing
checklist at the top). Completed work — including detailed write-ups of past bugs and their
fixes — is archived in **[COMPLETED.md](./COMPLETED.md)**.

---

## Acknowledgements

* **ESPHome** and the Home Assistant community
* **RealDeco** for the XiaoZhi ESPHome configs
* Everyone experimenting with tiny ESP32 voice devices 💛
