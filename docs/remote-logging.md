# Remote logging (syslog)

The app can stream its logs to any syslog server on your network. This exists because the
in-app Homey log is deliberately quiet — most subsystem loggers are disabled so the app log
stays readable — but when something misbehaves you want *everything*: the ESP connection
chatter, every provider event, every tool call. Remote logging captures all of that on a
collector without making the in-app log noisy.

This document explains how the feature works internally, and how to run a free, open-source
log server with a web UI ([VictoriaLogs](https://docs.victoriametrics.com/victorialogs/))
using the [`docker-compose.yml`](remote-logging/docker-compose.yml) next to this file.

## How it works in the app

Implementation: `src/helpers/remote-log.mts` (the transport) and `src/helpers/logger.mts`
(every `createLogger()` instance mirrors into it). Wired up in `app.mts` via
`settingsManager.onGlobals` → `configureRemoteLogFromSettings`, so settings changes apply
immediately — no app restart.

**Wire format** — one [RFC 5424](https://datatracker.ietf.org/doc/html/rfc5424) syslog line
per log call:

```
<PRI>1 TIMESTAMP HOSTNAME ai-voice-assistant PID MSGID - MESSAGE
```

* **Facility** is `local0` (16). **Severity** is one of error (3), warning (4), info (6),
  debug (7).
* **APP-NAME** is always `ai-voice-assistant` — filter on this if other things log to the
  same collector.
* **MSGID** carries the logger name (`CONVO`, `ESP`, `AGENT`, `TOOLS`, `WEBSERVER`, …) so you
  can filter per subsystem.
* Timestamps are UTC ISO 8601; ANSI colors are stripped; multi-line messages are collapsed to
  one line (collectors split datagrams on newlines); lines are capped at 8 KB.
* Structured `details` objects are appended after ` | `, with **secret-looking fields masked**
  (`api_key`, `token`, `password`, … become `sk-p....8AA`) before anything leaves the app.

**What gets sent at which severity:**

| App log call | Syslog severity |
|---|---|
| `error()` | 3 (error) — always sent |
| `warn()` | 4 (warning) — always sent |
| `info()` on an *enabled* logger (the normal narrative, e.g. `CONVO`) | 6 (info) |
| `info()` on a *disabled* logger (quieted subsystems: ESP, provider, tools, …) | 7 (debug) |

So the **Log level** setting controls how much you receive: `info` gives you the same story as
the in-app log plus warnings/errors; `debug` gives you *everything*, including subsystems that
never appear in the in-app log at all.

**Transport behavior** — deliberately fire-and-forget so logging can never slow down or break
the voice pipeline:

* **UDP** (default): datagrams are sent without waiting for anything. Zero overhead, but no
  delivery guarantee — fine on a LAN.
* **TCP**: newline-framed (RFC 6587 non-transparent), what rsyslog/syslog-ng/VictoriaLogs
  expect by default. The socket lazily (re)connects with a 5-second backoff, buffered writes
  are capped at 64 KB, and lines are *dropped* rather than queued when the collector is
  unreachable.
* Every failure is swallowed after remembering the last error, which the settings page's
  **Send test message** button surfaces.

## App settings

In the app's settings page, **Logging** section:

| Setting | Key | Default |
|---|---|---|
| Enable remote logging | `remote_log_enabled` | off |
| Syslog server address | `remote_log_host` | — |
| Port | `remote_log_port` | 514 |
| Protocol (UDP/TCP) | `remote_log_protocol` | udp |
| Log level | `remote_log_level` | debug |

The **Send test message** button sends one INFO line (MSGID `TEST`) using the values currently
in the form — before saving — so you can verify the address. Note that over UDP "sent" only
means the datagram left Homey; check the server to confirm it arrived. TCP gives a real
connect-and-write verdict.

## Running a log server: VictoriaLogs in Docker

Any syslog collector works (rsyslog, syslog-ng, Synology/QNAP log centers, Grafana
Alloy → Loki, Papertrail, Graylog…). The recommended self-hosted option is
**[VictoriaLogs](https://docs.victoriametrics.com/victorialogs/)**:

* Free and open source (Apache-2.0), actively developed.
* A **single, very lightweight container** — happily runs on a Raspberry Pi or NAS. Compare
  Graylog, which needs MongoDB + OpenSearch alongside it.
* **Native syslog ingestion** — accepts exactly what this app sends (RFC 5424 over UDP and
  TCP) with no adapter or pipeline config.
* **Built-in web UI** (vmui) with a proper query language (LogsQL), field-based filtering and
  live tailing.

### Start it

```bash
cd docs/remote-logging
docker compose up -d
```

That's the whole setup. The compose file ([`remote-logging/docker-compose.yml`](remote-logging/docker-compose.yml)):

* listens for syslog on port **514** (both UDP and TCP),
* serves the web UI and HTTP API on port **9428**,
* keeps logs for **30 days** (`-retentionPeriod=30d` — adjust to taste),
* persists data under `/opt/victoria/logs-data` on the host (adjust the bind-mount path in the
  compose file to taste).

If port 514 is already taken on the Docker host (a running syslog daemon), remap the published
ports to e.g. `1514` in the compose file and use that port in the app's settings.

### Point the app at it

In the app settings → **Logging**: enable remote logging, enter the Docker host's LAN IP,
port `514`, protocol `UDP` (or `TCP` if you want delivery feedback), level `debug` for
everything. Click **Send test message**, then **Save**.

## Viewing the logs

Open the web UI at:

```
http://<docker-host>:9428/select/vmui/
```

Pick a time range top-right, type a LogsQL query, and hit *Execute Query*. The syslog fields
map straight onto what the app sends: `app_name` = `ai-voice-assistant`, `msg_id` = the
subsystem tag, `level` = the severity as a keyword (`error`, `warning`, `info`, `debug`;
the numeric code is also there as `severity`), `_msg` = the message text.

Useful queries:

```logsql
# Everything from the app, last hour
app_name:ai-voice-assistant _time:1h

# One subsystem only (the conversation narrative)
app_name:ai-voice-assistant msg_id:CONVO

# The ESP connection chatter
app_name:ai-voice-assistant msg_id:ESP

# Warnings and errors only
app_name:ai-voice-assistant (level:error OR level:warning)

# Full-text search in the message
app_name:ai-voice-assistant _msg:"tool.called"
```

The UI also has a **live tailing** mode (the "Live" tab in vmui) — start it, then talk to the
assistant and watch the pipeline in real time. Handy during `homey app run --remote` sessions
too, since the DEBUG-severity subsystem logs never reach the console.

If you already run Grafana, VictoriaLogs has an official
[Grafana datasource plugin](https://docs.victoriametrics.com/victorialogs/victorialogs-datasource/)
so the same data can go on dashboards.

## Alternatives

If you already have one of these, just point the app at it instead — the transport is plain
RFC 5424 syslog and works with anything:

* **Synology Log Center / QNAP QuLog** — enable the syslog server, port 514 UDP.
* **rsyslog / syslog-ng** on any Linux box — enable the UDP/TCP input modules.
* **Grafana Alloy → Loki** — Alloy's `loki.source.syslog` accepts RFC 5424 TCP/UDP.
* **Papertrail** and similar hosted collectors — use TCP and their host/port. Note the logs
  then leave your network.
