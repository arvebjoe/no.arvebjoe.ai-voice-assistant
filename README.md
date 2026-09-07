# AI Voice Assistant for Homey

<img src="./assets/images/large.png" alt="App banner" />

Talk to your smart home. This Homey app connects small, inexpensive voice devices
(Home Assistant Voice Preview Edition, XiaoZhi AI, ThirdReality Voice & Music Assistant,
Seeed ReSpeaker XVF3800, M5Stack AtomS3R + Echo Base) to an AI assistant that controls your
Homey devices, answers questions, plays music, runs timers, and speaks back — in your language.

You choose the brain: **OpenAI**, **Google Gemini**, **Mistral** (Voxtral), or a **custom
pipeline** you assemble stage by stage — mix local Whisper/Ollama/Piper with cloud models like
**Claude**, right down to a fully local setup where no audio ever leaves your network.

> **Status:** Active development. Open work lives in [TODO.md](./TODO.md); finished work is
> archived in [COMPLETED.md](./COMPLETED.md).

---

## What you can do by voice

Wake the device with its wake word (e.g. *"Okay Nabu"* on the Voice PE) or press its button, then
just speak naturally:

* **Control devices** — turn lights, plugs and other devices on/off, dim lights, set thermostat
  temperatures, in any room/zone.
* **Open & close window coverings** — blinds, curtains and sunshades/awnings, either fully or to a
  position (*"close the blinds halfway"*). Devices that only support up/down/stop are driven that
  way instead. For an awning, *"open"* is understood as rolling it out to give shade.
* **Lock & unlock doors** — control supported smart locks. Locking always works; *unlocking* by
  voice is off by default (anyone within earshot can talk to the device) — enable *Allow unlocking
  by voice* in the app settings if you want it, and even then only one lock can be unlocked per
  command.
* **Ask about the weather** — current conditions and forecasts for your location.
* **Ask the time & date** — answered from your Homey's local time and timezone.
* **Set timers & alarms** — *"set a 10 minute timer"*, *"wake me at 7"*. The device counts down on
  its LED ring and chimes when time's up; cancel or check it by voice.
* **Have a conversation** — the assistant keeps listening after it answers, so you can ask
  follow-up questions without repeating the wake word.
* **Ask anything** — general questions answered by the AI.
* **Search the web** — *"what's playing at the cinema today?"*, *"when does the next bus leave?"* —
  current and local information via OpenAI web search or the Brave Search API (pick one in settings).
  It checks its own results and searches again if the first pass only found something vaguely related.
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

