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
} as const;

export type SoundUrlKey = keyof typeof SOUND_URLS;
