# Running Music Assistant for this app

The voice-controlled music feature (main [README](../../README.md#playing-music-music-assistant))
needs a [Music Assistant](https://www.music-assistant.io/) (MA) **2.7+** server on your network.
This folder has a ready-to-run [`docker-compose.yml`](./docker-compose.yml) for it.

> Already running Home Assistant? You can install MA as an HA **add-on** instead and skip Docker
> entirely — the app doesn't care which way the server runs, only that it's reachable on the LAN.

## Start it

On any always-on machine (NAS, Raspberry Pi, mini-PC) on the **same LAN** as your speakers:

```bash
cd docs/music-assistant
docker compose up -d
```

MA state lands in `./music-assistant-data/` next to the compose file. Update later with
`docker compose pull && docker compose up -d`.

## Configure it

1. Open the web UI at `http://<host-ip>:8095`.
2. **Settings → Music Providers** — add Spotify, Apple Music, local files, radio, …
3. **Settings → Player Providers** — make sure **Sendspin** is enabled (it ships as a technical
   preview). The Voice PE (stock 26.x firmware) and the ThirdReality speaker are discovered on the
   LAN automatically and appear as players.
4. **MA 2.9+ requires an API token:** in the MA web UI, open your **profile** and create a
   **long-lived token** (the WebSocket API rejects unauthenticated clients since API schema 28).
5. In this Homey app's settings, enable **Music Assistant**, enter `<host-ip>` (port 8095) and
   paste the token.

Then just ask a speaker: *"play Abbey Road by the Beatles"*.

## Notes

- `network_mode: host` is not optional: MA relies on mDNS/multicast for player discovery and
  serves the audio streams itself (web UI/API on TCP **8095**, stream server on TCP **8097/8098**).
- The `cap_add`/`apparmor` entries are only needed for mounting SMB/NFS music shares from inside
  MA — remove them if you don't use network shares.
- The audio path is MA server → speaker (Sendspin). Homey and this app only send control
  commands, so the Docker host's horsepower, not Homey's, does the transcoding.
