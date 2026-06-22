# Voice PE config customizations

These are the local changes applied on top of the **stock `home-assistant-voice.yaml`** downloaded
from ESPHome / GitHub. When you download a fresh config (an update wipes these), re-apply the three
changes below to get back to the customized behavior.

All line numbers are approximate — search for the anchor text instead.

---

## Change 1 — Custom "Hey Homey" wake word

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
    - model: https://github.com/arvebjoe/no.arvebjoe.ai-voice-assistant/raw/main/.esp_home/wake_words/hey_homey.json
      id: hey_homey
    - model: https://github.com/kahrendt/microWakeWord/releases/download/okay_nabu_20241226.3/okay_nabu.json
      id: okay_nabu
    # ... leave the rest (hey_jarvis, hey_mycroft, stop) unchanged
```

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
            // Fill all 12 LEDs with the full color wheel and rotate it (clockwise).
            static uint8_t rotation = 0;
            if (initial_run) {
              rotation = 0;
            }
            for (uint8_t i = 0; i < 12; i++) {
              uint8_t hue = (uint8_t)((i * 256 / 12) + rotation);
              ESPHSVColor hsv(hue, 255, 255);
              it[i] = hsv.to_rgb();
            }
            // Higher step = faster rotation. 4 per 50ms = ~3.2s per full turn.
            rotation = rotation + 4;
      - addressable_lambda:
          name: "Voice Rainbow CCW"
          update_interval: 50ms
          lambda: |-
            // Same rainbow, rotating the other way (subtract instead of add the offset).
            static uint8_t rotation = 0;
            if (initial_run) {
              rotation = 0;
            }
            for (uint8_t i = 0; i < 12; i++) {
              uint8_t hue = (uint8_t)((i * 256 / 12) - rotation);
              ESPHSVColor hsv(hue, 255, 255);
              it[i] = hsv.to_rgb();
            }
            rotation = rotation + 4;
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
          name: "Waiting Teal"
          update_interval: 16ms
          lambda: |-
            // All LEDs pulse teal (breathing) while waiting for the user to speak.
            static uint8_t brightness_step = 0;
            static bool brightness_decreasing = true;
            static uint8_t brightness_step_number = 20;
            if (initial_run) {
              brightness_step = 0;
              brightness_decreasing = true;
            }
            Color teal_color(0, 128, 128);
            for (uint8_t i = 0; i < 12; i++) {
              it[i] = teal_color * uint8_t(255/brightness_step_number*(brightness_step_number-brightness_step));
            }
            if (brightness_decreasing) {
              brightness_step++;
            } else {
              brightness_step--;
            }
            if (brightness_step == 0 || brightness_step == brightness_step_number) {
              brightness_decreasing = !brightness_decreasing;
            }
```

### Tuning knobs
- **Rotation speed / direction:** the `rotation = rotation + 4` line in the two rainbow effects. Higher = faster; CCW uses `-` in the hue calculation.
- **Pulse speed:** `brightness_step_number` (higher = slower/smoother). Thinking uses `10`, waiting uses `20` (calmer).
- **Teal shade:** `Color teal_color(0, 128, 128)` (#008080). Raise both channels equally for a brighter teal; keep them equal to stay on the teal hue.

---

## Change 3 — Point the voice phases at the new effects

In the **`script:`** section, change the `effect:` line inside four `control_leds_*` scripts.
The stock config uses the effect names in the "Stock" column; change them to the "Custom" column.

| Script id                                            | Stock effect            | → Custom effect       |
|------------------------------------------------------|-------------------------|-----------------------|
| `control_leds_voice_assistant_waiting_for_command_phase`   | `"Waiting for Command"` | `"Waiting Teal"`      |
| `control_leds_voice_assistant_listening_for_command_phase` | `"Listening For Command"` | `"Voice Rainbow"`   |
| `control_leds_voice_assistant_thinking_phase`              | `"Thinking"`            | `"Thinking White"`    |
| `control_leds_voice_assistant_replying_phase`              | `"Replying"`            | `"Voice Rainbow CCW"` |

Each edit is just the one `effect:` line, e.g.:

```yaml
  - id: control_leds_voice_assistant_thinking_phase
    then:
      - light.turn_on:
          brightness: !lambda return max( id(led_ring).current_values.get_brightness() , 0.2f );
          id: voice_assistant_leds
          effect: "Thinking White"      # was: "Thinking"
```

> The stock effects (`Waiting for Command`, `Listening For Command`, `Thinking`, `Replying`) can be
> left defined in the `effects:` list — they just become unused, which makes reverting easy.

### Resulting behavior
- **Waiting** (awake, ready, no speech yet) → teal breathing pulse
- **Listening** (capturing your speech) → rainbow rotating clockwise
- **Thinking** (processing) → white breathing pulse
- **Replying** (speaking the answer) → rainbow rotating counter-clockwise

Error / muted / timer states are left untouched (error = red pulse, etc.).

---

## After re-applying

```
ESPHome → Install   # compiles the YAML, downloads the wake-word model, flashes the device
```
