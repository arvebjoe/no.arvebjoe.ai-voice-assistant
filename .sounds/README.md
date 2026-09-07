# Feedback sounds

Short pre-recorded FLAC clips the app plays on the satellite speaker to give the
user audible feedback when there is no spoken reply to give — mainly error
conditions. They are served straight from this folder on GitHub (raw `main`
URLs), mapped in [`src/helpers/sound-urls.mjs`](../src/helpers/sound-urls.mts).

Keep them **provider-agnostic** — the app supports OpenAI, Gemini, Mistral and a
local pipeline, so no clip should name a specific vendor.

**FLAC is the format to record in.** The satellites fetch these URLs themselves,
and ESPHome compiles in only the decoders its `format:` option asks for — these
firmwares are built for FLAC. A device that routes its reply audio to a Flow has
no speaker of its own, so there the app converts the clip to MP3 itself
(`src/helpers/feedback-sounds.mts`, using the same encoder as reply audio) and
serves it from Homey. Nothing here needs a second file per clip.

| File | Played when |
| --- | --- |
| `wake_word_triggered.flac` | The wake word was detected (start-of-turn chime). |
| `device_connected.flac` | The satellite connected for the first time after successful pairing. |
| `api_key_missing.flac` | The user woke the device but no API key is configured for the selected engine. |
| `agent_not_connected.flac` | The user woke the device but the voice service isn't reachable (network / service down). |
| `error.flac` | Something failed mid-turn (agent error, connection dropped) so the reply will never arrive. |
| `voice_assistant_in_use.flac` | Another API client — in practice Home Assistant — owns the satellite's voice assistant, so it will never hear Homey. **Played through the media player entity, not the announce path** (`esp.playMediaUrl`): the announce path is precisely what a device in this state discards. |

## Placeholders — need real recordings

`device_connected.flac`, `api_key_missing.flac`, `error.flac` and
`voice_assistant_in_use.flac` are currently **copies of
`wake_word_triggered.flac`** so the wiring works end-to-end. Re-record them with
the actual spoken messages before the store release, e.g.:

- `device_connected.flac` — *"I'm connected to Homey and ready to go."*
- `api_key_missing.flac` — *"No API key is set. Please add one in the app settings."*
- `error.flac` — *"Sorry, something went wrong. Please try again."*
- `voice_assistant_in_use.flac` — *"Error. This device is already connected to
  Home Assistant. Check the Homey app for details."*

Naming Home Assistant in that last one does not break the provider-agnostic rule
above: that rule is about the AI engines (OpenAI, Gemini, Mistral, local), and
here Home Assistant is the subject of the message and the thing the user has to
go and change.

**The clips are served from `main`.** `SOUND_BASE` points at
`raw/refs/heads/main/.sounds`, so a clip added on a branch 404s on the device
until that branch lands on `main`.

Any new feedback clip should be added here, wired into `sound-urls.mts`, and
listed in the table above.
