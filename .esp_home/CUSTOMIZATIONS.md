# Voice PE config customizations

These are the local changes applied on top of the **stock `home-assistant-voice.yaml`** downloaded
from ESPHome / GitHub. When you download a fresh config (an update wipes these), re-apply the changes
below to get back to the customized behavior.

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

## Change 2 — Shared rainbow rotation global

The three rainbow voice-phase effects (Listening / Thinking / Reply) share a single rotation value so
the rainbow keeps its position across phase changes — Listening spins it, Thinking freezes it in place
(only pulsing brightness), and Reply continues from the same spot but spins the other way. This only
works if the rotation lives in a **global** instead of each effect's own `static` variable.

In the **`globals:`** section, add this entry (next to `global_led_animation_index` is fine):

```yaml
  # Shared rotation for the rainbow voice-phase effects (Voice Rainbow / Thinking Rainbow / Reply Rainbow).
  # Kept global so the rainbow keeps its position across phase changes: Listening spins it, Thinking
  # freezes it in place (only pulses brightness), Reply continues from the same spot but spins the other way.
  - id: led_rainbow_rotation
    type: uint8_t
    restore_value: no
    initial_value: '0'
```

> `uint8_t` matters: it wraps 0→255 automatically, so `rotation - 6` and `rotation + 6` stay valid
> without any modulo. The hue math (`i * 256 / 12 + rotation`) assumes this 0–255 range.

---

## Change 3 — Custom LED ring effects

In the **`light:`** section, under the `voice_assistant_leds` partition light's `effects:` list, add the
effects below. Insert them anywhere in the list — next to the existing `"Replying"` / `"Muted or Silent"`
effects is fine.

The three rainbow effects all read/write `id(led_rainbow_rotation)` (Change 2). `Voice Rainbow` and
`Reply Rainbow` advance it in opposite directions; `Thinking Rainbow` deliberately leaves it untouched.

```yaml
      - addressable_lambda:
          name: "Voice Rainbow"
          update_interval: 50ms
          lambda: |-
            // Fill all 12 LEDs with the full color wheel and rotate it.
            // Uses the shared global rotation so Thinking/Reply can pick up where this leaves off.
            if (initial_run) {
              id(led_rainbow_rotation) = 0;
            }
            for (uint8_t i = 0; i < 12; i++) {
              uint8_t hue = (uint8_t)((i * 256 / 12) + id(led_rainbow_rotation));
              ESPHSVColor hsv(hue, 255, 255);
              it[i] = hsv.to_rgb();
            }
            // Decrement to rotate the "other way"; 6 per 50ms = ~2.1s per full turn.
            id(led_rainbow_rotation) = id(led_rainbow_rotation) - 6;
      - addressable_lambda:
          name: "Thinking Rainbow"
          update_interval: 50ms
          lambda: |-
            // Freeze the rainbow where Listening left it (do NOT touch led_rainbow_rotation)
            // and pulse the whole ring between 100% and 25% brightness and back.
            static float pulse = 1.0f;
            static bool pulse_down = true;
            if (initial_run) {
              pulse = 1.0f;
              pulse_down = true;
            }
            for (uint8_t i = 0; i < 12; i++) {
              uint8_t hue = (uint8_t)((i * 256 / 12) + id(led_rainbow_rotation));
              ESPHSVColor hsv(hue, 255, (uint8_t)(255.0f * pulse));
              it[i] = hsv.to_rgb();
            }
            // 0.05 step at 50ms => ~0.75s each way, ~1.5s full breath (1.0 -> 0.25 -> 1.0).
            if (pulse_down) {
              pulse -= 0.05f;
              if (pulse <= 0.25f) { pulse = 0.25f; pulse_down = false; }
            } else {
              pulse += 0.05f;
              if (pulse >= 1.0f) { pulse = 1.0f; pulse_down = true; }
            }
      - addressable_lambda:
          name: "Reply Rainbow"
          update_interval: 50ms
          lambda: |-
            // Same as Voice Rainbow but spins the opposite way. Continues from the shared
            // rotation (no reset) so it picks up exactly where Thinking froze the ring.
            for (uint8_t i = 0; i < 12; i++) {
              uint8_t hue = (uint8_t)((i * 256 / 12) + id(led_rainbow_rotation));
              ESPHSVColor hsv(hue, 255, 255);
              it[i] = hsv.to_rgb();
            }
            // Increment (Voice Rainbow decrements) to rotate the other way; same 6 per frame.
            id(led_rainbow_rotation) = id(led_rainbow_rotation) + 6;
```

