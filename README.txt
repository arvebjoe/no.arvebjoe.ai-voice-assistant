Turn ESPHome voice assistant devices into a natural voice interface for Homey. Speak normally to get quick answers, control lights, thermostats, locks and more, set timers and alarms, and keep the conversation going with follow-up questions — no need to repeat the wake word.

You choose the AI engine:
    - OpenAI Realtime — low-latency cloud speech-to-speech, with a choice between the full model (best quality) and the mini model (cheaper and faster).
    - Google Gemini Live — the same real-time pipeline, powered by Gemini.
    - Local / self-hosted — Whisper, Voxtral Realtime, Ollama, LM Studio, Piper, Wyoming and any OpenAI-compatible server. Mix and match per stage; with a fully local setup no audio leaves your network.

The assistant can also search the web for current information (opening hours, departures, what's on at the cinema) using OpenAI web search or the Brave Search API, and it can tell you what it is able to do when you ask for help.

If you use Bring!, you can turn on the optional shopping-list feature in settings and enter your Bring! account details. Then just say "what's on the shopping list?", "add milk" or "take bread off the list". If an item is already there, the assistant asks whether to increase the amount.

Supported devices:
    - Home Assistant Voice Preview Edition (stock ESPHome firmware, no Home Assistant needed)
    - XiaoZhi AI devices (running RealDeco's ESPHome firmware)

Requirements:
    - A compatible ESPHome voice device with microphone and speaker
    - An API key for your chosen cloud engine (OpenAI or Google Gemini), or your own local AI services

Useful Flow cards:
    - "Ask assistant" a question, output as text or spoken on the device.
    - "Say" for quick text-to-speech on the device speaker.
    - "Playback audio from URL", handy for sound effects or pre-recorded messages.
    - Start and cancel timers, and trigger Flows when a timer starts, finishes or is cancelled.

The assistant speaks your language — English, Dutch, German, French, Italian, Swedish, Norwegian, Spanish, Danish, Russian, Polish and Korean.

Please look in the GitHub repository for setup instructions and more details (link below).
