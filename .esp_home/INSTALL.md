# Installing the custom config onto a Voice PE

This guide flashes `home-assistant-voice.yaml` (plus the customizations) onto a
**Home Assistant Voice PE** so it can be used with the **Homey AI Voice Assistant app**.

> Re-applying the local tweaks after a stock update? Do that **first** — see
> [`CUSTOMIZATIONS.md`](./CUSTOMIZATIONS.md) — then come back here to flash.

---

## What you need

- **ESPHome 2026.6.0 or newer.** The config sets `min_version: 2026.6.0`; older ESPHome refuses to compile it.
- The whole `.esp_home/` folder (the `home-assistant-voice.yaml` **and** the `wake_words/` folder next to it).
- A **`secrets.yaml`** in the same folder as the YAML (see Step 1).
- A **USB‑C cable** — required for the first flash and for recovery if the device ever boot‑loops.
- One way to run ESPHome (Step 2): the Home Assistant add‑on, the `esphome` CLI, or Docker.

---

## Step 1 — Create `secrets.yaml`

The config reads the Wi‑Fi credentials with `!secret`, so create `secrets.yaml` **in the same folder** as
`home-assistant-voice.yaml`:

```yaml
wifi_ssid: "YourWiFiName"
wifi_password: "YourWiFiPassword"
```

> `secrets.yaml` holds credentials — don't commit it. (It should already be covered by `.gitignore`;
> double‑check before pushing.)

---

## Step 2 — ⚠️ API encryption: Homey vs Home Assistant

The stock config contains an empty API encryption block, meant for Home Assistant to provision a key:

```yaml
api:
  id: api_id
  ...
  encryption:   # Uses key set by Home Assistant
```

**For use with the Homey AI Voice Assistant app, the native API must be plaintext.** The app's ESP client
is plaintext‑only and does **not** support Noise encryption — a device that has an API encryption key set
will fail to connect to Homey entirely. Before flashing for Homey, **comment out (or remove) the
`encryption:` line** so no key is negotiated:

```yaml
api:
  id: api_id
  on_client_connected:
    - script.execute: control_leds
  on_client_disconnected:
    - script.execute: control_leds
  # encryption:   # disabled — the Homey app connects in plaintext (no Noise support)
```

> If you also want this device in Home Assistant, that's the opposite trade‑off (HA wants encryption).
> Pick one. For this project, leave it plaintext.

(Authentication note: ESPHome 2026.1.0+ / PE firmware 26.x removed native‑API *password* auth entirely,
so there's nothing else to configure on the auth side.)

---

## Step 3 — Get ESPHome

Pick whichever you already have. All three read the same YAML.

**A. Home Assistant add‑on** — install **ESPHome Device Builder** from the HA add‑on store, open its web UI.

**B. Standalone CLI** (Python 3):
```bash
pip install --upgrade esphome
esphome version          # confirm it's >= 2026.6.0
```

**C. Docker:**
```bash
docker run --rm -v "${PWD}":/config -it ghcr.io/esphome/esphome version
```

---

## Step 4 — Flash the device

### First flash must be over USB
A brand‑new or HA‑adopted PE won't accept your OTA updates until it's running *your* build, so the **first**
install has to go over the USB‑C cable. After that, updates can go wirelessly (OTA) over Wi‑Fi.

### Option A — ESPHome Dashboard (add‑on or `esphome dashboard`)
1. Put `home-assistant-voice.yaml`, `secrets.yaml`, and `wake_words/` into the dashboard's config folder.
2. Click the device's **⋮ → Install**.
3. Choose **"Plug into this computer"** for the first flash (USB), or **"Wirelessly"** once it's already
   running your build.
4. Follow the browser prompt to pick the serial port. Keep the install log open.

### Option B — CLI / Docker
From the folder that contains the YAML:
```bash
# First flash (device on USB):
esphome run home-assistant-voice.yaml

# Later updates over the air:
esphome run home-assistant-voice.yaml --device OTA
```
`esphome run` compiles, downloads the remote wake‑word models, and then asks whether to upload over USB
(serial) or OTA. Pick the serial port for the first flash.

> Docker equivalent: `docker run --rm -v "${PWD}":/config --device=/dev/ttyACM0 -it ghcr.io/esphome/esphome run home-assistant-voice.yaml`
> (swap in your serial device; on Windows use the dashboard/CLI on the host for USB instead).

---

## Step 5 — Verify it came up

Watch the logs during/after boot:
```bash
esphome logs home-assistant-voice.yaml          # USB or OTA, auto-detects
```
(or the **Logs** button in the dashboard). You're looking for:

- Boot completes without a reboot loop.
- `wifi: ... connected` to your SSID.
- `api: ... ` listening — once the Homey app discovers it, you'll see a client connect.
- The **LED ring** should reflect state per [`CUSTOMIZATIONS.md`](./CUSTOMIZATIONS.md) (init twinkle →
  idle, then the rainbow phases when a voice session runs).

Then pair / discover the device from the **Homey AI Voice Assistant app**.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Compile fails: *"current ESPHome version is too old"* | ESPHome < 2026.6.0. Upgrade (`pip install -U esphome`). |
| *"secret 'wifi_ssid' not found"* | No `secrets.yaml`, or it's not in the same folder as the YAML. See Step 1. |
| **Homey app can't connect / discovers but won't pair** | An API **encryption key is set**. Disable the `encryption:` block (Step 2) and re‑flash. The client is plaintext‑only. |
| **Boot loop right after flashing** | Almost always the custom wake‑word model using an unsupported TFLite op. Comment out the `hey_homey` model entry and re‑flash over USB — see `CUSTOMIZATIONS.md` Change 1. |
| OTA upload fails / times out | Do the first flash over **USB** (Step 4). OTA only works once the device already runs your build and is on Wi‑Fi. |
| Device on USB not detected | Wrong/charge‑only cable, missing serial driver, or another program holding the port. Try another cable/port; close other serial monitors. |
| Customizations gone after a stock update | A fresh `home-assistant-voice.yaml` wipes local edits. Re‑apply [`CUSTOMIZATIONS.md`](./CUSTOMIZATIONS.md), then re‑flash. |

---

## Recovery (bricked / boot‑looping device)

1. Connect the PE over USB‑C.
2. Comment out whatever you changed last (most often the wake‑word model entry).
3. `esphome run home-assistant-voice.yaml` and flash over **serial**.
4. If serial won't take, the device drops into safe mode after ~10 fast reboots — then OTA becomes available.