`Waiting` still uses the existing **Warm Rainbow** effect (red → orange → yellow triangle band), so keep
that one defined too:

```yaml
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
            // Decrement to rotate the "other way"; 6 per frame matches the other rings.
            rotation = (rotation + 256 - 6) % 256;
```

> The older **Cold Rainbow** (green→purple band) and **Thinking White** (white breathing pulse) effects
> are no longer wired to any phase. They can be dropped, or left in the YAML as inert extras for easy
> reverting — they don't affect anything unless a phase script references them.

### Tuning knobs
- **Rotation speed / direction:** the `id(led_rainbow_rotation) = ... ± 6` line in `Voice Rainbow` and
  `Reply Rainbow` (step `6` per 50ms ≈ 2.1s/turn). Higher step = faster. Voice Rainbow **decrements**,
  Reply Rainbow **increments** — swap the `+`/`-` to flip a ring's direction if it spins the wrong way
  on your unit (CW/CCW depends on the physical wiring).
- **Thinking pulse:** the `0.05f` step and the `0.25f` floor in `Thinking Rainbow` set the breathing
  speed and how dim it dips (0.25 = 25%). Smaller step = slower breath; raise the floor for a subtler dip.
  The pulse scales relative to the brightness the phase script sets, so it dips to 25% **of the lit level**.
- **Warm band:** `warm_min` / `warm_max` in `Warm Rainbow` set the hue range (0 = red, ~21 = orange,
  ~45 = yellow). Widen `warm_max` toward green or narrow it to taste.

---

## Change 4 — Point the voice phases at the effects

In the **`script:`** section, set the `effect:` line inside the four `control_leds_*` phase scripts.
The stock config uses the effect names in the "Stock" column; change them to the "Custom" column.

| Script id                                                  | Stock effect              | → Custom effect      |
|------------------------------------------------------------|---------------------------|----------------------|
| `control_leds_voice_assistant_waiting_for_command_phase`   | `"Waiting for Command"`   | `"Warm Rainbow"`     |
| `control_leds_voice_assistant_listening_for_command_phase` | `"Listening For Command"` | `"Voice Rainbow"`    |
| `control_leds_voice_assistant_thinking_phase`              | `"Thinking"`              | `"Thinking Rainbow"` |
| `control_leds_voice_assistant_replying_phase`              | `"Replying"`              | `"Reply Rainbow"`    |

Each edit is just the one `effect:` line, e.g.:

```yaml
  - id: control_leds_voice_assistant_thinking_phase
    then:
      - light.turn_on:
          brightness: !lambda return max( id(led_ring).current_values.get_brightness() , 0.2f );
          id: voice_assistant_leds
          effect: "Thinking Rainbow"      # was: "Thinking"
```

> The stock effects (`Waiting for Command`, `Listening For Command`, `Thinking`, `Replying`) can be
> left defined in the `effects:` list — they just become unused, which makes reverting easy.

### Resulting behavior
The shared rotation makes Listening → Thinking → Reply one continuous animation:
- **Waiting** → warm ring (red/orange/yellow), counter-clockwise
- **Listening** → full rainbow spinning (decrementing rotation)
- **Thinking** (processing) → the **same** rainbow frozen in place, breathing between 100% and 25%
- **Replying** (speaking the answer) → the rainbow resumes from where Thinking froze it, now spinning
  the **opposite** direction

Error / muted / timer states are left untouched (error = red pulse, etc.).

---

## After re-applying

```
ESPHome → Install   # compiles the YAML, downloads the wake-word model, flashes the device
```