1. **Flash** your device with ESPHome firmware (see [Hardware setup](#hardware-setup) below —
   the ThirdReality needs no flashing at all).
2. **Install** this app on your Homey.
3. In the app settings, **choose an AI engine** and enter the matching API key
   (or point it at your local services — see [Choosing an AI engine](#choosing-an-ai-engine)).
4. **Add the device** in Homey — it's discovered automatically on your LAN. Not on Wi-Fi yet?
   Pick **Set up Wi-Fi via Bluetooth** in the pairing wizard and Homey will put it on your
   network (see [Bluetooth Wi-Fi setup](#getting-a-device-onto-wi-fi-bluetooth-setup)).
   Scan can't find a device that *is* on Wi-Fi? Use **Enter IP address manually**
   (see [Adding a device by IP address](#adding-a-device-by-ip-address-manual-entry)).
5. **Say the wake word** and ask something — or test from a Flow with the
   *Ask the assistant* / *Say* cards.

---

## Hardware setup

The app talks to any supported device over your LAN using the ESPHome native API (port 6053) —
no Home Assistant installation is needed, and nothing extra runs on the device beyond its
standard ESPHome firmware.

> **Note:** devices with an API **encryption key** configured (common when a device was
> previously adopted by Home Assistant) are supported: the network scan still finds them
> (marked *needs encryption key*) and the wizard forwards you to
> [manual IP entry](#adding-a-device-by-ip-address-manual-entry) with the address prefilled —
> just paste the key. The key can also be set later in the device's settings
> (**API encryption key**). Devices without a key connect in plaintext as before.

### Getting a device onto Wi-Fi (Bluetooth setup)

A brand-new (or factory-reset) **Voice PE** or **ThirdReality** device isn't on your network
yet, so LAN discovery can't find it. While unprovisioned, these devices advertise
**Improv Wi-Fi over Bluetooth** — and the pairing wizard in this app speaks it. Choose
**Set up Wi-Fi via Bluetooth** when adding a device: Homey finds it over Bluetooth, you enter
your Wi-Fi name and password, and the device joins your network. No Home Assistant, vendor
apps or USB cables needed.

* Place the device **near your Homey** during setup — it's Homey's own Bluetooth radio doing
  the talking, not your phone's.
* **2.4 GHz networks only** (that's all the devices' Wi-Fi supports).
* On the **Voice PE**, press the **center button** when the wizard asks — the device requires a
  physical touch to authorize Wi-Fi setup (the LED ring twinkles while Bluetooth setup is
  active).
* A device that is already connected to Wi-Fi switches its Bluetooth setup off — use the
  normal network search instead.

### Adding a device by IP address (manual entry)

The normal network search relies on **mDNS** (multicast) to discover devices. On some
setups that multicast never reaches the Homey — most commonly a **Wi-Fi-only Homey Pro**,
or a network where multicast isn't forwarded between the Homey and the device. The device
is fully reachable, but the scan finds nothing and ends with a timeout.

A second case: the scan works, but your device doesn't appear. To keep each driver's list
free of other people's hardware, the search only lists devices it can positively identify as
that model — and for the DIY-firmware devices below (M5Stack, ReSpeaker) the *only* thing
identifying the model is the device's own **name** / **friendly name** in its ESPHome config.
Rename one to something without a product word in it (say "Mikrofon Wohnzimmer") and the
search can no longer tell what it is. Manual entry doesn't have that problem: by typing the
address you've already said which model it is, so it accepts any renamed device that speaks
the voice-assistant API.

For these cases the pairing wizard offers **Enter IP address manually**. Type the device's
**IP address** (and port, default **6053**); the app connects straight to its ESPHome native
API, verifies it's a compatible voice device, and adds it — no discovery involved. If the
device is also visible over mDNS later, Homey still tracks its IP across DHCP changes, because
the manually-added device is keyed by the same MAC-based id discovery would have used.

> **Devices with an API encryption key** (`api: encryption: key:` in the ESPHome config —
> set automatically when a device is adopted by Home Assistant) refuse unencrypted
> connections, so their identity can't be verified during the scan. They still show up in
> the list marked **needs encryption key** — selecting one brings you to this manual-entry
> form with the address already filled in. Paste the **32-byte base64 key** from the
> device's ESPHome YAML (or the ESPHome dashboard) into the **API encryption key** field
> and the app connects encrypted (`Noise_NNpsk0_25519_ChaChaPoly_SHA256`). The key is
> saved with the device and can be changed later in its settings.

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
[music feature](#playing-music-music-assistant) below. Fresh out of the box it isn't on your
Wi-Fi yet — use the pairing wizard's
[Bluetooth Wi-Fi setup](#getting-a-device-onto-wi-fi-bluetooth-setup) to get it connected.
Technical deep-dive:
[docs/thirdreality-voice-and-music](./docs/thirdreality-voice-and-music/README.md).

### 4) Seeed ReSpeaker XVF3800 with XIAO ESP32S3

<img src="./drivers/respeaker-xvf3800/assets/images/large.png" height="160" alt="ReSpeaker XVF3800" />

A DIY satellite built around the **XMOS XVF3800** 4-microphone circular array — the same class of
hardware voice front-end as the Voice PE, doing echo cancellation, beamforming, noise suppression
and direction-of-arrival on-chip, with 360° pickup up to ~5 m. Sold by Seeed Studio
[with a case](https://www.seeedstudio.com/ReSpeaker-XVF3800-With-Case-XIAO-ESP32S3-p-6628.html)
or [as a bare board](https://www.seeedstudio.com/ReSpeaker-XVF3800-4-Mic-Array-With-XIAO-ESP32S3-p-6489.html).

This one is for tinkerers: **you compile and flash the ESPHome firmware yourself** over USB, using
the community configuration at
[formatBCE/Respeaker-XVF3800-ESPHome-integration](https://github.com/formatBCE/Respeaker-XVF3800-ESPHome-integration)
(that project is marked *"under development, use at your own risk"* and depends on a forked
`i2s_audio` component — worth knowing before you buy). Once flashed it behaves much like the
Voice PE: on-device wake words, LED ring, timers, and announcements over the ESPHome native API.

Notes specific to this device:

* Because the Wi-Fi credentials are baked in when you flash it, there is **no Bluetooth setup
  step** — pair it with *"Find it on my network"*, or enter its IP manually.
* It has **no buttons**, so the *button pressed* flow card never fires. Say *"stop"* to interrupt
  a reply (the firmware ships a "stop" wake word for exactly this).
* If you set an API encryption key in its YAML, enter the same key during pairing.

Technical deep-dive: [docs/respeaker-xvf3800](./docs/respeaker-xvf3800/README.md).

### 5) M5Stack AtomS3R + Atomic Echo Base

<img src="./drivers/m5stack-atoms3r/assets/images/large.png" height="160" alt="M5Stack AtomS3R + Echo Base" />

A tiny, affordable voice satellite: the [AtomS3R-AI Chatbot kit](https://docs.m5stack.com/en/core/AtomS3R-AI%20Chatbot)
combines an AtomS3R controller (ESP32-S3, with a small square LCD) and an Atomic Echo Base with
microphone and speaker. **Firmware:** M5Stack's own official ESPHome voice-assistant config —
[setup guide](https://docs.m5stack.com/en/homeassistant/voice_assistant/atoms3r_with_atomic_echo_base_voice_assistant),
[YAML](https://github.com/m5stack/esphome-yaml/blob/main/common/atoms3r-with-echo-base.yaml).
On-device wake words (*"Okay Nabu"*, *"Hey Jarvis"*, *"Hey Mycroft"*), timers, and the little
screen shows what the assistant is doing.

> **Important:** the firmware the kit ships with (the "AI Chatbot" cloud firmware) is **not**
> ESPHome and will not work with this app. Flash M5Stack's ESPHome config once over USB (see
> their setup guide) — if you previously used the device with Home Assistant's voice assistant,
> it is already running the right firmware.

Notes specific to this device:

* Wi-Fi credentials are baked in when you flash, so there is **no Bluetooth setup step** — pair
  with *"Find it on my network"*, or enter its IP manually.
* In the device's ESPHome settings, keep the **wake word engine** set to **"On device"** (the
  default) — the *"In Home Assistant"* mode streams to an Assist pipeline instead of the API
  this app uses.
* The button behind the screen only stops a ringing timer; it is not exposed to Homey, so the
  *button pressed* flow card never fires for this device.
* Devices previously adopted by Home Assistant usually have an **API encryption key** — paste it
  during pairing as usual.

Technical deep-dive: [docs/m5stack-atoms3r](./docs/m5stack-atoms3r/README.md).

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

### Mistral (Voxtral, cloud)

The European alternative, everything on one Mistral account and one API key. Mistral has no
single speech-to-speech API; this engine chains Mistral's own realtime pieces the way their
voice-agent reference design does: **Voxtral Realtime** speech-to-text (a streaming websocket
that transcribes *while you talk*, sub-500 ms), a **Mistral chat model** for the reasoning and
smart-home tools (default `mistral-small-latest`, configurable), and **Voxtral TTS** for the
reply, with a live voice library to pick from. Get an API key:

1. Sign in at [https://console.mistral.ai/](https://console.mistral.ai/)
2. Create an API key and copy it.
3. Paste it into the app settings in Homey.

The same Mistral key and models also serve the Custom pipeline's Mistral backends, so you can
later switch to mix-and-match (e.g. Voxtral speech-to-text with a local Ollama model) without
reconfiguring anything.

### Local / self-hosted (private)

Run the whole pipeline on your own hardware — speech never has to leave your LAN. The pipeline
has three stages, and **each stage is independently pluggable**, so you can mix and match (e.g.
local Whisper + cloud Mistral LLM + local Piper):

| Stage | Options |
|---|---|
| **Speech-to-text** | Whisper over HTTP (whisper-asr-webservice, speaches, whisper.cpp) · Wyoming faster-whisper (the Home Assistant `rhasspy/wyoming-whisper` docker) · Mistral Voxtral (cloud) · Mistral Voxtral **Realtime** (cloud, streaming websocket, sub-500 ms) · any OpenAI-compatible server |
| **Language model** | Ollama · LM Studio · Mistral (cloud) · **Claude / Anthropic (cloud)** · any OpenAI-compatible server (Groq, OpenRouter, DeepSeek, llama.cpp, vLLM, …) · **None** (hand the transcript to a Flow) |
| **Text-to-speech** | Piper over HTTP · Wyoming Piper (the `rhasspy/wyoming-piper` docker) · Mistral Voxtral (cloud) · any OpenAI-compatible server (e.g. kokoro-fastapi) · **None** (no speech) |

Each stage has its own host/port (or URL/key/model) settings, and a **Test button** that runs a
real mini-request from your Homey — wrong ports, model names, keys and voices show up immediately
with the actual error and latency.

The **OpenAI-compatible** backend has a **Server** dropdown so you don't have to remember any
URLs: pick *OpenAI* (or *Groq*, *OpenRouter*, *DeepSeek* on the language-model stage) and the base
URL and a known-good model are filled in for you — all that's left is the API key, with a link to
where you get one. Pick **Custom / self-hosted** instead and the URL field appears, for your own
LM Studio, llama.cpp, vLLM, speaches or kokoro-fastapi. If you already use the *OpenAI Realtime*
engine, a **Use my OpenAI key from General** button copies that key across, so you only type it
once. A stage pointed at a cloud service with no key reports itself as unconfigured up front
rather than failing mid-sentence.

If the OpenAI-compatible **speech-to-text** stage keeps hearing the wrong language — a two-word
command like *"skru av lyset"* coming back as Danish or English — open **Advanced: transcription
hints** under the model field. The language you picked in General is always sent, but on the
one-second clips a satellite records it is only a hint; these two fields are the documented fix:

* **Context** — one sentence about what the microphone hears, e.g. *"Short Norwegian smart-home
  commands."*
* **Expected words** — comma-separated names it keeps mishearing: your rooms, devices, people.

On OpenAI the Server preset picks `whisper-1` for exactly this reason — it holds the chosen
language far more strictly than the `gpt-…-transcribe` models. (Expected words are sent as
the API's `keywords` on the `gpt-…-transcribe` models, which have that field, and appended to the
context on `whisper-1` and other servers, which is how those take spellings — either way you just
type the names.)

> **Setup recipes:** [docs/custom-pipeline-setup-guide.md](./docs/custom-pipeline-setup-guide.md)
> has a copy-paste Docker Compose for every backend of every stage (Whisper, Wyoming,
> Voxtral, OpenAI-compatible for STT · Ollama, LM Studio, Jan, llama.cpp, vLLM, Mistral, Claude
> for the LLM · Piper, Wyoming Piper, Kokoro, Voxtral for TTS), plus the desktop-app steps for
> Ollama and LM Studio and the networking gotchas.

For Ollama there is also a **Context window (num_ctx)** setting (default 8192). Ollama's own
default window is too small for the assistant's instructions and tools, which makes small models
silently "forget" their rules — leave this at the default unless you know you want a different
trade-off between memory use and headroom (see [docs/cost-of-growth.md](./docs/cost-of-growth.md)).
LM Studio has no such setting here — its context window is chosen in LM Studio when you load the
model, and the app reads it back live so the token budget bar can tell you whether everything fits.

**Claude** as the language model needs an Anthropic API key from
[https://console.anthropic.com/](https://console.anthropic.com/). Paste it in and the **Model**
dropdown fills itself with the models your account can actually use — no model ids to type or
keep up with. The default is `claude-opus-5`; `claude-haiku-4-5` is the fastest and cheapest,
which suits short spoken commands, and `claude-sonnet-5` sits in between. Only the text of the
conversation is sent to Anthropic — pair it with a local Whisper and a local Piper and the audio
still never leaves your LAN.

Smart-home control, weather, timers and the rest of the tool set work the same on every
engine.

#### Switching a stage off: "None"

The language-model and speech stages can also be set to **None**, which turns them off instead
of pointing them at a backend. Two setups this makes possible:

- **Your own assistant, my ears** — set the **LLM backend** to *None*. The turn stops after
  speech-to-text: what you said goes out on the **Heard something** Flow trigger and your own
  Flow decides what happens next. It can speak an answer back with the **Say** action card,
  which still uses the speech backend below. Useful if you already run your own agent, LLM
  orchestration or MCP setup and only want the satellite's microphone. The trade-off is real:
  follow-up questions and every built-in skill (device control, weather, timers, shopping list,
  music) are gone — the Flow is the assistant now — and the round trip through Flow adds
  latency on top of whatever your own chain costs.
- **Answers spoken somewhere else** — set the **TTS backend** to *None*. The model still
  answers, but the reply only leaves as text on the **Assistant is thinking** trigger (filter
  on `type = reply`), so a Flow can speak it on another speaker — a Sonos, for example. With no
  speech backend the app cannot produce audio at all, so the **Say** card stops working too.

If you want your own model *and* everything else to keep working, the better route is usually
not *None* but the **OpenAI-compatible** LLM backend pointed at your own endpoint: your model
answers, while the LED ring, streaming speech, follow-up questions and the built-in tools all
stay.

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
   (default port 8095). On **Music Assistant 2.9 or newer** also paste an **API token**:
   in the MA web UI, open your profile and create a *long-lived token* (older MA servers
   need no token — leave the field empty).

Notes:

* *"Play …"* targets the speaker you're talking to (matched automatically). Name another room
  to play elsewhere — **any** MA player works as a target (Sonos, AirPlay, Chromecast, …), not
  just the voice satellites. Tip: rename players in MA to short, speakable names ("Kitchen",
  "Office") — the voice targeting matches whatever name MA reports.
* Starting a brand-new artist/album can take MA ~30 seconds the first time (it resolves the
  tracks from your music provider before answering) — the assistant replies once it's queued.
* The queue lives in MA, so pause/next/previous also work on grouped/multi-room playback, and
  *"play music like X"* (radio mode) keeps the queue going with similar tracks.
* Voice keeps working while music plays: announcements and replies duck the music on the device.
* XiaoZhi and M5Stack AtomS3R devices have no Sendspin client, so they can't be music targets
  (controlling *other* players by voice from them still works).

---

## App settings

<p>
<img src="./.resources/settings_general.png" height="440" alt="General settings" />
<img src="./.resources/settings_smart_home.png" height="440" alt="Smart home control settings" />
<img src="./.resources/settings_weather.png" height="440" alt="Weather feature settings" />
<img src="./.resources/settings_web_search.png" height="440" alt="Web search feature settings" />
<img src="./.resources/settings_music.png" height="440" alt="Music feature settings" />
<img src="./.resources/settings_custom_pipeline.png" height="440" alt="Custom pipeline settings" />
<img src="./.resources/settings_logging.png" height="440" alt="Debug settings" />
</p>

The settings page is organized by a **section dropdown** at the top: **General**, **Custom
pipeline** (only selectable while the Custom pipeline provider is active), and one section per
feature. A **token budget bar** stays visible at the bottom: every feature you enable adds
instructions and tools to every request the AI makes, and the bar shows the total — tap it for a
per-feature breakdown where you can flip features on and off directly. When the Custom pipeline
runs on Ollama or LM Studio, the bar also shows whether everything fits in the context window
(green/amber/red — red means the model will start "forgetting" its rules). For Ollama the window
is the num_ctx setting; for LM Studio it's read live from the LM Studio server (the context
length you configured when loading the model).

**General**

* **Language** — the language you'll speak with the assistant.
* **AI provider** — **OpenAI Realtime**, **Google Gemini Live**, **Mistral (Voxtral)**, or
  **Custom pipeline**.
* **API key** — for the selected cloud provider (OpenAI, Gemini or Mistral).
* **Model quality** *(OpenAI only)* — **Full** for the best understanding, **Mini** for a much
  cheaper, slightly faster model.
* **Advanced: speech detection tuning** *(OpenAI only, collapsed by default)* — two optional
  knobs for the server-side voice detection. **Speech detection sensitivity**: raise it if a TV
  or background noise keeps triggering the assistant, lower it if it misses quiet or distant
  speakers. **Silence before reply**: raise it if the assistant cuts you off mid-sentence, lower
  it for snappier replies. Leave both empty for the defaults.
* **Voice** — the voice the assistant speaks with. The list adapts to the selected provider
  (and, for the Custom pipeline, to the selected TTS backend).
* **Optional AI instructions** — personality or behaviour tweaks. Be careful: this **will**
  affect the AI (and counts toward the token budget). Write it in English.

With the **Custom pipeline** provider the last two move to the *Custom pipeline* section, next to
the stage they belong to: **AI instructions** under the language model, **Voice** under the
text-to-speech backend. A stage set to **None** hides its setting — no model, nothing to instruct;
no speech, no voice.

**Features** — each has an on/off switch and shows its token cost. Disabled features aren't
loaded at all: no tools, no prompt text, no cost.

* **Smart home control** — always on; this is the base cost. Includes two switches:
  **Look in other zones when this one has none** (on by default) — if you ask for something the
  voice device's own zone does not have, the assistant uses the matching devices in the *only*
  other zone that has them, and says which zone that was; when several zones have such devices it
  still asks you to say *"everywhere"*. And **Allow unlocking by voice** (off by default): until
  you enable it, the assistant will lock doors but refuse to unlock them.
* **Weather** — current weather, forecast, rain and outside-light questions (on by default).
* **Timers & alarms** — countdown timers/alarms on devices whose firmware supports them
  (on by default).
* **Shopping list** *(opt-in)* — enter your Bring! account e-mail and password to let the
  assistant read and edit your shopping list. Optionally name a specific list (defaults to your
  account's default list). Note: the account must have an e-mail + password login — accounts
  created with "Sign in with Apple/Google/Facebook" have no password and can't be used until you
  set one in the Bring! app.
* **Music** *(opt-in)* — enter your Music Assistant server's address (default port 8095; MA 2.9+
  also needs a long-lived API token from the MA web UI) to enable the music tools (see
  [Playing music](#playing-music-music-assistant)).
* **Web search** — **OpenAI web search** (uses your OpenAI key) or **Brave Search API** (its own
  free-tier key); switch the feature off to remove the tool entirely. On the OpenAI backend,
  **Search attempts** (default 2) controls how hard it digs. The search model rates its own answer,
  and if it only found something vaguely related it searches again with a better query instead of
  reading out a near-miss; when the attempts run out it says it could not find it, or asks you to
  narrow the question down. Every question gets the same thorough first search, so extra attempts
  only cost time on the questions that actually needed them. Searches take a while, so the assistant
  says something like *"let me look that up"* while it works instead of going silent.

**Custom pipeline** *(Custom provider only)* — per-stage backend choice plus host/port or
URL/key/model for each, with Test buttons, the Ollama context-window size (num_ctx) and, on the
OpenAI-compatible speech-to-text stage, **Advanced: transcription hints** (context sentence +
expected words) for when short commands come back in the wrong language. The
**AI instructions** box sits with the language model and the **Voice** dropdown with the
text-to-speech backend, since that is the stage each one actually configures. The
language-model and speech stages can also be set to **None** to switch them off — see
[Switching a stage off](#switching-a-stage-off-none).

**Debug** — four tools for working out what is going wrong, none of which cost the AI anything.

* **Last seen devices** — every ESPHome device Homey's discovery has announced, recorded all the
  time (not just while you pair), with the exact fields pairing matches on: the name it would be
  listed under, `friendly_name`, the mDNS service name and host, address and port, `mac`,
  `platform`, the ESPHome version and project, and whether the device has an API encryption key.
  A **★** marks devices that answered the probe and can serve as a voice satellite; 🔒 means it
  needs an encryption key, ✕ that it answered but isn't a satellite, ⚠ that it didn't answer, and
  **?** that it hasn't been probed yet. **Probe** re-checks a device on the spot. For a device you
  have already paired it also shows **Device connected** and **Engine connected** separately — a
  satellite that is reachable while the AI engine is not is by far the commonest cause of an
  unavailable tile, and those two rows tell them apart. If a device you own never shows up in this
  list at all, the problem is mDNS on your network, not the pairing dialog.
* **What did I just say?** *(opt-in, off by default)* — keeps the raw microphone audio of each
  turn for 5 minutes to an hour (your choice; the last 20 recordings are kept and they're deleted
  automatically). Press **Play** next to any recording in the list and it plays back on the
  device — each one shows what speech recognition made of it. This is how you tell a microphone
  problem (muffled, clipped, too quiet)
  from a speech-recognition problem (the audio is clear but the transcript is wrong). While it is
  on, recent microphone audio is reachable on your local network like every other clip the device
  plays, so leave it off when you're not debugging.
* **Dump log** — the button to use when **reporting a problem**. It writes the app's last few
  thousand log lines — including the detailed satellite-connection and AI-engine lines, whether or
  not verbose logging is on — to a text file on your Homey and shows a link to it. Open the link
  from a phone or computer on the same network and attach the file to your forum post, e-mail or
  GitHub issue (a **Copy log to clipboard** button is there too). The file starts with a summary —
  app and Homey versions, the engine and pipeline stages you selected, and one line per paired
  satellite (model, address, firmware, whether it and the engine are connected) — so you don't have
  to describe your setup separately. API keys and everything that was
  said (your questions, the assistant's answers) are removed before the file is written, and your
  home coordinates are rounded to about 10 km; local network addresses are kept because they help
  you see which device the app can't reach. The file
  is deleted after 30 minutes. This beats Homey's own *Create Diagnostics Report*, which only
  carries the last few lines and must be created right after the failure — if you do use that
  one, use the report button on the **app's own page** (Homey app → **More** → **Apps** → *AI
  Voice Assistant*), not the one under General settings, which goes to Athom.
* **Remote logging** — stream the app's logs to any **syslog** server (RFC 5424 over UDP or TCP):
  rsyslog/syslog-ng, a Synology or QNAP log center, Grafana Alloy/Loki, Papertrail, and so on.
  Enter the server's address and port (default 514), pick UDP or TCP, and choose a level:
  conversation events are logged at **INFO**, while the detailed per-subsystem logs (ESP
  connection, AI provider, tools, webserver, …) — which are normally not written to the app's own
  log at all — go out at **DEBUG**, so a collector can capture everything without making the
  in-app log noisy. Warnings and errors are always included, every line is tagged with its
  subsystem name for filtering, and secret-looking values are masked before they leave the app.
  A **Send test message** button verifies the address before you save. Don't have a syslog
  server? [docs/remote-logging.md](docs/remote-logging.md) has a one-command Docker Compose
  setup (VictoriaLogs, free and open source, with a web UI) plus ready-made queries.
* **Verbose logging** *(opt-in, off by default)* — the same detailed per-subsystem logs, written
  straight to the app's own log instead of to a syslog server. Without it the app log shows only
  conversation events, so a log you send in can't say whether the satellite and the AI engine
  actually connected — the lines that would answer that are the ones being held back. Useful when
  you want to follow along live in the app log; for sending a log in, use **Dump log** above
  instead (it always contains these lines). Leave it off the rest of the time: it's a lot of text,
  and it makes the log harder to read rather than easier.

Settings changes apply on the fly — no app restart needed.

**Per-device settings** (on the device in Homey): *Initial audio skip* and *Follow-up audio skip*
trim a few milliseconds from the start of each turn to swallow the wake-word sound / mic-open
noise, should you ever hear the assistant react to itself. *Microphone gain* boosts the
microphone audio in software before speech recognition — 0 means automatic (each device model's
tuned default; the ThirdReality's quiet mic gets 4×, the Voice PE, ReSpeaker and AtomS3R need none). Raise it if the
assistant doesn't hear you from a distance; lower it if loud close-up speech gets misheard.
*Reply audio* chooses whether the answer is spoken by the device itself or handed to a Flow — see
below.

### Playing the reply on another speaker

Some voice devices have no speaker at all (a bare ReSpeaker board, an AtomS3R without its Echo
Base), and sometimes there is simply a better speaker in the room. Set the device's **Reply audio**
setting to **Send to a Flow as a URL** and the assistant will not speak on the device. Instead it
fires the **Reply audio is ready** Flow trigger with a **url** tag pointing at the rendered answer,
which you can hand to anything that plays a URL — the Sonos app's *Play a URL* action, for
instance. You still get the app's own voice and language, unlike piping the **text** tag to a
speaker's own text-to-speech.

Worth knowing before you switch it on:

* The audio is MP3, 48 kHz mono, served from Homey on your LAN — MP3 because that is the one
  format every networked speaker plays. The link is valid for about two minutes — play it straight
  away rather than storing it.
* **The app's own sound effects come through the same trigger** — the "speak now" cue when a turn
  starts, the "something went wrong" clip, "no API key is configured", and the greeting the device
  plays the first time it connects after pairing. On a device with no speaker they would otherwise
  be silent. The **is a sound effect** tag is `yes` for these and `no` for a spoken answer, so a
  Flow can treat them differently — play the cue at a lower volume, or ignore them entirely with a
  condition card. Their **text** tag is a short label of what happened rather than the reply text,
  and their link does not expire.
* The reply is not sent until it is **fully generated**, so a long answer starts later than it
  would on the device's own speaker.
* **Follow-up questions need the wake word again.** Normally the device reopens its microphone
  when a reply ends in a question, but it has no way to know when another speaker finished
  talking — reopening on time would just let it hear itself.

---

## Using it in Flows

### Device tile

Each voice device appears in Homey with a **Start conversation** toggle, **volume** and **mute**
controls. While a timer runs, the tile also shows the timer's **name** and **time remaining**,
counting down live.

**Start conversation is not a power switch** — the satellite has no software power state. Switch
it *on* and the device chimes and opens its microphone, so you can speak without saying the wake
word. Switch it *off* to cancel a conversation that is already running. It also reflects status:
it turns itself on whenever the assistant wakes and off again when the turn ends.

### Flow cards

**Triggers (When…)**

* A timer is started / finished / cancelled
* **Heard something** — speech-to-text finished; the transcript is available as a **text** tag.
  Great for debugging: pipe it to the timeline or a logger to see exactly what the assistant heard
* **Thinking** — the assistant produced a reply or used a tool ("Using tool get_devices"); the
  message is a **text** tag and a **type** tag says whether it was a `tool` call or the final
  `reply`. Combine with *Heard something* to follow a whole conversation on the timeline
* **Reply audio is ready** — the spoken reply has been rendered to a file, with **url**, **text**,
  **duration** and **is a sound effect** tags. Also fires for the app's own sound effects (the wake
  cue, an error, a missing API key, the post-pairing greeting), which is what that last tag is for.
  Only fires on devices whose *Reply audio* setting is set to send the
  reply to a Flow (see [Playing the reply on another speaker](#playing-the-reply-on-another-speaker))
* Plus standard device triggers (*Start conversation* turned on/off — i.e. a conversation
  started or ended — and volume changed)

**Conditions (And…)**

* Is muted
* A timer is / is not running
* Plus the standard "is turned on" condition (true while a conversation is running)

**Actions (Then…)**

* **Ask the assistant** a question — answer returned as **text** (a tag you can use later in the
  Flow)
* **Ask the assistant** a question — answer **spoken** on the device
* **Say** something — text-to-speech on the device speaker
* **Play an audio URL** on the device speaker (must be **.flac**)
* **Start a timer** / **Cancel the timer**
* Plus standard device actions (*Start conversation* on = open the mic without the wake word,
  off = cancel the running conversation; set volume; mute/unmute)

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
2. **Understand.** The app forwards the audio to the selected engine. OpenAI and Gemini do
   speech detection, transcription and reasoning in one real-time session; the Mistral and
   Custom pipeline engines run voice-activity detection in the app and chain STT → LLM
   (Mistral's Voxtral Realtime STT transcribes over a streaming websocket while you talk).
3. **Act.** The AI doesn't just chat — it gets a set of **tools**: query and control your Homey
   devices and zones, read the weather and local time, and manage timers. When you say *"turn off
   the kitchen lights"*, the model calls a tool and the app executes it through Homey's API.
4. **Reply.** The spoken answer is encoded to FLAC and served from a small HTTP server inside the
   app; the device fetches and plays it over the LAN. After answering a question with a question,
   the device plays a short rising chime and reopens the mic so you can ask a follow-up — the
   chime is your cue to speak. If you stay silent (about 10 seconds), the session ends and the
   device plays the same chime descending — your cue that the mic has closed.
5. **Timers** live in the app (not the device), so they survive brief disconnects; the device
   renders the countdown on its LED ring and chimes when a timer finishes.

Everything between the device and the app stays on your LAN. What leaves your network depends
entirely on the engine you pick — with the local pipeline, nothing does.

---

## Troubleshooting

* **Device not found during pairing:** make sure it's powered and on the same LAN/subnet as
  Homey. A device with an ESPHome API **encryption key** set shows up marked
  **needs encryption key** and forwards to manual entry for the key when selected; if it
  doesn't appear at all, add it via **Enter IP address manually** and paste the key there
  (see [Adding a device by IP address](#adding-a-device-by-ip-address-manual-entry)).
  Settings → **Debug** → **Last seen devices** shows everything discovery has found, so you can
  tell "Homey never saw it" (a network/mDNS problem) from "Homey saw it but it isn't a
  satellite" (the probe result is right there).
* **Pairing finds the device but always times out on it:** update the app — older versions asked
  the device for its wake-word configuration during the pairing probe, which crashes and reboots
  the device on **ESPHome 2025.8 through 2026.5**, so it went silent mid-handshake. Updating the app
  is enough to pair. Note that the ESPHome version is *not* the same number as your device's
  firmware version — a Voice PE on firmware 26.4.0 reports ESPHome 2026.3.2, and 25.12.4 reports
  2025.12.2 (both affected), while firmware 26.6.0 reports 2026.6.2 (fixed upstream). Settings →
  **Debug** → **Last seen devices** shows the actual ESPHome version. Updating the device firmware
  past the affected range is worth doing anyway, since any other tool that asks the same question
  will still reboot it.
* **Scan times out even though the device is reachable:** discovery uses mDNS/multicast, which
  doesn't always reach the Homey (e.g. a Wi-Fi-only Homey Pro, or multicast not forwarded on
  your network). Use **Enter IP address manually** in the pairing wizard to add it directly by
  IP (see [Adding a device by IP address](#adding-a-device-by-ip-address-manual-entry)).
* **Bluetooth Wi-Fi setup finds nothing:** the device only advertises while it is *not*
  connected to Wi-Fi — and it must be within Bluetooth range of your **Homey** (not your
  phone). Power-cycle the device, move it next to Homey and scan again. If another app
  (e.g. Home Assistant) is mid-setup with the device, close that first.
* **Bluetooth setup says the device could not join the network:** double-check the password,
  and remember these devices only support **2.4 GHz** networks — a 5 GHz-only SSID won't work.
* **No audio/response:** check the device volume and mute state, and confirm the selected
  engine's API key (or local service hosts) are set — use the settings page's **Test** buttons
  for the local pipeline.
* **The ring lights up, but nothing is ever answered — or "Say" plays no sound (OpenAI):** your
  OpenAI *project* may not be allowed to use one of the models the app needs. Model access is a
  per-project setting on OpenAI's side, and a project can have the realtime model while being
  refused the speech-recognition model (`gpt-4o-transcribe`) or the speech-output model
  (`gpt-4o-mini-tts`). The app falls back to another model automatically and sends a Homey
  notification naming the refused one; to get the best quality back, allow the model at
  platform.openai.com → **Settings → Project → Limits → Model usage** (or set the project to
  allow all models).
* **The tile says the device is unavailable:** that needs *two* links to be up — the satellite and
  the AI engine. The tile now names whichever one is down, so read it first: if it blames the
  engine, the cause is almost always that engine's API key being missing or wrong, which leaves the
  satellite perfectly healthy and the tile unavailable anyway. Settings → **Debug** → **Last seen
  devices** shows the same split as **Device connected** / **Engine connected**. If you need more
  than that, turn on Settings → **Debug** → **Verbose logging** and restart the app.
* **The device answers you — but with the wrong answers, and Homey never notices:** the satellite
  is still added to **Home Assistant**. An ESPHome device hands its voice assistant to exactly one
  client, first come first served, and silently ignores the second — so Home Assistant answers
  everything (including *"Sorry, I couldn't find a device called ..."* for devices that exist in
  Homey), while this app sits there connected and deaf. Tell-tale signs: the *Heard something* and
  *Thinking* Flow cards never fire, and pressing the device tile in Homey does nothing. Fix it by
  removing the device from Home Assistant — delete the whole ESPHome config entry, since hiding the
  entities isn't enough and the integration will just reconnect — then restart the device in Homey.
  When the app can prove this is happening (it asked the device to listen and got no reply) it puts
  a warning on the device, a notification in your Homey timeline, and says so out loud on the
  device itself.
* **The assistant reacts to its own wake word sound:** increase the device's *Initial audio
  skip* setting slightly.
* **The device wakes but doesn't hear what you say (or only up close):** raise the device's
  *Microphone gain* setting; if loud close-up speech gets misheard instead, lower it.
* **The assistant keeps misunderstanding you:** turn on Settings → **Debug** → **What did I just
  say?**, talk to it again, then play the recording from that same page. Hearing the actual
  recording tells you whether the microphone or the speech recognition is at fault.
* **Flashing/USB issues:** try another USB cable/port; if needed, enter bootloader mode and
  re-flash.
* **Device not updating OTA:** ensure it's online and reachable; verify hostname/DNS on your LAN.

---

## Privacy & security

* Your API keys stay in your Homey app settings; sensitive values are masked in the app logs.
* With a **cloud** engine, audio and text are sent to **OpenAI**, **Google**, **Mistral** or
  **Anthropic** (whichever you selected — as the provider or for a Custom pipeline stage) to
  fulfil your requests. Don't use those engines if that's not acceptable for your environment.
  Anthropic's Claude is a Custom-pipeline language-model backend only, so it receives the text
  of the conversation but never the audio.
* With a fully **local** pipeline, audio and text stay on your own network.
* **Smart locks:** unlocking by voice is disabled by default (enable *Allow unlocking by voice*
  in settings to allow it), and the app never unlocks more than one lock per command — a voice
  request (or a malicious phrase smuggled into web content) can't open every door at once.

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
* **M5Stack** for their official ESPHome voice-assistant configs
* Everyone experimenting with tiny ESP32 voice devices 💛

---

## License & third-party software

This app is released under the **GNU General Public License v3.0** — see [LICENSE](./LICENSE).

It bundles the following third-party libraries, each under its own license:

| Library | License | Used for |
| --- | --- | --- |
| [`@breezystack/lamejs`](https://github.com/breezystack/lamejs) | LGPL-3.0 | MP3 encoding of reply audio and sound effects |
| [`libflacjs`](https://github.com/mmig/libflac.js) | MIT | FLAC encoding/decoding for the satellites |
| [`protobufjs`](https://github.com/protobufjs/protobuf.js) | BSD-3-Clause | ESPHome native API messages |
| [`@google/genai`](https://github.com/googleapis/js-genai) | Apache-2.0 | Gemini Live provider |
| [`ws`](https://github.com/websockets/ws), [`uuid`](https://github.com/uuidjs/uuid), [`varint`](https://github.com/chrisdickinson/varint) | MIT | WebSockets, ids, varint framing |
| [`homey-api`](https://www.npmjs.com/package/homey-api), [`homey-lib`](https://www.npmjs.com/package/homey-lib), [`homey-log`](https://www.npmjs.com/package/homey-log) | Athom | Homey platform SDK |

`@breezystack/lamejs` is a JavaScript port of the **LAME MP3 encoder**
(<https://lame.sourceforge.io/>) and is covered by the LGPL. It is used unmodified, as a separate
package under `node_modules/`, and its license text ships with it. LGPL-3.0 is compatible with
this app's GPL-3.0 license; if you modify the library itself, those changes must be released
under the LGPL.
