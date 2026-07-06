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

### Training the model (microwakeword.com)

> ⚠️ **USE MULTIPLE TTS VOICES — a single-voice training set tanks recall.** The first `hey_homey`
> attempt was trained on **Norwegian, which offers only one Piper voice**, and scored **5% recall**
> (it woke ~1 in 20 times — unusable). A single voice gives the trainer no acoustic variety, so the
> model overfits to that one speaker's timbre/prosody and fails to generalize to a real human voice.
> **Voice diversity is the single biggest lever for wake-word recall.**
>
> Fix: train on **English (US), which has ~10 Piper voices**, and spell the wake word so the English
> voices pronounce it the way you actually say it — e.g. **"Hey Homey"** (the Norwegian "Hei Homey"
> is a near-homophone, so English voices match your real pronunciation while giving 10× the variety).

**Recommended training settings** (microwakeword.com, benchmark-validated for ESP32-S3):

| Setting                  | Value            | Notes |
|--------------------------|------------------|-------|
| Voice composition        | English (US), all voices | Multiple voices is the whole point — see warning above. |
| Number of samples        | 40,000           | Recommended sweet spot. |
| Augmentation rounds      | 2                | Adds room acoustics / background noise variation. |
| Adversarial samples      | 0                | The tool itself notes adversarials **suppress recall** — leave off. |
| Training steps           | 12,000           | Recommended. |
| Negative Class Weight    | 10–20            | This is the "Penalty" column on the results screen. In theory: lower = more recall + more false accepts, higher = stricter (range 10 → 2000). **In practice the two runs below didn't follow that rule** (see note), so don't treat it as a precise dial — pick something in the 10–20 range and judge by results. |
| Learning rate            | 0.001 (default)  | Leave. |

If a Manual run still lands low, switch the training mode to **Optuna Optimization** to auto-search
hyperparameters instead of guessing.

### Observed runs (Hey Homey, English US)

| Run    | Penalty | Steps  | FA/H | Recall (synthetic) |
|--------|---------|--------|------|--------------------|
| Jun 22 | 20      | 12,000 | 1.9  | 5.0%               |
| Jun 27 | 10      | 12,000 | 0.4  | 2.6%               |

> ⚠️ **Don't over-read these two runs.** Going from penalty 20 → 10 gave *fewer* false accepts (1.9 →
> 0.4) **and** lower reported recall (5.0% → 2.6%) — the opposite of the "lower penalty = more recall +
> more false accepts" theory on *both* axes. Two single runs can't establish a trend; this is almost
> certainly run-to-run training variance, not the penalty doing something. If you care which penalty
> is better, run each value a few times and compare, don't trust one run.

### What "good" actually looks like — trust real voice, not the synthetic number

The recall percentages the site reports (single digits, above) are measured against **synthetic TTS
voices**, and they have been suspiciously low across every run — well below the ~80% you'd normally
want from a wake word. Either the site's synthetic-recall metric is stricter / measured differently
than plain "how often it wakes," or these models genuinely under-detect. **We don't fully understand
the metric yet, so the source of truth is real-world behaviour:**

1. **Use the "Test" button with your own voice** on the model before flashing — say "Hey Homey" 10–20
   times and count how often it wakes. That hit rate matters more than the displayed recall number.
2. Then **flash it and live with it for a day.** Does it wake when you want and stay quiet otherwise?
3. Prefer a **low FA/H** (green on the results screen) — a wake word that fires randomly is more
   annoying than one you occasionally have to repeat.

Training is cheap (~200 credits per run), so iterate. If real-world use is poor, come back to this and
revisit the metric / settings rather than chasing the synthetic recall figure.

### Tuning sensitivity without retraining — `probability_cutoff`

The `micro.probability_cutoff` value in `hey_homey.json` is the **per-model sensitivity knob**, and you
can change it and re-flash **without any new training run**. It's the confidence score (0–1) the model
must clear before it wakes:

- **Higher (e.g. `0.98`)** = stricter → wakes less easily, almost never false-fires.
- **Lower (e.g. `0.95` or below)** = more lenient → wakes more readily, more false wakes.

This single setting explains most of the gap between the two runs above — the Jun 27 manifest ships
`0.98` vs the Jun 22 manifest's `0.95`, so a big part of the "lower recall" is just the stricter
threshold, not a worse model. **If Hey Homey is too deaf in real use, lower this toward 0.95 and below
before assuming the model is bad.** (Current shipped value: **`0.98`**.)

> ⚠️ **The device's "wake word sensitivity" selector does NOT affect Hey Homey.** That select's lambda
> (in `home-assistant-voice.yaml`) only calls `set_probability_cutoff` on `okay_nabu`, `hey_jarvis`,
> and `hey_mycroft`. For Hey Homey the manifest's `probability_cutoff` is the only sensitivity control —
> to make the UI selector affect it too, you'd have to add `hey_homey` to that lambda.

