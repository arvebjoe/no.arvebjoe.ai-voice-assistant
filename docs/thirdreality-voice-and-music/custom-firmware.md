# Custom firmware for the ThirdReality Voice & Music Assistant (TR)

Research notes, 2026-07-28. Goal: (1) a **"Hey Homey" wake word** on the TR, (2) **control of the
device's LED** from this app. Everything below is verified against the firmware source at
[thirdreality/voice-music-assistant](https://github.com/thirdreality/voice-music-assistant)
(branch `linux-voice-assistant`, Apache-2.0) — file paths are given for every claim. Hardware and
protocol background: [`README.md`](./README.md) in this folder.

## TL;DR

| Goal | Cheapest working route | Firmware rebuild needed? |
|---|---|---|
| "Hey Homey" wake word | Train a **microWakeWord** model, push it to the device as an **external wake word over the native API** (the same mechanism Home Assistant uses), activate with the existing `wake_word` device setting | **No** — one proto field + ~80 lines in our app |
| LED control | Add a **Light entity** to `linux-voice-assistant-cpp` and drive it with `LightCommandRequest` | **Yes** (or SSH/ADB hacks, see below) |

The wake word is a solved problem that needs no custom firmware at all. The LED genuinely does need
a firmware patch if we want to drive it over the LAN from Homey — the LED is not exposed on the
ESPHome native API in any form today.

---

# Part 0 — Building custom firmware at all

Only needed for the LED work (Part 2, route C) and for the optional "bake it in" variants.

- **Source:** `git clone https://github.com/thirdreality/voice-music-assistant.git`,
  `git checkout linux-voice-assistant`, `git submodule update --init`.
- **Build (Docker, recommended — no host deps beyond Docker):**
  - full image: `./go --docker trspk <version>`
  - single package: `./go --docker trspk rebuild linux-voice-assistant-cpp`
  - interactive shell: `./go --docker-shell`
- **Native build:** Ubuntu 20.04 only (Buildroot toolchain, i386 multilib deps). Docker is less pain.
- **Output:** `image/*.img`.
- **Flash:** Windows-only **Amlogic Burn Tool** (`tools/Aml_Burn_Tool.zip` → install
  `Setup_Aml_Burn_Tool_V3.1.0.exe`, then `v2/Aml_Burn_Tool.exe`), over the USB-C **data** cable or
  the Debug-edition board. Full reflash — the device gets wiped.
- **Much faster inner loop (what you actually want):** the rootfs is an **overlayfs**
  (`lowerdir=/rom`, writable upperdir on the persistent `/data` partition) — stated explicitly in
  `src/audio/ExternalWakeWord.h`. So you can `scp` a rebuilt `/usr/bin/linux-voice-assistant-cpp`
  (or a wake-word model, or an edited `/etc/init.d/S99ha-speaker`) straight onto a running device,
  `/etc/init.d/S99ha-speaker restart`, and the change **survives reboot**. Only an OTA/reflash
  resets it.
- **Access:** `ssh root@<ip>` password `hello3r`; ADB over USB **and over TCP on port 5555**
  (`adb connect <ip>:5555` — unauthenticated root shell, the firmware README warns about this
  itself); serial 115200 on the Debug board.

Relevant: `README.md` (repo root), `buildroot/package/thirdreality/linux-voice-assistant-cpp/README.md`.

---

# Part 1 — "Hey Homey" wake word

## How the TR picks wake words (source-verified)

1. **At boot** the init script `buildroot/package/thirdreality/tr-proj-ha-speaker/script/S99ha-speaker`
   starts the satellite with only `--name` and `--port`. It does **not** pass `--wakeword-models`,
   so `src/main.cpp` falls back to its default: **`okay_nabu` only** (`CliOptions::wakeword_models`,
   `main.cpp:141`, loaded at `main.cpp:629-661`).
2. **Model directory** is derived from `--wakeword-type` (`main.cpp:283-287`):
   `/usr/share/thirdreality/wakewords/microwakeword/` (default) or `.../openwakeword/`.
   Despite the `--wakeword-dir` line in `--help`, **there is no such option** in the getopt table
   (`main.cpp:153-167`) — stale help text. The directory is not configurable.
3. **Available list** = every `*.json` in that directory, scanned live on each
   `VoiceAssistantConfigurationRequest` (`src/audio/WakeWordScanner.cpp`,
   `src/satellite/Satellite.cpp:560-573`). The id is the **filename stem**. `stop.json` is excluded.
4. **Activation** = `VoiceAssistantSetConfiguration` (msg 123) with `active_wake_words`
   (`Satellite.cpp:630-700`). Max 2 active. Unknown ids are resolved via `ResolveWakeWordConfig`:
   local file first, then the external-wake-word table (below).
5. **Persistence gap — important.** `SetConfiguration` calls `state_.SavePreferences()`, but it only
   persists *sensitivities*; nothing writes `preferences.active_wake_words`, and `main.cpp` never
   reads it back. `Preferences` does round-trip the field (`src/state/Preferences.cpp:62-113`) but
   it is inert in the C++ build. **Net effect: an activated custom wake word is lost on reboot —
   the device comes back on `okay_nabu`.** (Our client's comment at
   `src/voice_assistant/esp-voice-assistant-client.mts:1086` — "The device persists the choice
   itself" — is true for the PE, not for the TR.)

## Route A — external wake word pushed over the API ★ recommended

The firmware implements Home Assistant's **external wake word** mechanism
(`src/audio/ExternalWakeWord.cpp`, `Satellite.cpp:574-603`): the client advertises models it hosts,
and the device downloads one the first time it is activated.

- The client sends `VoiceAssistantConfigurationRequest` **with** repeated
  `VoiceAssistantExternalWakeWord { id, wake_word, trained_languages, model_type, model_size,
  model_hash, url }`. Only `model_type == "micro"` is accepted (`Satellite.cpp:578`).
- `url` points at the **JSON manifest**; the `.tflite` URL is derived by replacing the last path
  segment with `<id>.tflite` (`ReplaceUrlFilename`) — so both files must sit in the same directory.
- `model_size` is the `.tflite` size in bytes, `model_hash` its **SHA-256, lowercase hex**. Matching
  size + hash means the cached copy is reused instead of re-downloaded.
- Downloads land in the normal wake-word directory (overlayfs → persistent), so after the first
  activation the model is a local file like any bundled one.
- Download is `libcurl`, follows redirects, 15 s connect / 120 s total timeout, plain HTTP on the
  LAN is fine.

**What this costs us** — everything else already exists:

1. `src/voice_assistant/api.proto`: our vendored copy predates the field. Add it (numbers taken
   from the firmware's own `proto/api.proto`, aioesphomeapi v42.7.0):
   ```proto
   message VoiceAssistantExternalWakeWord {
     string id = 1;
     string wake_word = 2;
     repeated string trained_languages = 3;
     string model_type = 4;
     uint32 model_size = 5;
     string model_hash = 6;
     string url = 7;
   }
   message VoiceAssistantConfigurationRequest {
     // ... existing options ...
     repeated VoiceAssistantExternalWakeWord external_wake_words = 1;
   }
   ```
   Wire-compatible with the PE: an ESPHome satellite that doesn't know the field ignores it.
2. Ship `hey_homey.tflite` + `hey_homey.json` in the app (e.g. `assets/wakewords/`) and serve them
   over the existing LAN `WebServer` (`src/helpers/webserver.mts`) — it already builds
   `http://<homey-ip>:<port>/...` URLs for audio, this is the same trick.
3. Populate `external_wake_words` on every `VoiceAssistantConfigurationRequest` the client sends
   (`esp-voice-assistant-client.mts:1091`, plus the one after `ListEntitiesDoneResponse`). Compute
   size + SHA-256 once at startup.
4. Nothing else — `applyWakeWord()` in `src/homey/voice-assistant-device.mts:1531` already resolves
   the typed name against `available_wake_words` and calls `setActiveWakeWords()`. "Hey Homey" simply
   shows up in the list.

**Also fix the reboot gap (app-side, no firmware):** on the `wake_words` event, if the device's
active set doesn't contain the configured `wake_word` setting, re-send `setActiveWakeWords()`. That
makes the choice survive reboots on the TR, and is harmless on the PE (which persists it anyway).
This is worth doing regardless of which route we take.

## Route B — copy the model onto the device

`scp hey_homey.{tflite,json} root@<ip>:/usr/share/thirdreality/wakewords/microwakeword/`. It appears
in `available_wake_words` on the next configuration request — no restart needed for *listing*, and
`SetConfiguration` loads it immediately. Persistent thanks to the overlayfs, but wiped by an OTA and
manual per device. Fine for the first live test, wrong as a product.

## Route C — bake it into the firmware

Drop the model into `buildroot/package/thirdreality/linux-voice-assistant-cpp/wakewords/microwakeword/`
and rebuild. Combine with an edited `S99ha-speaker` (`--wakeword-models hey_homey`) to make it the
**boot default**, which is the only way to fix the persistence gap without app-side help. Costs a
full flash and forks us from upstream OTA. Only worth it if we ever ship pre-flashed hardware.

## Actually getting a "Hey Homey" model

The TR runs **microWakeWord** (TFLite, `--wakeword-type micro`) — the same engine as the Voice PE,
so any model that works on a PE works here. Manifest fields the firmware reads
(`src/audio/MicroWakeWord.cpp:26-95`, `WakeWordScanner.cpp`):

```json
{
  "type": "micro",
  "wake_word": "Hey Homey",
  "model": "hey_homey.tflite",
  "trained_languages": ["en", "no"],
  "version": 2,
  "micro": { "probability_cutoff": 0.85, "sliding_window_size": 5 }
}
```

The id is the **filename stem** (`hey_homey`), `model` is resolved relative to the manifest, and only
`probability_cutoff` + `sliding_window_size` (clamped 1..max) are read from the `micro` block —
`feature_step_size` / `tensor_arena_size` are ESP32 concerns and ignored on Linux. The `.tflite` must
be a quantized streaming model with input shape `[1, stride, 40]` (40 features/30 ms frame) or it is
rejected at load.

Training options, roughly by effort:

- **[OHF-Voice/micro-wake-word](https://github.com/OHF-Voice/micro-wake-word)** (the current home of
  kahrendt's trainer) — `basic_training_notebook.ipynb`, synthetic positives from
  [piper-sample-generator](https://github.com/dscripka/piper-sample-generator), negatives from the
  published feature sets on Hugging Face. The maintainers are blunt that a first run "will most
  likely not be usable" — expect hyperparameter iteration.
- **[microwakeword.com](https://microwakeword.com/)** — hosted trainer that returns the
  `.tflite` + `.json` pair directly. Fastest path to something testable.
- **Community request threads** on the HA forum, where people have had V2 models trained for them.
- **openWakeWord** is easier to train ([2026 Colab](https://github.com/alfiedennen/openwakeword-colab-2026))
  but is a poor fit here: it requires `--wakeword-type open` at boot (mutually exclusive with micro —
  `main.cpp:283`, and the "stop" word is micro-only), and **external wake words reject anything but
  `micro`**. It would mean editing the init script on every device. Not recommended.

Two phrase notes: "Hey Homey" is phonetically close to "Hey Google"/"Hey Honey", so expect false
accepts and budget for tuning `probability_cutoff` — the TR exposes per-slot sensitivity as Number
entities (`wake_word_1_sensitivity`, `wake_word_2_sensitivity`) we can already read. And max 2 active
wake words, so "Hey Homey" alongside "Okay Nabu" is possible.

---

# Part 2 — Controlling the LED

## What the LED actually is

Not an addressable ring. It is a **single RGB LED** driven through sysfs by a separate daemon:

- `buildroot/package/thirdreality/tr-ledring/src/thirdreality-ledring-service.cpp:43-47` writes
  `/sys/class/leds/RGB_R|RGB_G|RGB_B/brightness` (0-255 per channel).
- Animations are plain-text files in `/usr/share/thirdreality/animation/*.animation`, parsed by a
  flex/bison grammar (`src/lex.l`, `src/parse.y`). Format: one frame per line,
  `<duration>:<12 comma-separated hex colours>`, plus a bare `loop` line and `#` comments.
  **Duration is milliseconds** (`usleep(duration * 1000)`, `thirdreality-ledring-service.cpp:139`)
  and — despite the 12 colour columns — the parser keeps only the **first** colour per frame
  (`parse.y`, `LedShowInfo(duration, color, loop)`), so every frame is one solid colour. 3-digit hex
  is expanded like CSS. 30 stock animations ship (`amz-led-animation/single/`), Amazon-AVS heritage:
  `active-waking`, `active-thinking`, `active-talking`, `active-ending`, `mics-off_on`, `error`,
  `green`, `red`, `volume-changed`, `none`, …
- The satellite triggers them by **spawning `dbus-send`** — a signal, not a method call
  (`src/tr/LedRing.cpp`):
  ```
  dbus-send --system --type=signal /com/3r/EventBus com._3reality.EventBus.LedShow \
      boolean:<to_idle> array:string:/usr/share/thirdreality/animation/<name>.animation
  ```
  The mapping lives in `LedRing.cpp:AnimationFor()`: Listening → `active-waking`, Thinking →
  `active-thinking`, Speaking → `active-talking`, Idle/Error → `active-ending`, Muted →
  `mics-off_on`, Unmuted → `none`. `to_idle=true` for the terminal states.
- The D-Bus policy (`tr-ledring-dbus.conf`) allows any local user to send; the interface XML
  (`src/3r.ledring_service.xml`) exposes exactly one method (`FactoryReset`) and one signal
  (`LedShow`). **There is no network-facing LED API.**

## Why it is invisible to us today

The satellite registers 11 entities (`src/main.cpp:411+`, `src/entities/`): media player, mute
switch, thinking-sound switch, three sensitivity Numbers, mic gain, mic volume, mic-noise Select,
home-button Event, Update. **There is no Light entity and no LED-related Select** — `src/entities/`
contains Button/Event/MediaPlayer/MuteSwitch/Number/Select/ThinkingSound/Update and nothing else. The
supervisor HTTP API on port 8086 only serves `/api/wifi/status`, `/api/system/info`,
`/api/ota/status` and a signed `/api/system/command` (reboot / factory_reset / ota) —
`src/tr/SupervisorHttpServer.cpp:436-606`. So there is genuinely no way to touch the LED over the
LAN on stock firmware.

## Route A — no firmware, over SSH/ADB (works today, for experiments)

```sh
# play a stock animation
ssh root@<ip> 'dbus-send --system --type=signal /com/3r/EventBus \
  com._3reality.EventBus.LedShow boolean:false \
  array:string:/usr/share/thirdreality/animation/green.animation'

# or bypass the daemon entirely — raw sysfs, 0-255 per channel
ssh root@<ip> 'echo 255 > /sys/class/leds/RGB_R/brightness'
```

Custom animations are just files you drop next to the others (overlayfs → persistent). Caveat: the
daemon reasserts its own animation on the next pipeline state change, so anything we set is
transient unless the device is idle. Shipping this in the Homey app would mean bundling an SSH
client and storing root credentials per device — acceptable for a lab, not for the App Store.

## Route B — firmware patch: expose the LED as a Select ★ cheapest real fix

Add one `SelectEntity` ("LED animation", options = the `.animation` filenames) whose setter calls
`lva::tr::Show`-style `dbus-send`. The firmware already has `SelectEntity` (used for mic noise
suppression) so this is a small, low-risk patch — mostly copy/paste of the `mic_noise` entity in
`main.cpp:516`.

App side: our client already captures Select entity keys (`esp-voice-assistant-client.mts:654`) but
never sends `SelectCommandRequest` — that's a handful of lines next to the existing
`SwitchCommandRequest` path (`:1173`).

Limitation: pick-from-a-list only, no arbitrary colour.

## Route C — firmware patch: expose the LED as a Light entity ★ best UX

Add a `LightEntity` advertising `COLOR_MODE_RGB` (= 35, `api.proto`), handling `LightCommandRequest`
(msg 32) and publishing `LightStateResponse` (msg 24). Map `state`/`brightness`/`red`/`green`/`blue`
onto either the sysfs files directly or a synthesized one-frame animation. Roughly a new
`src/entities/LightEntity.{h,cpp}` plus a dispatch case in `src/protocol/Connection.cpp` and
registration in `main.cpp` — the same shape as the existing entities, no new dependencies.

Design decision to settle first: **who owns the LED**. The satellite drives it from pipeline state
(`LedRing::Show` on every wake/think/speak transition), so a Homey-set colour will be overwritten on
the next voice interaction. Either (a) treat the light as a *manual override with priority* and skip
`LedRing::Show` while overridden, or (b) accept it as idle-state-only decoration. (a) is the
defensible behaviour.

App side, once the firmware advertises it:
- `esp-voice-assistant-client.mts`: handle `ListEntitiesLightResponse` (msg 15) → register the key
  next to the other entity types, and add a `setLight()` sending `LightCommandRequest`. Our
  `api.proto` **already has all three messages** — only the dispatch code is missing.
- `VoiceAssistantDevice`: expose Homey capabilities `onoff` / `dim` / `light_hue` / `light_saturation`
  on the TR driver, plus a flow action card. Note this collides conceptually with the existing
  `onoff`-style capabilities on the device — decide whether the LED is a sub-capability or its own
  thing before wiring it.
- The LLM could then get a tool for it ("set the speaker light to red") — but that's a
  cost-of-growth-gated feature, see `docs/cost-of-growth.md`.

## Route D — sysfs over the existing pipeline

Worth noting for completeness: because the LED is plain sysfs, *any* on-device process can drive it.
A tiny custom daemon (added as a Buildroot package) exposing an HTTP endpoint would avoid touching
the satellite at all — but that is strictly more work than Route B/C for less integration, since we'd
also have to invent discovery and auth. Not recommended.

---

# Suggested order of work

1. **Get a "Hey Homey" microWakeWord model** and prove it on a TR via Route B (`scp` + the existing
   `wake_word` device setting). Pure experiment, no code.
2. **Fix wake-word persistence app-side** (re-apply the configured wake word when the device reports
   a mismatched active set). Small, useful on its own, no firmware.
3. **Ship the model via Route A** (proto field + serve from `WebServer` + populate
   `external_wake_words`). This is the shippable "Hey Homey" feature: works on a factory-fresh TR
   with nothing installed on it.
4. **LED**: prototype with Route A/SSH to confirm behaviour and animation authoring, then decide
   Select (B) vs Light (C). Only C needs the Amlogic Burn Tool and a Windows box for the first flash
   — after that, `scp` the rebuilt binary.

# Open questions to answer on real hardware

- Does the TR reject or accept an `external_wake_words` list on a firmware build that predates it?
  (Unknown fields are ignored by protobuf, so it should degrade to "not offered" — verify.)
- Exact false-accept rate of a "Hey Homey" model against "Hey Google" / "Hey Honey" in a real room.
- Does `SetConfiguration` with 2 active words (Okay Nabu + Hey Homey) measurably raise CPU on the
  A113? Both models run per audio chunk in the same thread (`WakeWordEngine::ThreadLoop`).
- Whether the LED daemon's animation queue drops or queues a manual override mid-pipeline.
- Whether an OTA update wipes the overlayfs upper dir (i.e. whether pushed models survive updates).

# Sources

- Firmware: [thirdreality/voice-music-assistant](https://github.com/thirdreality/voice-music-assistant), branch `linux-voice-assistant`
- Upstream satellite: [OHF-Voice/linux-voice-assistant](https://github.com/OHF-Voice/linux-voice-assistant)
- Wake-word training: [OHF-Voice/micro-wake-word](https://github.com/OHF-Voice/micro-wake-word) ·
  [esphome/micro-wake-word-models](https://github.com/esphome/micro-wake-word-models) ·
  [piper-sample-generator](https://github.com/dscripka/piper-sample-generator) ·
  [microwakeword.com](https://microwakeword.com/) ·
  [ESPHome micro_wake_word docs](https://esphome.io/components/micro_wake_word/)
- HA custom wake words: [home-assistant.io/voice_control/create_wake_word](https://www.home-assistant.io/voice_control/create_wake_word/)
- In-repo: [`README.md`](./README.md) (TR hardware/protocol reference), [`../esphome-noise-encryption.md`](../esphome-noise-encryption.md), [`../../CLAUDE.md`](../../CLAUDE.md)
