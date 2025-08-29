/**
 * Static sound URL constants for the voice assistant
 */

export const SOUND_URLS = {  
  wake_word_triggered: "https://github.com/arvebjoe/no.arvebjoe.ai-voice-assistant/raw/refs/heads/main/.sounds/wake_word_triggered.flac",
  missing_api_key: "https://github.com/arvebjoe/no.arvebjoe.ai-voice-assistant/raw/refs/heads/main/.sounds/please_set_api_key.flac",
  agent_not_connected: "https://github.com/arvebjoe/no.arvebjoe.ai-voice-assistant/raw/refs/heads/main/.sounds/agent_not_connected.flac"
} as const;

export type SoundUrlKey = keyof typeof SOUND_URLS;