> **Remember:** the device downloads the model from `raw.githubusercontent.com/.../main/...` at compile
> time, **not** from your local folder — so any manifest edit only takes effect after it's committed and
> pushed to `main` and the device is re-flashed.

---

## Change 2 — Shared rainbow rotation + white-level globals

The four rainbow voice-phase effects (Waiting / Listening / Thinking / Reply) share a single rotation
value so the rainbow keeps its position across phase changes — Waiting shows it dark and static,
Listening spins it, Thinking freezes it and fades to white, Reply keeps it stationary (a white pulse
travels around it instead), and the next Waiting picks up the exact same position. This only works if
the rotation lives in a **global** instead of each effect's own `static` variable. A second global
hands the current white brightness from Thinking to Reply so the white→rainbow fade starts from the
exact white the ring is showing.

In the **`globals:`** section, add these entries (next to `global_led_animation_index` is fine):

```yaml
  # Shared rotation for the rainbow voice-phase effects (Waiting/Voice/Thinking/Reply Rainbow).
  # Kept global so the rainbow keeps its position across phase changes: Waiting shows it dark and
  # static, Listening spins it, Thinking freezes it and fades to white, Reply keeps it stationary
  # (a white pulse travels instead) — so the next Waiting picks up the exact same position.
  - id: led_rainbow_rotation
    type: uint8_t
    restore_value: no
    initial_value: '0'
  # White level the Thinking effect is currently breathing at (0.6 - 1.0). Reply Rainbow reads it
  # on entry so its fade back to the rainbow starts from the exact white the ring is showing.
  - id: led_white_level
    type: float
    restore_value: no
    initial_value: '1.0'
```

> `uint8_t` matters: it wraps 0→255 automatically, so `rotation - 6` stays valid without any modulo.
> The hue math (`i * 256 / 12 + rotation`) assumes this 0–255 range.

---

## Change 3 — Custom LED ring effects

In the **`light:`** section, under the `voice_assistant_leds` partition light's `effects:` list, add the
effects below. Insert them anywhere in the list — next to the existing `"Replying"` / `"Muted or Silent"`
effects is fine.

All four effects read `id(led_rainbow_rotation)` (Change 2), but only `Voice Rainbow` advances it —
`Waiting Rainbow`, `Thinking Rainbow` and `Reply Rainbow` deliberately leave it untouched, which is
what makes the ring position carry over from phase to phase. **The four lambdas are long — copy them
from the `effects:` list in this repo's `home-assistant-voice.yaml`** (search for the effect names)
rather than from this doc. What each one does:

| Effect             | Phase     | Behavior |
|--------------------|-----------|----------|
| `Waiting Rainbow`  | Waiting   | Dark (35%) rainbow, **not rotating**, at the shared rotation; eases down from full brightness on entry. |
| `Voice Rainbow`    | Listening | Full rainbow rotating clockwise (`rotation - 6` per 50ms ≈ 2.1s/turn). No reset on entry — continues from the shared rotation. |
| `Thinking Rainbow` | Thinking  | Rotation stops; the frozen rainbow fades up to full white (~0.65s), then the white breathes 100% → 60% → 100% (~2s). Publishes its current level to `led_white_level`. |
| `Reply Rainbow`    | Replying  | Fades from the white Thinking was showing back to the full rainbow, held **stationary**; then a white pulse travels **counter-clockwise** around the ring (~1.7s/lap). |

Because Reply never advances the rotation, the Waiting phase that follows shows the ring in exactly
the position Reply had — every transition is seamless while each phase stays visually distinct.

> The older **Cold Rainbow** / **Warm Rainbow** (hue-band rings) and **Thinking White** effects were
> superseded by this design and have been removed from the YAML. They still exist in
> `home-assistant-voice-debug.yaml` if you want them back.

### Tuning knobs
- **Rotation speed / direction:** the `id(led_rainbow_rotation) - 6` line in `Voice Rainbow`
  (step `6` per 50ms ≈ 2.1s/turn). Higher step = faster; flip to `+` if it spins the wrong way on
  your unit (CW/CCW depends on the physical wiring).
- **Waiting darkness:** `dark_level` in `Waiting Rainbow` (0.35 = 35%); the `0.05f` step sets how
  fast it eases down.
- **Thinking breath:** the `0.02f` step and `0.6f` floor in `Thinking Rainbow` set breathing speed
  and how dim the white dips; the `0.08f` blend step sets the initial fade-to-white speed.
- **Reply pulse:** `0.35f` per frame is the pulse's travel speed (≈1.7s/lap; negate it to reverse
  direction), `d < 2.0f` its width (LEDs each side), and `* 0.9f` its whiteness strength.

---

## Change 4 — Point the voice phases at the effects

