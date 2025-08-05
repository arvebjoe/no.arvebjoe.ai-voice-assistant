import fs from 'node:fs';
import protobuf from 'protobufjs';
import varint from 'varint';
import path from 'path';

const root = protobuf.parse(
    fs.readFileSync(path.join(__dirname, 'api.proto'), 'utf8')
).root;

// Message type map
interface MessageTypeEntry {
    id: number;
    type: any;
}
const TYPES: Record<string, MessageTypeEntry> = {};
(root.nestedArray as any[]).forEach((msg: any) => {
    const msgId = msg.options?.['(id)'];
    if (msgId !== undefined) {
        TYPES[msg.name] = { id: msgId, type: msg };
    }
});

// Stub for MediaPlayerPlayMediaRequest (ID 145)
if (!TYPES['MediaPlayerPlayMediaRequest']) {
    const stubRoot = protobuf.parse(`
    syntax = "proto3";
    message MediaPlayerPlayMediaRequest {
      uint32 key        = 1;
      string media_url  = 2;
      string media_type = 3;
    }
  `).root;
    TYPES['MediaPlayerPlayMediaRequest'] = {
        id: 145,
        type: stubRoot.lookupType('MediaPlayerPlayMediaRequest'),
    };
}

// VoiceAssistantAnnounceRequest (id 119)
if (!TYPES['VoiceAssistantAnnounceRequest']) {
    const stub = protobuf.parse(`
    syntax = "proto3";
    message VoiceAssistantAnnounceRequest {
      string media_id              = 1;   // URL to pull
      string text                  = 2;   // TTS text (unused if media_id set)
      string preannounce_media_id  = 3;   // optional chime
      bool   start_conversation    = 4;   // true ⇒ stay in VA session
    }
  `).root.lookupType('VoiceAssistantAnnounceRequest');

    TYPES['VoiceAssistantAnnounceRequest'] = { id: 119, type: stub };
}

const PLAINTEXT = 0x00;
const VA_EVENT = (root.lookupEnum('VoiceAssistantEvent') as any).values;

// Types for encode/decode
interface EncodePayload {
    [key: string]: any;
}
interface DecodeResult {
    name: string | null;
    id: number;
    message: any;
    payload: Buffer;
    bytes: number;
}

// ---------- encode ------------------------------------------------------------
function encodeFrame(name: string, payload: EncodePayload = {}): Buffer {
    const entry = TYPES[name];
    if (!entry) {
        throw new Error(`unknown message: ${name}`);
    }

    const body = entry.type.encode(payload).finish();     // protobuf bytes
    const header = Buffer.concat([
        Buffer.from([PLAINTEXT]),
        Buffer.from(varint.encode(body.length)),              // payload size
        Buffer.from(varint.encode(entry.id))                  // message id
    ]);
    return Buffer.concat([header, body]);
}

// ---------- decode (returns null if buffer incomplete) ------------------------
function decodeFrame(buf: Buffer): DecodeResult | null {
    if (!buf.length || buf[0] !== PLAINTEXT) {
        return null;
    }

    let off = 1;

    // payload length
    if (off >= buf.length) {
        return null;
    }
    const payloadLen = varint.decode(buf, off);
    off += varint.decode.bytes ?? 0;

    // message id
    if (off >= buf.length) {
        return null;
    }
    const msgId = varint.decode(buf, off);
    off += varint.decode.bytes ?? 0;

    const frameLen = 1 + off - 1 + payloadLen;           // full frame size
    if (buf.length < frameLen) {
        return null;
    }

    const payloadBuf = buf.subarray(off, off + payloadLen);

    const entry = Object.values(TYPES).find((e) => e.id === msgId);
    const decoded = entry ? entry.type.decode(payloadBuf) : null;

    return {
        name: entry?.type.name ?? null,
        id: msgId,
        message: decoded,
        payload: payloadBuf,
        bytes: frameLen          // ← how many bytes we consumed
    };
}

export { VA_EVENT, encodeFrame, decodeFrame };
