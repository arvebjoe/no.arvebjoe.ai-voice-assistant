# Wi-Fi provisioning from the Homey app (Improv over BLE)

Research notes, 2026-07-16.

> **Status: implemented 2026-07-16** (same day) — protocol client in
> `src/ble/improv-ble-client.mts`, pair-socket wiring in `src/ble/improv-pair-handlers.mts`,
> wizard views in `drivers/{home-assistant-voice-preview-edition,thirdreality-voice--music-assistant}/pair/`,
> `homey:wireless:ble` permission in `.homeycompose/app.json`. Live-hardware verification
> checklist lives in `TODO.md`. This document remains the protocol/SDK reference.

## The problem

Getting the ThirdReality Voice & Music Assistant (TR) onto Wi-Fi is painful. The vendor's own
app fails to find the device over both Bluetooth and Wi-Fi. The only working path found so far:
install Home Assistant in Docker, install the HA iPhone app, let the HA app find the device over
Bluetooth and push the Wi-Fi credentials. That works because the device (and the Voice PE, see
below) implements **Improv Wi-Fi over BLE** — an open provisioning standard the HA app speaks.

Question: can *this* Homey app do the same during pairing — find the device over LAN or
Bluetooth, and if it's only reachable over Bluetooth, add an extra step that sets the Wi-Fi
credentials?

## Verdict: yes, feasible on Homey Pro

Everything required exists in the Homey Apps SDK v3:

1. **BLE scanning + GATT client** — `this.homey.ble` can discover advertisements filtered by
   service UUID, connect, read/write characteristics, and (since Homey v6.0.0) subscribe to
   notifications. That is exactly the surface Improv BLE needs. Requires the
   `homey:wireless:ble` permission in the app manifest.
2. **Custom pairing views** — the driver `pair` array accepts custom HTML views alongside the
   system `list_devices`/`add_devices` templates, with a bi-directional socket
   (`session.setHandler` / `Homey.emit`) between the view (runs in the Homey mobile app) and the
   driver (runs on the Homey Pro). That gives us the "enter SSID + password" step.
3. **LAN discovery already works** — our existing mDNS discovery (`_esphomelib._tcp`) finds any
   device that is already on the network. BLE provisioning is only needed for the
   not-yet-on-Wi-Fi case, which is also exactly when the devices advertise Improv over BLE.

