# ESPHome Native API — Noise encryption research & implementation plan

*Research notes, 2026-07-23. Feeds the "Noise encryption for the ESPHome link (was
code-review M2)" item in `TODO.md`. Companion to the manual-IP pairing work: the
manual-entry pair view (`pair/manual_entry.html`) has a marked `TODO (encryption)` spot
where the key field slots in once this lands.*

## 1. Why

Our client (`src/voice_assistant/esp-voice-assistant-client.mts`) speaks the ESPHome
native API in **plaintext only**. When a device has an API **encryption key** configured
(`api: → encryption: → key:` in its ESPHome YAML — the default when a device has ever
been adopted by Home Assistant), the server refuses plaintext and the connection fails
entirely. Today we document this as a limitation and tell users to remove the key.
Supporting encryption removes that friction and stops us from asking users to *lower*
their device's security to use our app.

Encryption is a **connection-time** concern: the key is needed on *every* connection,
regardless of whether the device was found via mDNS or added manually by IP. So the
design below is a per-device key that the client uses for all connections — the
manual-entry form is just one place the key gets collected.

## 2. Protocol overview

ESPHome uses the **[Noise Protocol Framework](http://noiseprotocol.org/noise.html)**
with this exact instantiation:

```
Noise_NNpsk0_25519_ChaChaPoly_SHA256
```

Breaking the name down:

| Part | Meaning |
|---|---|
| `NN` | Neither side has a static key pair — no certificates, no identity keys |
| `psk0` | A 32-byte **pre-shared key** is mixed in at the *start* of the first message; it is the sole authentication |
| `25519` | X25519 elliptic-curve Diffie-Hellman for the ephemeral key exchange |
| `ChaChaPoly` | ChaCha20-Poly1305 AEAD for all encryption (16-byte auth tag) |
| `SHA256` | Hash for the handshake transcript and HKDF key derivation |

Properties that matter to us:

- **The PSK is the whole trust model.** Wrong key → the very first AEAD decryption fails
  (Poly1305 tag mismatch) and the server reports "Handshake MAC failure". There is no
  way to probe whether a key is right without completing a handshake.
- **Forward secrecy**: fresh X25519 ephemeral keys per connection; the PSK alone can't
  decrypt a captured session.
- **The PSK format** is a base64 string decoding to exactly **32 bytes** (this is what
  the user copies out of their ESPHome YAML / dashboard).
- Handshake adds exactly **one round trip** before the normal `HelloRequest` flow.

Constants (from the reference implementations — see §8):

```
Protocol name : "Noise_NNpsk0_25519_ChaChaPoly_SHA256"  (ASCII, hashed into the initial state)
Prologue      : "NoiseAPIInit" + 0x00 0x00              (14 bytes)
PSK           : base64-decoded, must be exactly 32 bytes
```

## 3. Wire format

The plaintext and encrypted protocols share one outer concept: every frame begins with
an **indicator byte**. `0x00` = plaintext (what we speak today, `esp-messages.mts`
`PLAINTEXT`), `0x01` = Noise. A server configured with a key only accepts `0x01`.

### 3.1 Outer frame (Noise)

Unlike plaintext frames (varint length + varint type), **every** Noise frame is:

```
[ 0x01 ][ len_hi ][ len_lo ][ payload … ]
          └── 16-bit big-endian payload length ──┘
```

Fixed 3-byte header, big-endian `uint16` length. (Plaintext uses varints and
little-endian nothing — do not reuse the plaintext framing code paths.)

### 3.2 Connection sequence

```
Client → Server   0x01 0x00 0x00                                  "client hello" (empty payload)
Client → Server   frame: [0x00][noise handshake message 1]        sent immediately, same write
Server → Client   frame: [0x01][server_name 0x00][mac 0x00]       "server hello"
Server → Client   frame: [0x00][noise handshake message 2]        or [0x01][error text] on failure
--- handshake complete, Split() into two transport ciphers ---
Both directions   frame: [encrypted( inner message )]             normal API traffic
```

Details:

- **Client hello** is an empty Noise frame (`0x01 0x00 0x00`). aioesphomeapi sends the
  client hello *and* handshake message 1 in a single write to save a round trip; the
  server processes them in order.
- **Server hello** payload: first byte is the chosen protocol (`0x01` = Noise), then the
  device's **server name** (NUL-terminated) and, on newer firmware, its **MAC address**
  (NUL-terminated). Clients may verify these against the expected device (aioesphomeapi
  raises `BadNameAPIError` / `BadMACAddressAPIError` on mismatch) — this prevents
  connecting to the wrong device when DHCP reshuffles IPs. We should check MAC when we
  have one in the device store.
- **Handshake frames** carry a 1-byte status prefix inside the payload: `0x00` =
  proceed, followed by the raw Noise handshake message; `0x01` = failure, followed by a
  UTF-8 explanation. The canonical failure text `"Handshake MAC failure"` means **wrong
  PSK** and must be surfaced to the user as "wrong encryption key", not a generic error.
- **Handshake message sizes** (NNpsk0): message 1 = 32-byte ephemeral public key +
  16-byte tag over the (empty, encrypted) payload = 48 bytes; message 2 likewise 48
  bytes. With the status byte, both handshake frame payloads are 49 bytes.

### 3.3 Data frames after the handshake

The plaintext varint framing disappears entirely. Each application message becomes:

```
inner  = [ type_hi ][ type_lo ][ len_hi ][ len_lo ][ protobuf bytes … ]
frame  = [ 0x01 ][ u16 BE length ][ encrypt(inner) ]          (ciphertext + 16-byte tag)
```

- Message **type** (the same protobuf message ids we already use, e.g. `HelloRequest` =
  1) and **length** are plain `uint16` **big-endian** inside the encrypted payload —
  *not* varints.
- aioesphomeapi deliberately ignores the inner length field on receive ("we do not
  trust the remote end to send the correct length") and uses the decrypted buffer size.
  We should do the same.
- Each direction has its **own cipher + nonce counter** (see §4); one TCP frame = one
  AEAD unit = one nonce increment. Frames must be decrypted **in order** — the nonce is
  implicit.

## 4. The handshake, cryptographically

This is standard Noise machinery (`CipherState` → `SymmetricState` →
`HandshakeState`), specialized to NNpsk0. The `esphome-client` project (see §7)
proves the whole thing is implementable with **Node built-ins only** (`node:crypto`).

### 4.1 Primitive → node:crypto mapping

| Noise primitive | node:crypto |
|---|---|
| X25519 keygen | `generateKeyPairSync('x25519')` |
| X25519 DH | `diffieHellman({ privateKey, publicKey })` |
| Import peer's raw 32-byte public key | prepend SPKI DER prefix `30 2a 30 05 06 03 2b 65 6e 03 21 00`, then `createPublicKey({ key, format: 'der', type: 'spki' })` |
| Export own raw public key | last 32 bytes of the SPKI DER export |
| ChaCha20-Poly1305 | `createCipheriv('chacha20-poly1305', key, nonce12, { authTagLength: 16 })` + `setAAD(ad, { plaintextLength })`; decrypt side uses `createDecipheriv` + `setAuthTag` |
| SHA-256 | `createHash('sha256')` |
| HKDF (RFC 5869) | `hkdfSync('sha256', ikm, chainingKey /* as salt */, EMPTY, 64 or 96)` |

**Nonce format** (ChaCha20-Poly1305, per Noise spec): 12 bytes = 4 zero bytes + 64-bit
counter **little-endian** (`nonce.writeBigUInt64LE(n, 4)`), incremented after every
encrypt/decrypt on that cipher.

> Runtime check: `crypto.getCiphers().includes('chacha20-poly1305')` — present in
> standard Node ≥ 17 builds (OpenSSL with ChaCha enabled, which Homey's Node has, but
> verify on-device with `homey app run --remote` before committing to the zero-dep
> route; the fallback is `@noble/ciphers` — see §7).

### 4.2 State machine

Initialization:

```
h  = ck = SHA256("Noise_NNpsk0_25519_ChaChaPoly_SHA256")
MixHash(prologue)                       // "NoiseAPIInit\x00\x00"
```

`MixHash(data)`: `h = SHA256(h || data)`.
`MixKey(ikm)`: `[ck, k] = HKDF(ck, ikm, 2 outputs)`, re-init cipher with `k`, nonce = 0.
`MixKeyAndHash(ikm)`: `[ck, tempH, k] = HKDF(ck, ikm, 3 outputs)`; `MixHash(tempH)`;
re-init cipher with `k`. (This is the psk-specific operation.)

**Message 1 — client sends** (tokens `psk, e`):

1. `MixKeyAndHash(psk)` — the 32-byte decoded key
2. generate ephemeral pair; send raw 32-byte public key `e_pub`; `MixHash(e_pub)`;
   `MixKey(e_pub)` *(psk modes also mix the ephemeral into the key — this is the
   NNpsk0-specific extra step)*
3. encrypt-and-hash the (empty) payload → 16-byte tag; append

**Message 2 — client receives** (tokens `e, ee`):

1. read server's raw 32-byte ephemeral `re_pub`; `MixHash(re_pub)`; `MixKey(re_pub)`
2. `MixKey(DH(e_priv, re_pub))` — the `ee` token
3. decrypt-and-hash the (empty) payload — **this is where a wrong PSK fails** (tag
   mismatch)

**Split**: `HKDF(ck, empty, 64 bytes)` → first 32 bytes = cipher **c1**, last 32 =
**c2**. The **initiator (us) sends with c1 and receives with c2.** Each keeps its own
nonce counter starting at 0.

## 5. How a client detects encryption (UX hooks)

Three independent signals, all worth using:

1. **mDNS TXT records** ([ESPHome mdns component](https://api-docs.esphome.io/mdns__component_8cpp_source)):
   - `api_encryption=Noise_NNpsk0_25519_ChaChaPoly_SHA256` — a key is **configured**;
     plaintext will be refused. Our discovery already reads `txt.mac`/`txt.platform`;
     we can read `txt.api_encryption` the same way and know *before probing* that a key
     is needed.
   - `api_encryption_supported=…` — newer firmware, no key set yet but the device
     accepts one being provisioned at runtime (not our concern; plaintext works).
2. **Plaintext client ↔ encrypted server**: the server answers our plaintext frames
   with a `0x01` indicator byte. aioesphomeapi maps this to `RequiresEncryptionAPIError`.
   Today our `decodeFrame()` returns `null` on a non-`0x00` first byte and we just look
   hung until the health check gives up — we should instead recognize `0x01` and emit a
   dedicated `requires_encryption` error/event.
3. **Encrypted client ↔ plaintext server**: the reverse — first response byte `0x00`
   during the Noise hello. Map to a "device has no encryption key set" error so a user
   who typed a key against a plaintext device gets a precise message.

## 6. Implementation plan for this codebase

### 6.1 New module: `src/voice_assistant/noise-frame-codec.mts`

Self-contained, no Homey imports (unit-testable like `improv-ble-client.mts`):

- `class NoiseFrameCodec` — constructor takes `{ psk: string (base64), expectedMac?: string }`.
  - `startHandshake(): Buffer` — returns the combined client-hello + message-1 bytes to
    write to the socket.
  - `feed(data: Buffer): NoiseEvent[]` — stateful RX: buffers, splits outer frames,
    advances the handshake state machine, and after `ready` returns decrypted inner
    messages as `{ type: number, payload: Buffer }`.
  - `encodeMessage(type: number, payload: Buffer): Buffer` — encrypt + frame one message.
  - Events/errors it must distinguish: `ready` (handshake done, carries server
    name/MAC), `wrong_psk` ("Handshake MAC failure" **or** local `InvalidTag` on message
    2), `plaintext_server` (indicator `0x00` seen), `mac_mismatch`, `protocol_error`.
- Internals: `CipherState`, `SymmetricState`, `HandshakeState` classes exactly as in §4.
  Port from `esphome-client`'s `crypto-noise.ts` (ISC license — compatible, attribute in
  a comment) rather than re-deriving from the Noise spec.

### 6.2 Seam in the existing client

`esp-voice-assistant-client.mts` currently calls `encodeFrame`/`decodeFrame`
(plaintext) inline in `send()` / the RX loop. Introduce a minimal codec seam:

- `EspVoiceClientOptions` gains `encryptionKey?: string`.
- On connect: if a key is set → write `codec.startHandshake()` first and hold back
  `HelloRequest` until the codec reports `ready`; if no key → today's path, unchanged.
- RX loop: with a codec active, `feed()` replaces `decodeFrame()`; the decrypted
  `{type, payload}` then goes through the **existing** protobuf lookup (`TYPES` by id in
  `esp-messages.mts` — export a `decodeBody(typeId, payload)` helper so both framings
  share message decoding). `send()` likewise routes through `codec.encodeMessage()`.
- Plaintext path also learns to recognize an incoming `0x01` indicator →
  emit `requires_encryption` instead of stalling (see §5.2).
- The health-check/reconnect logic is framing-agnostic and needs no changes; a new
  handshake happens naturally on every reconnect.

### 6.3 Where the key lives

- **Store value** (`store.encryptionKey`) set at pair time, like `address`/`port` — plus
  a **device setting** (per-driver `driver.compose.json` settings array) so users can
  add/fix a key on an already-paired device without re-pairing. Device reads setting
  first, falls back to store; `onSettings` rebuilds the ESP client.
- **Pairing, manual entry**: the marked `TODO (encryption)` spot in
  `pair/manual_entry.html` becomes an optional "API encryption key" field →
  `manual_probe` payload → `probeManualEntry()` → client options.
- **Pairing, discovery**: when mDNS TXT shows `api_encryption`, today's probe can't
  succeed. Simplest UX: surface such devices in the list but fail adding with a clear
  message + point at manual entry; better (later): a key-prompt pair view.
- Validate early: base64-decode must yield exactly 32 bytes — reject in the form with a
  friendly message before ever touching the network.

### 6.4 Error UX (worth getting right)

| Condition | Detected by | Message to user |
|---|---|---|
| Wrong key | "Handshake MAC failure" / `InvalidTag` on msg 2 | "The encryption key is incorrect for this device." |
| Key given, device is plaintext | `0x00` indicator during hello | "This device has no encryption key set — leave the key field empty." |
| No key given, device requires one | `0x01` indicator on plaintext connect; or TXT `api_encryption` | "This device requires an API encryption key." |
| Malformed key | base64/length check | "The key should be the 32-byte base64 string from your ESPHome configuration." |

### 6.5 Testing

- Unit-test `NoiseFrameCodec` by also implementing the **responder** role with the same
  primitives (small, test-only) and running a full loopback handshake + traffic in
  vitest — no network, mirrors how `improv-ble-client` is tested with fakes.
- Golden-vector test: the Noise spec test vectors for `NNpsk0_25519_ChaChaPoly_SHA256`
  (available from the noise-c / snow projects) pin our HKDF/MixKey plumbing.
- Negative tests: wrong PSK (expect `wrong_psk`), plaintext indicator, truncated
  frames, out-of-order nonce (tampered frame → tag failure).
- Integration: a real Voice PE with a key set, exercised via `homey app run --remote`.
  Also verifies chacha20-poly1305 availability in Homey's Node (§4.1 note).

## 7. Library options considered

| Option | Verdict |
|---|---|
| **Port `esphome-client`'s `crypto-noise.ts` (ISC, zero-dep, node:crypto only)** | **Recommended.** Proven against real ESPHome firmware, no new dependencies, ~1 file. |
| `@richardhopton/noise-c.wasm` (used by `@2colors/esphome-native-api`) | WASM blob, heavier, awkward on Homey; only worth it if node:crypto lacks chacha20-poly1305 on-device. |
| `@noble/curves` + `@noble/ciphers` (pure JS, audited) | Good fallback if the on-device OpenSSL surprise happens; still means writing the Noise state machine ourselves. |
| Full Noise libraries (`noise-handshake`, etc.) | More surface than needed for one fixed pattern; the state machine for NNpsk0 is ~150 lines. |

## 8. Sources

- [aioesphomeapi `_frame_helper/noise.py`](https://github.com/esphome/aioesphomeapi/blob/main/aioesphomeapi/_frame_helper/noise.py) — the canonical client; byte layouts, error taxonomy, prologue/PSK constants in §2–§3 come from here.
- [hjdhjd/esphome-client](https://github.com/hjdhjd/esphome-client) — zero-dependency Node/TypeScript client; [`src/crypto-noise.ts`](https://github.com/hjdhjd/esphome-client/blob/main/src/crypto-noise.ts) is the recommended porting base (ISC).
- [ESPHome mdns component source](https://api-docs.esphome.io/mdns__component_8cpp_source) — `api_encryption` / `api_encryption_supported` TXT records.
- [Noise Protocol Framework spec](http://noiseprotocol.org/noise.html) — HKDF/MixKey/MixKeyAndHash definitions, psk0 pattern, ChaChaPoly nonce format.
- [ESPHome native API docs](https://esphome.io/components/api.html) — user-facing `api: encryption: key:` configuration.
- Repo-internal: `docs/home-assistant-voice-preview-edition/esphome-native-api.md`, `docs/code_review_2.md` (M2), `TODO.md` "Deferred technical work".

## 9. Effort & risk estimate

- **Codec module + tests**: the bulk of the work; the crypto is mechanical once ported
  (~300–400 lines incl. responder-for-tests). Low risk — fixed pattern, golden vectors.
- **Client seam**: small but touches the hot RX path; keep plaintext path byte-for-byte
  unchanged when no key is set. Medium risk → mitigated by the existing live-debug
  workflow (`homey app run --remote`).
- **Pairing/settings UX**: small, mirrors the manual-entry work already shipped.
- **Unknowns to verify on-device**: chacha20-poly1305 in Homey's Node build (§4.1);
  whether target firmwares send the MAC in the server hello (older ones send name only —
  treat MAC as optional).