In the **`script:`** section, set the `effect:` line inside the four `control_leds_*` phase scripts.
The stock config uses the effect names in the "Stock" column; change them to the "Custom" column.

| Script id                                                  | Stock effect              | → Custom effect      |
|------------------------------------------------------------|---------------------------|----------------------|
| `control_leds_voice_assistant_waiting_for_command_phase`   | `"Waiting for Command"`   | `"Waiting Rainbow"`  |
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
The shared rotation makes the whole conversation one continuous animation:
- **Waiting** → dark rainbow, **not rotating**
- **Listening** → the same rainbow at full brightness, spinning clockwise
- **Thinking** (processing) → rotation stops, the frozen rainbow fades to white, the white breathes
  between 100% and 60%
- **Replying** (speaking the answer) → the white fades back to the full rainbow, which stays
  **stationary** while a white pulse travels **counter-clockwise** around it
- back to **Waiting** → the ring just dims, keeping the exact position Reply had

Error / muted / timer states are left untouched (error = red pulse, etc.).

### Debug phase colors (kept as inert extras; full debug config in `home-assistant-voice-debug.yaml`)

For diagnosing the conversation flow, four **solid-color debug effects** remain defined in the
`effects:` list (right after `Reply Rainbow`), and `home-assistant-voice-debug.yaml` is a full copy
of the config with the phase scripts pointed at them — flash that file when phase transitions need
to be unambiguous at a glance:

| Phase script                                               | Debug effect        | Color            |
|------------------------------------------------------------|---------------------|------------------|
| `control_leds_voice_assistant_waiting_for_command_phase`   | `"Debug Waiting"`   | solid **amber**  |
| `control_leds_voice_assistant_listening_for_command_phase` | `"Debug Listening"` | solid **green**  |
| `control_leds_voice_assistant_thinking_phase`              | `"Debug Thinking"`  | solid **blue**   |
| `control_leds_voice_assistant_replying_phase`              | `"Debug Replying"`  | solid **red**    |

Amber = mic open but no speech detected yet (`on_listening`), green = the PE's on-device VAD hears
speech (`on_stt_vad_start`), blue = intent/LLM working (`on_stt_vad_end`), red = TTS playback.
Amber→green *before the user speaks* on a follow-up turn = the TTS echo tripped the local VAD.
Note: solid red is *steady*; the Error effect is a fast red *pulse*, so they remain distinguishable.

**To switch the main config to debug colors** without flashing the debug file: point the four
`effect:` lines at the `Debug *` names above; revert by setting them back to the "Custom" column of
the Change 4 table.

---

## Change 5 — Mic gain for command capture (auto gain) — currently `6 dbfs`

> ⚠️ **Currently `6 dbfs` — a deliberate compromise. Do NOT return to `15`.** History:
> - `15 dbfs` (commit c6ee5a0) over-amplified close/normal speech and **clipped it**, adding audible
>   distortion to the STT recording — which hurt recognition more than low volume did.
> - `0 dbfs` (stock, AGC off) sounded clean, but left the **start of each recording quiet**: the PE's
>   **XMOS XU316 hardware AGC** (in the `ffva` XMOS firmware, separate from this software knob and not
>   controllable from YAML) has an attack ramp that was previously masked by the software boost.
> - `6 dbfs` lifts the overall level enough to soften that quiet start **without clipping**.
>
> If quiet/distant speech is still too low, nudge to `9 dbfs` and re-check the `input_buffer_debug`
> recording for clipping first. Never jump back to `15`.

In the **`voice_assistant:`** block:

```yaml
voice_assistant:
  ...
  noise_suppression_level: 0
  auto_gain: 6 dbfs        # compromise: lift level without clipping. NOT 15 (clipped), NOT 0 (quiet start under XMOS AGC ramp).
  volume_multiplier: 1
```

> This is the **software** AGC knob (runs on the ESP32) — distinct from the **XMOS hardware AGC** that
> runs first and causes the start-of-recording volume ramp (baked into the XMOS firmware, no YAML knob).
> Too high clips loud/close speech; prefer fixing genuinely low volume by mic placement first.

### Tuning knobs (same block)
- **`auto_gain`** — `0`–`31 dbfs`. Higher = more amplification of quiet/distant speech, but also
  clips loud/close speech. Currently `6` (compromise after `15` distorted and `0` left a quiet start) —
  if you raise it, go gradually (`6`→`9`) and verify no clipping in the debug recording; never `15`.
- **`volume_multiplier`** — flat multiplier on mic samples (default `1`). Cruder than AGC and also
  boosts noise. Avoid stacking a large multiplier on top of high `auto_gain` — they clip together
  and *hurt* recognition.
- **`noise_suppression_level`** — `0`–`4`. Raise to ~`2` only if the problem is background noise
  rather than low volume; too high eats quiet speech.

---

## After re-applying

```
ESPHome → Install   # compiles the YAML, downloads the wake-word model, flashes the device
```