The one *structural* constraint: all BLE traffic goes through the **Homey Pro's own radio**, not
the phone's. The custom pairing view runs in a webview on the phone (no Web Bluetooth there);
it can only tell the driver what to do. So the device being provisioned must be within BLE range
of the Homey Pro. This should be spelled out in the pairing UI ("place the speaker near your
Homey during setup").

---

## The Improv BLE protocol

Verified against the official SDKs ([sdk-js `const.ts`](https://github.com/improv-wifi/sdk-js/blob/main/src/const.ts),
[sdk-cpp `improv.h`/`improv.cpp`](https://github.com/improv-wifi/sdk-cpp)) and ESPHome's
[`esp32_improv`](https://github.com/esphome/esphome/tree/dev/esphome/components/esp32_improv)
component source. Spec home: [improv-wifi.com](https://www.improv-wifi.com/).

### GATT service and characteristics

| UUID | Role | Properties used |
|---|---|---|
| `00467768-6228-2272-4663-277478268000` | Improv service | — |
| `…8001` | Current state | read + notify (1 byte) |
| `…8002` | Error state | read + notify (1 byte) |
| `…8003` | RPC command | write |
| `…8004` | RPC result | notify (read) |
| `…8005` | Capabilities | read (1 byte; bit 0 = supports Identify) |

> **Homey UUID format:** Homey's BLE stack (noble-style) uses **lowercase hex without dashes** —
> verified in Athom's own BLE example app
> ([com.mipow-example](https://github.com/athombv/com.mipow-example), which passes
> `'0000ff0200001000800000805f9b34fb'` to `discover()`). So the service UUID becomes
> `00467768622822724663277478268000`.

### States (current-state characteristic / advertisement)

| Value | State | Meaning |
|---|---|---|
| `0x01` | AWAITING_AUTHORIZATION | User must physically authorize (e.g. press a button) |
| `0x02` | AUTHORIZED | Ready to accept credentials |
| `0x03` | PROVISIONING | Trying to join the network |
| `0x04` | PROVISIONED | Connected; RPC result carries redirect URL(s) |

### Errors (error-state characteristic)

`0x00` none · `0x01` invalid RPC packet · `0x02` unknown RPC command ·
`0x03` **unable to connect** (wrong credentials / AP not found — the retry case) ·
`0x04` not authorized · `0xFF` unknown.

### RPC framing (write to `…8003`)

```
<command:1> <payload_len:1> <payload…> <checksum:1>
```

Checksum = sum of all preceding bytes, & 0xFF. For **Send Wi-Fi settings (command `0x01`)** the
payload is `<ssid_len:1> <ssid…> <pass_len:1> <pass…>`. The reference JS SDK builds it exactly as:

```
[0x01, data.length, ssidLen, ...ssid, passLen, ...pass, checksum]
```

and writes the whole packet with a single `writeValue()` — no client-side chunking; long
(>MTU) writes are left to the BLE stack. Commands: `0x01` WIFI_SETTINGS, `0x02` IDENTIFY
(blink LED). The spec also defines extended commands (`0x04` GET_WIFI_NETWORKS etc.) but
**ESPHome's `esp32_improv` implements only WIFI_SETTINGS and IDENTIFY**, so the pairing UI
must use **manual SSID entry** (no network picker), at least for ESPHome-based devices. (The
Homey SDK has no API to read the Homey's own SSID either, so we can't pre-fill it.)

### Success result (notify on `…8004`)

Same framing, echoing command `0x01`, payload = list of length-prefixed strings: one or more
**URLs where the device is now reachable** (ESPHome sends a `my.esphome.io` link and, if the
web server component is enabled, `http://<ip>:<port>` — from which we can learn the device's
new IP). May be empty. After sending the result the device flips state to PROVISIONED and
clients are expected to disconnect (the reference SDK disconnects itself).

### Advertisement

While unprovisioned, the device advertises:

- the **128-bit Improv service UUID** (ESPHome creates the GATT service with
  `create_service(uuid, /*advertise=*/true)`), and
- **Service Data under 16-bit UUID `0x4677`**: `[state, capabilities, 4× reserved]` — so the
  current state is readable from the scan alone, and
- alternating with the **device name** (ESPHome switches between name advertising and Improv
  service data on a timer, since both don't fit one PDU).

For Homey this means `homey.ble.discover(['00467768622822724663277478268000'])` should match,
with a fallback of scanning unfiltered and matching `advertisement.serviceData` uuid `4677`
(also useful to pre-read the state without connecting — but see the cache caveat below).

---

## Device support matrix

| Device | Improv BLE? | Details |
|---|---|---|
| **ThirdReality V&M (TR)** | **Yes** (shipped) | Linux/BlueZ-based; advertises as `3RSPK-XXXXX Improv via BLE` (confirmed by HA community reports and our own `docs/thirdreality-voice-and-music/README.md` research; that's exactly how the HA iPhone app provisioned it). Implementation details (authorizer? extended commands?) not yet verified against firmware source — see open questions. Fallback: firmware also ships hostapd+dnsmasq for a provisioning SoftAP. |
| **HA Voice PE** | **Yes** | [Factory firmware](https://github.com/esphome/home-assistant-voice-pe/blob/dev/home-assistant-voice.factory.yaml) has `esp32_improv` with **`authorizer: center_button`** — the user must press the center button before credentials are accepted (state stays `0x01` until then; authorization times out after ~1 min idle, ESPHome default). LED ring twinkles warm white during Improv. **BLE is disabled 5 s after Wi-Fi connects** (`ble.disable`), so Improv is only discoverable while the device is unprovisioned / off-network. Also has `improv_serial` (USB) as an alternative. |
| **XiaoZhi AI** | Depends on firmware | Stock xiaozhi-esp32 firmware uses its own SoftAP-portal provisioning, not Improv. If the user flashed ESPHome (our supported configuration), it works only if their YAML includes `esp32_improv`. Treat as unsupported for v1. |

Implication of the PE's `ble.disable`-when-connected (TR likely similar): **LAN discovery and
Improv BLE are mutually exclusive states**, which matches the desired UX — anything we find over
BLE is by definition a device that needs Wi-Fi setup, and once provisioned it moves over to the
mDNS list.

---

## Homey SDK capabilities (verified against `homey-apps-sdk-v3-types@0.3.12` and homey-lib)

### BLE — `this.homey.ble` (ManagerBLE)

- `discover(serviceFilter?: string[]): Promise<BleAdvertisement[]>` — scan, optionally filtered
  by advertised service UUIDs.
- `find(peripheralUuid: string): Promise<BleAdvertisement>` — fetch a known peripheral.
- `BleAdvertisement`: `uuid`, `address` (MAC), `localName`, `serviceUuids[]`,
  `serviceData[{uuid, data}]`, `rssi`, `connectable`, and `connect(): Promise<BlePeripheral>`.
- `BlePeripheral`: `discoverServices()`, `getService(uuid)`, shorthand
  `read/write(serviceUuid, characteristicUuid, data)`, `disconnect()`, `isConnected`.
- `BleCharacteristic`: `read()`, `write(Buffer)`, and **`subscribeToNotifications(callback)` /
  `unsubscribeFromNotifications()` (since Homey v6.0.0)** — needed for state/error/RPC-result
  notifications. (A poll-the-state-characteristic fallback is possible if notifications prove
  unreliable.)
- Permission: add `"homey:wireless:ble"` to `permissions` in `.homeycompose/app.json`
  (user-visible as "Communicate with Bluetooth Low Energy devices").

Known behaviors/quirks (Athom changelog + community reports):

- **Advertisement cache:** discovery results are cached **≥ 30 s** ([Homey v6 changelog](https://apps.developer.homey.app/upgrade-guides/changelog-homey-6));
  historically longer. ⇒ Never trust the *state byte* in cached `serviceData`; after connecting,
  read the current-state characteristic for truth. Also expect a just-power-cycled device to take
  a scan cycle or two to appear.
- **Connections persist** (since v6): no auto-disconnect after 60 s; we must call
  `peripheral.disconnect()` ourselves when the pairing session ends or is abandoned.
- **`disconnect` events are not guaranteed** to fire; treat write/notify errors as disconnects.
- `discover()`/`find()` can take ~5 s+ to resolve ([community report](https://community.homey.app/t/5-seconds-delay-for-ble-discover-or-ble-find-with-uuid/83166));
  show a spinner in the pairing view.
- BLE ops run on the Homey Pro's radio; range is Homey↔device, not phone↔device.
- Our app already declares `"platforms": ["local"]`, so Homey Cloud (where app BLE access is
  not available) is out of scope anyway.

### Pairing — custom views ([docs](https://apps.developer.homey.app/advanced/custom-views/custom-pairing-views))

- Driver manifest `pair: [{ id, template?, options?, navigation? }]` (schema verified in
  homey-lib). A step **without** `template` loads `drivers/<driver>/pair/<id>.html` — free-form
  HTML/CSS/JS.
- In the view, a global `Homey` object provides `Homey.emit(event, data)` (round-trips to
  `session.setHandler(event, …)` in the driver), `Homey.showView(id)`, `Homey.nextView()`,
  `Homey.createDevice(device)`, `Homey.done()`, `Homey.alert()`, etc.
- In the driver, `onPair(session)` gives: `session.setHandler()`, `session.emit()` (driver →
  view push, e.g. live state updates), `session.showView()`, `nextView()`, `prevView()`,
  `done()`. There's a `showView` meta-handler to run code when a view appears.
- `onRepair(session, device)` exists too — the same Improv views could later be offered under
  "repair" to re-provision a device that moved to a new network. (Note: repair is only reachable
  for an already-paired device; after a network move the device keeps working once mDNS
  rediscovers it, so this is a nice-to-have.)
- Mocks for local development of pair views: [robertklep/homey-mocks](https://github.com/robertklep/homey-mocks).

---

## Proposed pairing flow (design only — not implemented)

Applies to both the TR and PE drivers (logic shared in `VoiceAssistantDriver`; the PE variant
adds the "press the center button" instruction).

```
pair: [
  list_devices (system, as today — mDNS results)   ← "next" → add_devices
  improv_intro (custom)     ← entered via a "Device not on Wi-Fi yet?" escape hatch
  improv_scan (custom)      — driver: homey.ble.discover([improvServiceUuid]); list names
  improv_credentials (custom) — SSID + password form (+ "press center button" instruction for PE)
  improv_wait (custom)      — progress: PROVISIONING → PROVISIONED / error retry loop
  list_devices (system)     — back to mDNS list; newly provisioned device now appears
]
```

Driver-side sequence per provisioning attempt (mirrors the reference sdk-js flow):

1. `advertisement.connect()` → `discoverServices()` (or `getService(improvUuid)`).
2. Read capabilities (optional), read current state.
3. `subscribeToNotifications` on current-state, error-state, RPC-result.
4. If state = `0x01` AWAITING_AUTHORIZATION → tell the view to show "press the button on the
   device"; wait for state notify → `0x02` (PE authorization window ~1 min).
5. Build and write the WIFI_SETTINGS RPC packet (single write, with response).
6. Wait: error-state ≠ 0 → surface error (`0x03` = wrong password / AP not found → let the user
   re-enter credentials **on the same connection** — state returns to AUTHORIZED); state = `0x04`
   + RPC result → success, parse device URL(s) if present.
7. `peripheral.disconnect()`; poll our mDNS discovery strategy
   (`driver.getDiscoveryStrategy().getDiscoveryResults()`) until the device's MAC shows up
   (give it ~30–60 s; the PE reboots nothing — it just joins the AP), then jump to
   `list_devices` so the user finishes normal pairing.
8. On session end/abandon (`session.setHandler('disconnect')` fires when the pair dialog
   closes): always `disconnect()` the peripheral.

New code this would eventually need (for the TODO, not now):

- `src/ble/improv-ble-client.mts` — small protocol client (framing, checksum, state machine)
  over `homey.ble`; unit-testable by mocking the peripheral.
- `drivers/*/pair/*.html` custom views + `pair` array changes in the two
  `driver.compose.json`s.
- `"permissions": ["homey:wireless:ble"]` in `.homeycompose/app.json`.
- `onPair` override in `VoiceAssistantDriver` (keep `onPairListDevices` semantics for the mDNS
  path).

## Risks and open questions (verify live before/while implementing)

1. **Long writes vs MTU.** The WIFI_SETTINGS packet (SSID+password, easily 30–70 bytes) exceeds
   the 20-byte default ATT payload. Web Bluetooth handles this via prepared/long writes; whether
   Homey's stack does is undocumented. **Test first on real hardware** — this is the single
   biggest go/no-go unknown. (Mitigation if it fails: none clean — Improv has no chunked-write
   mode for the command characteristic; would need Athom support confirmation.)
2. **Notification reliability on Homey.** If `subscribeToNotifications` is flaky, poll the
   state/error characteristics at ~500 ms instead; result URL would then be read from the
   RPC-result characteristic after state hits `0x04`.
3. **TR firmware specifics unverified:** does it require authorization (probably not — HA app
   provisioned directly), does it implement IDENTIFY / extended commands, exact advertised name.
   Verify against the firmware source (`thirdreality/voice-music-assistant`, branch
   `linux-voice-assistant`) and on hardware. (GitHub was unreachable from this research session
   beyond raw file fetches of known paths.)
4. **Stale advertisement cache** (≥30 s): a device that just got provisioned may still show up
   in a BLE re-scan; conversely a factory-reset device may not appear immediately. UI needs a
   manual "scan again" and should tolerate connect failures on stale entries.
5. **BLE range**: Homey Pro must be near the device during setup. Also older Homey Pro models'
   BLE radios are known to be weaker than a phone's.
6. **Homey Pro (Early 2016–2019) vs (Early 2023) BLE stack differences** — test on the 2023
   model at minimum; community threads report differing BLE behavior between generations.
7. **XiaoZhi**: out of scope unless the user's ESPHome YAML includes `esp32_improv`.

## Alternatives considered

- **SoftAP / captive-portal provisioning** (both TR and ESPHome support it): impossible from
  the Homey Pro — the SDK has no API to join another access point, and Homey's own network
  connection would drop. At best a pairing view can *instruct* the user to join the device's
  hotspot from their phone — but that's documentation, not integration.
- **Improv Serial via USB** ([web.esphome.io](https://web.esphome.io) /
  [improv-wifi.com](https://www.improv-wifi.com/)): works today in desktop Chrome/Edge for the
  PE (and is the official fallback), zero code for us — worth linking from the README regardless.
- **Status quo** (HA in Docker + HA phone app): works but is exactly the pain this feature
  removes.

## Sources

- Improv Wi-Fi: [improv-wifi.com](https://www.improv-wifi.com/) ·
  [sdk-js const.ts](https://github.com/improv-wifi/sdk-js/blob/main/src/const.ts) ·
  [sdk-js ble.ts](https://github.com/improv-wifi/sdk-js/blob/main/src/ble.ts) ·
  [sdk-cpp improv.h / improv.cpp](https://github.com/improv-wifi/sdk-cpp)
- ESPHome: [esp32_improv component source](https://github.com/esphome/esphome/tree/dev/esphome/components/esp32_improv)
  (state machine, advertising, authorizer, RPC result URLs)
- Voice PE firmware: [home-assistant-voice.factory.yaml](https://github.com/esphome/home-assistant-voice-pe/blob/dev/home-assistant-voice.factory.yaml)
  (`esp32_improv`, `authorizer: center_button`, `ble.disable` on connect)
- Homey SDK: [Bluetooth LE docs](https://apps.developer.homey.app/wireless/bluetooth) ·
  [Custom Pairing Views](https://apps.developer.homey.app/advanced/custom-views/custom-pairing-views) ·
  [PairSession](https://apps-sdk-v3.developer.homey.app/PairSession.html) ·
  [Homey v6 changelog (BLE cache/disconnect changes)](https://apps.developer.homey.app/upgrade-guides/changelog-homey-6) ·
  `homey-apps-sdk-v3-types@0.3.12` type definitions · homey-lib manifest schema ·
  [athombv/com.mipow-example](https://github.com/athombv/com.mipow-example) (official BLE app pattern, UUID format)
- Community: [5 s delay on discover/find](https://community.homey.app/t/5-seconds-delay-for-ble-discover-or-ble-find-with-uuid/83166) ·
  [BLE advertisement cache](https://community.homey.app/t/ble-advertisement-cache/16355) ·
  [TR installation thread (HA forum)](https://community.home-assistant.io/t/v-m-assistance-thirdreality-installation-problems/996194)
- In-repo: `docs/thirdreality-voice-and-music/README.md` (TR hardware/firmware research)
