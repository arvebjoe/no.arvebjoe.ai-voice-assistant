# Custom pipeline — setup guide for every stage

The **Custom pipeline** (the `local` voice provider) chains three independent stages:

```
mic audio ─▶ STT (speech-to-text) ─▶ LLM (language model) ─▶ TTS (text-to-speech) ─▶ speaker
```

Each stage is **pluggable and mixed independently**, so a valid setup can be all-local
(Whisper + Ollama + Piper), all-cloud (Voxtral + Mistral + Voxtral), or anything in
between (e.g. local Whisper → cloud Mistral LLM → local Piper). Voice-activity detection
runs **in the app on the Homey** — there is no server VAD to configure locally.

This guide gives a working recipe for **every backend of every stage**, with Docker
Compose where a server is involved and desktop-app instructions for Ollama and LM Studio.

---

## Before you start — the one gotcha that trips everyone

**Your Homey is a separate box on the network.** When you type a *Host* into the Custom
pipeline settings, it is the Homey — not your PC — that connects to it. So:

- **Never use `localhost` / `127.0.0.1`** in the settings. Use the **LAN IP** of the machine
  running the server, e.g. `192.168.1.50`. (A hostname works only if your Homey can resolve it.)
- The server must **listen on all interfaces**, not just loopback. In Docker this is the
  default once you publish a port (`ports:`); for the Ollama/LM Studio desktop apps it is an
  explicit toggle (below).
- The host's **firewall** must allow the port from your LAN.

Every "Test" button on the settings page fires a *real* mini-request from the Homey, so a
wrong IP, port, model or key shows up immediately with the actual error and latency. Use them.

---

## Fast reference — which setting each backend uses

| Stage | Backend (dropdown) | Settings you fill in | Default port |
|---|---|---|---|
| **STT** | Whisper — HTTP (local) | Host, Port | 9000 |
| | Wyoming — faster-whisper (local) | Host, Port | 10300 |
| | Mistral Voxtral (cloud) | Mistral API key, Model | — |
| | Mistral Voxtral Realtime (cloud) | Mistral API key, Model | — |
| | OpenAI-compatible (cloud/custom) | Base URL, API key, Model | — |
| **LLM** | Ollama (local) | Host, Port, Model, Context window | 11434 |
| | LM Studio (local) | Host, Port, Model | 1234 |
| | Mistral (cloud) | Mistral API key, Model | — |
| | OpenAI-compatible (cloud/custom) | Base URL, API key, Model | — |
| **TTS** | Piper — HTTP (local) | Host, Port | 5000 |
| | Wyoming — Piper (local) | Host, Port | 10200 |
| | Mistral Voxtral (cloud) | Mistral API key, Model, Voice | — |
| | OpenAI-compatible (cloud/custom) | Base URL, API key, Model, Voice override | — |

All Mistral-backed stages share the **one** `Mistral API key` field at the top of the
Custom pipeline section.

---

## The recommended fully-local stack (copy-paste)

This single Compose file gives you all three local stages at once: Whisper (STT) + Ollama
(LLM) + Piper (TTS). It's the fastest way to a 100%-private assistant. Put it in a file
called `docker-compose.yml` on the machine that will host the services (a NAS, a mini-PC,
a spare desktop), then `docker compose up -d`.

```yaml
services:
  # ── Speech-to-text: whisper-asr-webservice (port 9000) ──────────────
  whisper:
    image: onerahmet/openai-whisper-asr-webservice:latest
    ports:
      - "9000:9000"
    environment:
      ASR_MODEL: base            # tiny | base | small | medium | large-v3
      ASR_ENGINE: faster_whisper # fast CPU/GPU engine
    volumes:
      - whisper-cache:/root/.cache
    restart: unless-stopped

  # ── Language model: Ollama (port 11434) ─────────────────────────────
  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ollama:/root/.ollama
    restart: unless-stopped
    # For NVIDIA GPU, uncomment:
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: all
    #           capabilities: [gpu]

  # ── Text-to-speech: Piper HTTP (port 5000) ──────────────────────────
  piper:
    image: artibex/piper-http:latest
    ports:
      - "5000:5000"
    environment:
      # Pick any Piper voice: https://github.com/rhasspy/piper/blob/master/VOICES.md
      PIPER_VOICE: en_US-lessac-medium
    restart: unless-stopped

volumes:
  whisper-cache:
  ollama:
```

After it's up, pull a tool-calling model into Ollama once:

```bash
docker compose exec ollama ollama pull qwen3:8b
```

Then in the app (Settings → **Custom pipeline**), with the host IP as `192.168.1.50`:

