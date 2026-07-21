# Feedback sounds

Short pre-recorded FLAC clips the app plays on the satellite speaker to give the
user audible feedback when there is no spoken reply to give — mainly error
conditions. They are served straight from this folder on GitHub (raw `main`
URLs), mapped in [`src/helpers/sound-urls.mjs`](../src/helpers/sound-urls.mts).

Keep them **provider-agnostic** — the app supports OpenAI, Gemini, Mistral and a
local pipeline, so no clip should name a specific vendor.

| File | Played when |
| --- | --- |
| `wake_word_triggered.flac` | The wake word was detected (start-of-turn chime). |
| `device_connected.flac` | The satellite connected for the first time after successful pairing. |
| `api_key_missing.flac` | The user woke the device but no API key is configured for the selected engine. |
| `agent_not_connected.flac` | The user woke the device but the voice service isn't reachable (network / service down). |
| `error.flac` | Something failed mid-turn (agent error, connection dropped) so the reply will never arrive. |

## Placeholders — need real recordings

`device_connected.flac`, `api_key_missing.flac` and `error.flac` are currently
**copies of `wake_word_triggered.flac`** so the wiring works end-to-end.
Re-record them with the actual spoken messages before the store release, e.g.:

- `device_connected.flac` — *"I'm connected to Homey and ready to go."*
- `api_key_missing.flac` — *"No API key is set. Please add one in the app settings."*
- `error.flac` — *"Sorry, something went wrong. Please try again."*

Any new feedback clip should be added here, wired into `sound-urls.mts`, and
listed in the table above.
