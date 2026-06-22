# Voice PE config customizations

These are the local changes applied on top of the **stock `home-assistant-voice.yaml`** downloaded
from ESPHome / GitHub. When you download a fresh config (an update wipes these), re-apply the three
changes below to get back to the customized behavior.

All line numbers are approximate — search for the anchor text instead.

---

## Change 1 — Custom "Hey Homey" wake word

> ⚠️ **USE microWakeWord, NOT openWakeWord.** These are two different systems with near-identical names:
> - **microWakeWord** ([microwakeword.com](https://microwakeword.com/)) — runs **on the ESP32 itself**. This is
>   what the Voice PE uses. ← train here.
> - **openWakeWord** ([openwakeword.com](https://openwakeword.com/)) — runs on a **server** (HA add-on). Its
>   `.tflite` uses ops (e.g. `SHAPE`) the on-device engine can't run. It tests fine online but **crash-loops
>   the PE**. There is no openWakeWord server in the Homey-app setup, so its models are unusable here and are
>   **not convertible** to microWakeWord. (This exact mix-up caused the first boot loop.)
>
> ⚠️ **MODEL COMPATIBILITY — read this before enabling.** The `.tflite` must be a proper
> **streaming microWakeWord V2** export. ESPHome's on-device engine registers only a small fixed set
> of TFLite-Micro ops. If the model contains an unsupported op (e.g. `SHAPE`), the device does **not**
> error at compile — it flashes fine, then **crash-loops at boot**:
> ```
> Failed to get registration from op code SHAPE
> Guru Meditation Error: Core 0 panic'ed (LoadProhibited)
> Rebooting...
> ```
> The crash happens at model *load* (right after `STARTING -> DETECTING_WAKE_WORD`), so no
> `probability_cutoff` change helps. Recovery: comment out the model entry and re-flash over USB
> (or wait ~10 fast reboots for safe mode, then OTA). A bad export is also often suspiciously large
> (the first failed `hey_homey.tflite` was 824 KB; stock streaming models are far smaller).
> **Build the model with a trainer that targets ESPHome specifically** (microwakeword.com "firmware-ready"
> output, or the TaterTotterson Docker trainer) and verify it boots before relying on it. The model
> entry is currently **commented out** in `home-assistant-voice.yaml` for this reason.


The trained model lives in this folder under `wake_words/` and is hosted on GitHub:

```
.esp_home/wake_words/hey_homey.json     (manifest, V2 format)
.esp_home/wake_words/hey_homey.tflite   (trained model — add after training)
```

In the **`micro_wake_word:`** block, find the `models:` list and add `hey_homey` as the first entry:

```yaml
micro_wake_word:
  id: mww
  ...
  models:
    - model: https://raw.githubusercontent.com/arvebjoe/no.arvebjoe.ai-voice-assistant/main/.esp_home/wake_words/hey_homey.json
      id: hey_homey
    - model: https://github.com/kahrendt/microWakeWord/releases/download/okay_nabu_20241226.3/okay_nabu.json
      id: okay_nabu
    # ... leave the rest (hey_jarvis, hey_mycroft, stop) unchanged
```

> **Use the direct `raw.githubusercontent.com` URL, NOT the `github.com/.../raw/main/...` form.**
> The `github.com/.../raw/` URL returns a 302 redirect that ESPHome's model downloader rejects at
> validation time with a misleading *"Not a valid model name, local path, http(s) url, or github
> shorthand"* error. The `raw.githubusercontent.com` form serves the file directly (no redirect).
> The github shorthand `github://arvebjoe/no.arvebjoe.ai-voice-assistant/.esp_home/wake_words/hey_homey.json@main`
> also works as an alternative.
>
> Both `hey_homey.json` and `hey_homey.tflite` must be pushed to the `main` branch for the compile-time
> download to work (swap `main`→`master` in the URL if that's the default branch). The manifest's
> `"model": "hey_homey.tflite"` is relative, so the two files must sit in the same folder.

---

## Change 2 — Custom LED ring effects

In the **`light:`** section, under the `voice_assistant_leds` partition light's `effects:` list, add these
**four** `addressable_lambda` effects. Insert them anywhere in the list — next to the existing
`"Replying"` / `"Muted or Silent"` effects is fine.

```yaml
      - addressable_lambda:
          name: "Voice Rainbow"
          update_interval: 50ms
          lambda: |-
            // Fill all 12 LEDs with the full color wheel and rotate it.
            static uint8_t rotation = 0;
            if (initial_run) {
              rotation = 0;
            }
            for (uint8_t i = 0; i < 12; i++) {
              uint8_t hue = (uint8_t)((i * 256 / 12) + rotation);
              ESPHSVColor hsv(hue, 255, 255);
              it[i] = hsv.to_rgb();
            }
            // Increment = clockwise; 10 per 50ms = ~1.3s per full turn.
            rotation = rotation + 10;
      - addressable_lambda:
          name: "Cold Rainbow"
          update_interval: 50ms
          lambda: |-
            // Cold rotating ring (green -> cyan -> blue -> purple).
            // A triangle wave keeps the hue inside the cold band so there is no seam.
            static uint16_t rotation = 0;
            if (initial_run) {
              rotation = 0;
            }
            const float cold_min = 85.0f;   // green  (hue 85  = 120 deg)
            const float cold_max = 205.0f;  // purple (hue 205 = 288 deg)
            for (uint8_t i = 0; i < 12; i++) {
              float pos = (float)((i * 256 / 12 + rotation) % 256) / 256.0f;  // 0..1 around the ring
              float t = pos < 0.5f ? (pos * 2.0f) : (2.0f - pos * 2.0f);       // 0..1..0 (stay cold)
              uint8_t hue = (uint8_t)(cold_min + t * (cold_max - cold_min));
              ESPHSVColor hsv(hue, 255, 255);
              it[i] = hsv.to_rgb();
            }
            // Decrement = counter-clockwise (opposite the full rainbow); 10 per frame.
            rotation = (rotation + 256 - 10) % 256;
      - addressable_lambda:
          name: "Thinking White"
          update_interval: 10ms
          lambda: |-
            // All LEDs pulse white (breathing) by ramping brightness up and down.
            static uint8_t brightness_step = 0;
            static bool brightness_decreasing = true;
            static uint8_t brightness_step_number = 10;
            if (initial_run) {
              brightness_step = 0;
              brightness_decreasing = true;
            }
            Color white_color(255, 255, 255);
            for (uint8_t i = 0; i < 12; i++) {
              it[i] = white_color * uint8_t(255/brightness_step_number*(brightness_step_number-brightness_step));
            }
            if (brightness_decreasing) {
              brightness_step++;
            } else {
              brightness_step--;
            }
            if (brightness_step == 0 || brightness_step == brightness_step_number) {
              brightness_decreasing = !brightness_decreasing;
            }
      - addressable_lambda:
          name: "Warm Rainbow"
          update_interval: 50ms
          lambda: |-
            // Warm rotating ring (red -> orange -> yellow).
            // A triangle wave keeps the hue inside the warm band so there is no red->yellow seam.
            static uint16_t rotation = 0;
            if (initial_run) {
              rotation = 0;
            }
            const float warm_min = 0.0f;    // red   (hue 0)
            const float warm_max = 45.0f;   // yellow (hue ~45 = 63 deg)
            for (uint8_t i = 0; i < 12; i++) {
              float pos = (float)((i * 256 / 12 + rotation) % 256) / 256.0f;  // 0..1 around the ring
              float t = pos < 0.5f ? (pos * 2.0f) : (2.0f - pos * 2.0f);       // 0..1..0 (stay warm)
              uint8_t hue = (uint8_t)(warm_min + t * (warm_max - warm_min));
              ESPHSVColor hsv(hue, 255, 255);
              it[i] = hsv.to_rgb();
            }
            // Decrement = counter-clockwise (opposite the full rainbow); 10 per frame.
            rotation = (rotation + 256 - 10) % 256;
```

### Tuning knobs
- **Rotation speed / direction:** the `rotation` update line in each rotating effect (step `10`). Voice Rainbow **increments** (clockwise); Cold Rainbow and Warm Rainbow **decrement** (counter-clockwise). Higher step = faster; swap increment↔decrement to flip a ring's direction. (Increment vs decrement maps to CW/CCW based on the ring's physical wiring — flip if it spins the wrong way on your unit.)
- **Cold band:** `cold_min` / `cold_max` in "Cold Rainbow" set the hue range (85 = green, ~128 = cyan, ~170 = blue, ~205 = purple). Narrow it to taste.
- **Warm band:** `warm_min` / `warm_max` in "Warm Rainbow" set the hue range (0 = red, ~21 = orange, ~45 = yellow). Widen `warm_max` toward green or narrow it to taste.
- **Thinking White** (pulse) is still defined but unused (Thinking now uses Cold Rainbow). Keep it if you want to switch back; `brightness_step_number` controls its pulse speed.

---

## Change 3 — Point the voice phases at the new effects

In the **`script:`** section, change the `effect:` line inside four `control_leds_*` scripts.
The stock config uses the effect names in the "Stock" column; change them to the "Custom" column.

| Script id                                            | Stock effect            | → Custom effect       |
|------------------------------------------------------|-------------------------|-----------------------|
| `control_leds_voice_assistant_waiting_for_command_phase`   | `"Waiting for Command"` | `"Voice Rainbow"`     |
| `control_leds_voice_assistant_listening_for_command_phase` | `"Listening For Command"` | `"Voice Rainbow"`   |
| `control_leds_voice_assistant_thinking_phase`              | `"Thinking"`            | `"Cold Rainbow"`      |
| `control_leds_voice_assistant_replying_phase`              | `"Replying"`            | `"Warm Rainbow"`      |

Each edit is just the one `effect:` line, e.g.:

```yaml
  - id: control_leds_voice_assistant_thinking_phase
    then:
      - light.turn_on:
          brightness: !lambda return max( id(led_ring).current_values.get_brightness() , 0.2f );
          id: voice_assistant_leds
          effect: "Cold Rainbow"      # was: "Thinking"
```

> The stock effects (`Waiting for Command`, `Listening For Command`, `Thinking`, `Replying`) can be
> left defined in the `effects:` list — they just become unused, which makes reverting easy.

### Resulting behavior
The full rainbow spins clockwise; the cold and warm rings spin counter-clockwise. All rings use step `10`.
- **Waiting + Listening** → full rainbow, clockwise
- **Thinking** (processing) → cold ring (green/cyan/blue/purple), counter-clockwise
- **Replying** (speaking the answer) → warm ring (red/orange/yellow), counter-clockwise

Error / muted / timer states are left untouched (error = red pulse, etc.).

---

## After re-applying

```
ESPHome → Install   # compiles the YAML, downloads the wake-word model, flashes the device
```