| Stage | Backend | Host | Port | Model |
|---|---|---|---|---|
| STT | Whisper — HTTP | `192.168.1.50` | `9000` | — |
| LLM | Ollama | `192.168.1.50` | `11434` | `qwen3:8b` |
| TTS | Piper — HTTP | `192.168.1.50` | `5000` | — |

Hit each **Test** button, then **Save**. Done.

The rest of this guide covers every alternative for each stage.

---

## Stage 1 — Speech-to-text (STT)

### 1a. Whisper over HTTP *(local, default)*

The app auto-detects the three common Whisper HTTP flavors — you don't choose one, just
point it at the server and it figures out the dialect on the first request:

| Server | Endpoint style | Typical port |
|---|---|---|
| `onerahmet/openai-whisper-asr-webservice` | `/asr` | 9000 |
| speaches / faster-whisper-server / LocalAI | `/v1/audio/transcriptions` | 8000 |
| whisper.cpp server | `/inference` | 8080 |

**whisper-asr-webservice (recommended — matches the default port 9000):**

```yaml
services:
  whisper:
    image: onerahmet/openai-whisper-asr-webservice:latest
    ports:
      - "9000:9000"
    environment:
      ASR_MODEL: base            # tiny/base = fast; small/medium = more accurate
      ASR_ENGINE: faster_whisper
    volumes:
      - whisper-cache:/root/.cache
    restart: unless-stopped
volumes:
  whisper-cache:
```

**speaches (OpenAI-dialect Whisper, also works here):**

```yaml
services:
  speaches:
    image: ghcr.io/speaches-ai/speaches:latest-cpu   # or :latest-cuda for NVIDIA
    ports:
      - "8000:8000"
    volumes:
      - speaches:/home/ubuntu/.cache/huggingface
    restart: unless-stopped
volumes:
  speaches:
```

> Settings for speaches: STT backend = **Whisper — HTTP**, Host = your LAN IP, **Port = 8000**
> (the app detects the `/v1/audio/transcriptions` style automatically). You could also use the
> **OpenAI-compatible** STT backend instead with Base URL `http://192.168.1.50:8000/v1`.

**Settings:** STT backend = **Whisper — HTTP (local)**, Host = LAN IP, Port = the server's
port. No authentication — keep it on a trusted LAN.

---

### 1b. Wyoming faster-whisper *(local, Home Assistant ecosystem)*

Raw-TCP Wyoming protocol (not HTTP) — the same `rhasspy/wyoming-whisper` image Home Assistant
uses. The model and language are whatever the server was started with.

```yaml
services:
  wyoming-whisper:
    image: rhasspy/wyoming-whisper:latest
    command: --model base --language en
    ports:
      - "10300:10300"
    volumes:
      - whisper-data:/data
    restart: unless-stopped
volumes:
  whisper-data:
```

**Settings:** STT backend = **Wyoming — faster-whisper (local)**, Host = LAN IP, Port = `10300`.

---

### 1c. Mistral Voxtral *(cloud, batch)*

No server to run — Mistral transcribes in the cloud. Your voice clips are sent to Mistral.

