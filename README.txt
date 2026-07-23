Turn ESPHome voice assistant devices into a natural voice interface for Homey. Speak normally to get quick answers, control lights, thermostats, locks and more, set timers and alarms, and keep the conversation going with follow-up questions — no need to repeat the wake word.

You choose the AI engine:
    - OpenAI Realtime — low-latency cloud speech-to-speech, with a choice between the full model (best quality) and the mini model (cheaper and faster).
    - Google Gemini Live — the same real-time pipeline, powered by Gemini.
    - Mistral (Voxtral) — the European alternative on one API key: streaming Voxtral speech recognition that transcribes while you talk, a Mistral chat model, and Voxtral voices.
    - Local / self-hosted — Whisper, Voxtral Realtime, Ollama, LM Studio, Piper, Wyoming and any OpenAI-compatible server. Mix and match per stage; with a fully local setup no audio leaves your network.

The assistant can also search the web for current information (opening hours, departures, what's on at the cinema) using OpenAI web search or the Brave Search API, and it can tell you what it is able to do when you ask for help.

If you use Bring!, you can turn on the optional shopping-list feature in settings and enter your Bring! account details. Then just say "what's on the shopping list?", "add milk" or "take bread off the list". If an item is already there, the assistant asks whether to increase the amount.

Music, too: if you run a Music Assistant server on your network, enable the music feature in settings and point it at the server. Then ask for any artist, album, track, playlist or radio station — "play Abbey Road by the Beatles", "pause", "next song", "what's playing?". The music streams from your server straight to the speaker; asking on a speaker plays it right there, or name another room.

Supported devices:
    - Home Assistant Voice Preview Edition (stock ESPHome firmware, no Home Assistant needed)
    - ThirdReality Voice & Music Assistant (works out of the box, and doubles as a Music Assistant multi-room speaker)
    - XiaoZhi AI devices (running RealDeco's ESPHome firmware)

New device that is not on your Wi-Fi yet? The pairing wizard can set it up for you: choose "Set up Wi-Fi via Bluetooth", Homey finds the device over Bluetooth and sends it your network name and password — no other apps or cables needed (Voice PE and ThirdReality; place the device near your Homey during setup).

Network scan can't find a device that is already on Wi-Fi? Some networks don't pass mDNS/multicast through to the Homey (for example a Wi-Fi-only Homey Pro). Choose "Enter IP address manually" in the pairing wizard and type the device's IP address to add it directly.

Requirements:
    - A compatible ESPHome voice device with microphone and speaker
    - An API key for your chosen cloud engine (OpenAI, Google Gemini or Mistral), or your own local AI services
    - Optional: a Music Assistant server for music playback

Useful Flow cards:
    - "Ask assistant" a question, output as text or spoken on the device.
    - "Say" for quick text-to-speech on the device speaker.
    - "Playback audio from URL", handy for sound effects or pre-recorded messages.
    - Start and cancel timers, and trigger Flows when a timer starts, finishes or is cancelled.
    - "Heard something" and "Thinking" triggers show what the assistant heard, which tools it used and what it replied — pipe them to the timeline or a logger to easily debug your setup.

For troubleshooting or long-term monitoring you can stream the app's logs to your own syslog server (Synology/QNAP log center, rsyslog, Grafana, Papertrail and similar) — enable it in settings, enter the server address and port, and pick how much detail you want.

The assistant speaks your language — English, Dutch, German, French, Italian, Swedish, Norwegian, Spanish, Danish, Russian, Polish and Korean.

Please look in the GitHub repository for setup instructions and more details (link below).
