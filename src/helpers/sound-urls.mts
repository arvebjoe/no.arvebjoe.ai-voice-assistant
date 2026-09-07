/**
 * Static sound URL constants for the voice assistant.
 *
 * Short pre-recorded FLAC clips played on the satellite speaker to give the user
 * audible feedback when there is no spoken reply to give (mainly error cases).
 * Served straight from the repo's `.sounds/` folder on GitHub (raw `main` URLs).
 * Keep every clip provider-agnostic — the app supports OpenAI, Gemini, Mistral
 * and a local pipeline, so no message should name a specific vendor. See
 * `.sounds/README.md` for the catalogue and re-recording notes.
 */

const SOUND_BASE = "https://github.com/arvebjoe/no.arvebjoe.ai-voice-assistant/raw/refs/heads/main/.sounds";

export const SOUND_URLS = {
  // Wake word detected — start-of-turn chime.
  wake_word_triggered: `${SOUND_BASE}/wake_word_triggered.flac`,
  // Played once when the satellite first connects after successful pairing, so
  // the user hears that it is now linked to Homey.
  device_connected: `${SOUND_BASE}/device_connected.flac`,
  // No API key configured for the selected engine (generic, not OpenAI-specific).
  api_key_missing: `${SOUND_BASE}/api_key_missing.flac`,
  // Voice service unreachable (network down / service unavailable).
  agent_not_connected: `${SOUND_BASE}/agent_not_connected.flac`,
  // Generic "something went wrong" — a turn failed mid-flight (agent error,
  // connection dropped) so the reply the user is waiting for will never arrive.
  error: `${SOUND_BASE}/error.flac`,
  // Another API client (in practice Home Assistant) owns the satellite's voice
  // assistant, so it will never hear us. Naming Home Assistant does not break
  // the provider-agnostic rule above — that is about the AI engines; here it is
  // the subject of the message and the thing the user has to go and change.
  // NOTE: this clip must be played through the MEDIA PLAYER entity
  // (esp.playMediaUrl), never the announce path, which is exactly what the
  // device in this state discards.
  voice_assistant_in_use: `${SOUND_BASE}/voice_assistant_in_use.flac`,
} as const;

export type SoundUrlKey = keyof typeof SOUND_URLS;

/**
 * What each clip is about, for the `text` tag of the "Reply audio is ready"
 * trigger — a device that routes its reply audio to a Flow gets these sounds as
 * a URL instead of playing them (see `feedback-sounds.mts`).
 *
 * Deliberately a label of the *event*, not a transcript: a Flow can log it or
 * speak it through its own TTS, and it stays true if a clip is re-recorded.
 */
export const SOUND_TEXTS: Record<SoundUrlKey, string> = {
  wake_word_triggered: 'Wake word detected',
  device_connected: 'Connected to Homey',
  api_key_missing: 'No API key is configured',
  agent_not_connected: 'The voice service is not reachable',
  error: 'Something went wrong',
  voice_assistant_in_use: 'Another app is using this device',
};