1. Get a key at [console.mistral.ai](https://console.mistral.ai) and paste it into the single
   **Mistral API key** field.
2. STT backend = **Mistral Voxtral (cloud API)**.
3. Model — leave empty for `voxtral-mini-latest`, or pin another id.

---

### 1d. Mistral Voxtral Realtime *(cloud, streaming websocket)*

Same key, but a streaming transcription websocket (sub-500 ms) — the transcript is ready the
moment you stop talking.

- STT backend = **Mistral Voxtral Realtime (cloud, streaming)**.
- Model — empty = `voxtral-mini-transcribe-realtime-2602`.

---

### 1e. OpenAI-compatible STT *(cloud or custom server)*

Anything speaking OpenAI's `/audio/transcriptions` API: OpenAI itself, Groq, speaches, etc.
A bare host gets `/v1` appended automatically.

**Groq (very fast, cloud):**

- STT backend = **OpenAI-compatible (cloud or custom)**
- Base URL = `https://api.groq.com/openai/v1`
- API key = your Groq key
- Model = `whisper-large-v3-turbo`

**OpenAI (cloud):**

- Base URL = `https://api.openai.com/v1`
- API key = your OpenAI key
- Model = `gpt-4o-transcribe` (or `whisper-1`)

**Keyless local server:** leave the API key empty and point Base URL at your LAN server
(e.g. `http://192.168.1.50:8000/v1`).

---

## Stage 2 — Language model (LLM)

The LLM must support **tool calling** — that's how the assistant controls your home. Pick a
tool-calling model or the assistant can't do anything.

### 2a. Ollama *(local, default)*

**As a Docker service:**

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ollama:/root/.ollama
    restart: unless-stopped
volumes:
  ollama:
```

Pull a tool-calling model once:

```bash
docker compose exec ollama ollama pull qwen3:8b
# other good choices: llama3.1, gpt-oss, mistral-nemo
```

**As the Ollama desktop app (macOS / Windows / Linux):** by default it listens on
`127.0.0.1` only, which your Homey **cannot** reach. Make it listen on the LAN:

- **macOS/Windows:** set the environment variable `OLLAMA_HOST=0.0.0.0` and restart Ollama.
  (macOS: `launchctl setenv OLLAMA_HOST "0.0.0.0"` then restart the app; Windows: add
  `OLLAMA_HOST = 0.0.0.0` under *System → Environment Variables* and restart.)
- Allow port `11434` through the machine's firewall.

**Settings:** LLM backend = **Ollama**, Host = LAN IP, Port = `11434`, Model = e.g. `qwen3:8b`
(empty = first installed model). Leave **Context window (num_ctx)** at `8192` — Ollama's own
default (4096) is too small for the assistant's instructions and it silently truncates them.

---

### 2b. LM Studio *(local desktop app)*

1. Open LM Studio → download a **tool-calling** model (e.g. Qwen2.5-Instruct, Llama-3.1-Instruct).
2. Go to the **Developer** tab (the terminal icon), load the model, and **Start Server**.
3. Enable **"Serve on Local Network"** so the Homey can reach it (otherwise it binds to
   localhost only). Default port `1234`.

**Settings:** LLM backend = **LM Studio**, Host = LAN IP, Port = `1234`, Model — leave empty to
use whatever model is loaded, or type its id. The app reads LM Studio's configured context
window back live, so the token-budget bar in settings tells you if everything fits.

---

### 2c. Mistral *(cloud)*

- LLM backend = **Mistral (cloud API)**, same shared Mistral key.
- Model — empty = `mistral-small-latest`; any tool-calling Mistral model works
  (`mistral-medium-latest`, `mistral-large-latest`). Only the conversation text goes to Mistral.

---

### 2d. OpenAI-compatible LLM *(cloud or custom server)*

Any server speaking OpenAI's `/chat/completions` **with tool calling**. Model is **required**
here. A bare host gets `/v1` appended.

**Groq (cloud, fast):**

- Base URL = `https://api.groq.com/openai/v1`, key = your Groq key, Model = `llama-3.3-70b-versatile`

**OpenRouter / DeepSeek / OpenAI (cloud):**

- OpenRouter: `https://openrouter.ai/api/v1` · DeepSeek: `https://api.deepseek.com` ·
  OpenAI: `https://api.openai.com/v1` (Model e.g. `gpt-5-mini`)

**Self-hosted OpenAI-compatible servers** — llama.cpp, vLLM, or the Jan desktop app all work
through this backend:

```yaml
# llama.cpp server (OpenAI-compatible at /v1)
services:
  llamacpp:
    image: ghcr.io/ggml-org/llama.cpp:server
    ports:
      - "8080:8080"
    volumes:
      - ./models:/models
    command: >
      -m /models/qwen2.5-7b-instruct-q4_k_m.gguf
      --host 0.0.0.0 --port 8080 --jinja
    restart: unless-stopped
```

```yaml
# vLLM (OpenAI-compatible at /v1, NVIDIA GPU)
services:
  vllm:
    image: vllm/vllm-openai:latest
    ports:
      - "8000:8000"
    command: >
      --model Qwen/Qwen2.5-7B-Instruct
      --enable-auto-tool-choice --tool-call-parser hermes
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    restart: unless-stopped
```

> **Jan desktop app:** enable its local API server (Settings → Local API Server), default port
> `1337`. Then LLM backend = **OpenAI-compatible**, Base URL = `http://192.168.1.50:1337/v1`,
> no key, Model = the loaded model id. Make sure the chosen model supports tools.

For all of these: Base URL = `http://<LAN-IP>:<port>/v1`, API key empty (keyless local),
Model = the served model id. `--jinja` (llama.cpp) / `--enable-auto-tool-choice` (vLLM) are what
turn on tool calling — without them the assistant can't control the home.

---

## Stage 3 — Text-to-speech (TTS)

### 3a. Piper over HTTP *(local, default)*

The app auto-detects Piper's `/synthesize` and `/` request shapes. The spoken voice is the
model the server was started with.

**artibex/piper-http (recommended — default port 5000):**

```yaml
services:
  piper:
    image: artibex/piper-http:latest
    ports:
      - "5000:5000"
    environment:
      PIPER_VOICE: en_US-lessac-medium   # see VOICES.md for the full list
    restart: unless-stopped
```

Pick a voice for your language from the
[Piper VOICES list](https://github.com/rhasspy/piper/blob/master/VOICES.md) (e.g.
`no_NO-talesyntese-medium`, `de_DE-thorsten-medium`). If the server exposes `GET /voices`, the
app can pass a per-request voice from the **Voice** dropdown in General; otherwise it uses the
server's default voice.

**Settings:** TTS backend = **Piper — HTTP (local)**, Host = LAN IP, Port = `5000`.

---

### 3b. Wyoming Piper *(local, Home Assistant ecosystem)*

The `rhasspy/wyoming-piper` image (raw TCP, port 10200). The voice is whatever the server was
started with.

```yaml
services:
  wyoming-piper:
    image: rhasspy/wyoming-piper:latest
    command: --voice en_US-lessac-medium
    ports:
      - "10200:10200"
    volumes:
      - piper-data:/data
    restart: unless-stopped
volumes:
  piper-data:
```

**Settings:** TTS backend = **Wyoming — Piper (local)**, Host = LAN IP, Port = `10200`.

---

### 3c. Mistral Voxtral TTS *(cloud)*

- TTS backend = **Mistral Voxtral (cloud API)**, shared Mistral key.
- Model — empty = `voxtral-mini-tts-2603`.
- **Voice:** save the Mistral key first, then the **Voice** dropdown in General fills in with
  Mistral's live voice library on Save — pick one there. (Voxtral voices are UUIDs fetched from
  Mistral; the open-weights preset names don't work against the live API.)

---

### 3d. OpenAI-compatible TTS *(cloud or custom server)*

Any server speaking OpenAI's `/audio/speech` API. A bare host gets `/v1` appended.

**Kokoro (local, self-hosted, free):**

```yaml
services:
  kokoro:
    image: ghcr.io/remsky/kokoro-fastapi-cpu:latest   # or -gpu for NVIDIA
    ports:
      - "8880:8880"
    restart: unless-stopped
```

- TTS backend = **OpenAI-compatible**, Base URL = `http://192.168.1.50:8880/v1`, API key empty,
  Model = `kokoro`, **Voice override** = e.g. `af_heart` (Kokoro's voices aren't OpenAI's, so type
  the name in the override field — it wins over the General dropdown).

**OpenAI (cloud):**

- Base URL = `https://api.openai.com/v1`, key = your OpenAI key, Model = `gpt-4o-mini-tts`,
  and pick a standard voice (Alloy, Nova, …) in the **Voice** dropdown in General — leave the
  override empty.

---

## Putting it together — some proven combinations

| Goal | STT | LLM | TTS |
|---|---|---|---|
| **100% private, no cloud** | Whisper HTTP | Ollama (`qwen3:8b`) | Piper HTTP |
| **Home Assistant boxes reused** | Wyoming faster-whisper | Ollama or LM Studio | Wyoming Piper |
| **Best local quality, some cloud** | Whisper HTTP | Mistral / Groq (cloud) | Piper HTTP |
| **Lowest latency, all cloud** | Voxtral Realtime | Groq or Mistral | Voxtral / OpenAI |
| **Desktop-app only, no Docker** | (cloud STT) | Ollama or LM Studio desktop | (cloud TTS) |

You can change any single stage without touching the others — the app rebuilds only the stage
whose settings changed and re-runs its health check.

---

## Networking & troubleshooting checklist

- **"Not connected" / timeout on Test** → wrong IP or port, or the server binds to loopback.
  Confirm from another machine: `curl http://<LAN-IP>:<port>/` should answer. For the Ollama
  desktop app, set `OLLAMA_HOST=0.0.0.0`; for LM Studio, enable *Serve on Local Network*.
- **Firewall** → open the port to your LAN on the host machine.
- **STT works, but the assistant does nothing** → the LLM model doesn't support tool calling.
  Switch to a tool-calling model (Qwen2.5/3, Llama-3.1, gpt-oss, Mistral) and, for
  llama.cpp/vLLM, enable the tool-call flags shown above.
- **Model "forgets" its rules on Ollama** → context window too small. Keep **num_ctx** at 8192+.
- **Wrong / silent voice** → the voice id isn't installed on the Piper server, or (Voxtral) the
  key wasn't saved before picking a voice. Re-save, then choose from the refreshed dropdown.
- **GPU** → uncomment the `deploy.resources` block (NVIDIA) for Whisper/Ollama/vLLM to cut
  latency dramatically; CPU works but is slower on larger models.

Use the per-stage **Test** buttons after every change — they report the real error and the
round-trip latency straight from your Homey.
```
