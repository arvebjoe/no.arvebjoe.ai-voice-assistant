import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, VA_EVENT } from '../src/voice_assistant/esp-messages.mjs';

// The ESPHome native-API framing is: [0x00][varint payloadLen][varint msgId][payload].
// These tests pin the encode/decode contract and, critically, the partial-frame
// reassembly behaviour the TCP client relies on (decodeFrame must return null
// until a whole frame has arrived, and must never throw on a truncated buffer).

describe('esp-messages framing', () => {
    it('roundtrips a HelloRequest', () => {
        const frame = encodeFrame('HelloRequest', { clientInfo: 'vitest', apiVersionMajor: 1, apiVersionMinor: 10 });
        const decoded = decodeFrame(frame);

        expect(decoded).not.toBeNull();
        expect(decoded!.name).toBe('HelloRequest');
        expect(decoded!.message.clientInfo).toBe('vitest');
        expect(decoded!.message.apiVersionMajor).toBe(1);
        expect(decoded!.message.apiVersionMinor).toBe(10);
        expect(decoded!.bytes).toBe(frame.length);
    });

    it('roundtrips a ConnectRequest (password field survives)', () => {
        const frame = encodeFrame('ConnectRequest', { password: 'hunter2' });
        const decoded = decodeFrame(frame);

        expect(decoded!.name).toBe('ConnectRequest');
        expect(decoded!.message.password).toBe('hunter2');
    });

    it('encodes with the plaintext (0x00) preamble', () => {
        const frame = encodeFrame('HelloRequest', { clientInfo: 'x' });
        expect(frame[0]).toBe(0x00);
    });

    it('throws on an unknown message name', () => {
        expect(() => encodeFrame('NoSuchMessage', {})).toThrow(/unknown message/i);
    });

    it('returns null for an empty buffer', () => {
        expect(decodeFrame(Buffer.alloc(0))).toBeNull();
    });

    it('returns null for a non-plaintext preamble (e.g. Noise 0x01)', () => {
        const frame = encodeFrame('HelloRequest', { clientInfo: 'x' });
        const noise = Buffer.from(frame);
        noise[0] = 0x01;
        expect(decodeFrame(noise)).toBeNull();
    });

    it('returns null (never throws) for every truncation of a full frame', () => {
        const frame = encodeFrame('HelloResponse', { apiVersionMajor: 1, apiVersionMinor: 10, serverInfo: 'esphome', name: 'kitchen' });
        for (let n = 1; n < frame.length; n++) {
            const partial = frame.subarray(0, n);
            expect(() => decodeFrame(partial)).not.toThrow();
            expect(decodeFrame(partial)).toBeNull();
        }
        // The complete frame decodes.
        expect(decodeFrame(frame)).not.toBeNull();
    });

    it('roundtrips a multi-byte varint payload length (payload > 127 bytes)', () => {
        // 200 bytes of audio forces a 2-byte payload-length varint.
        const audio = Buffer.alloc(200, 0x7f);
        const frame = encodeFrame('VoiceAssistantAudio', { data: audio });
        // Two-byte varint means the header is longer than the 3-byte minimum.
        expect(frame.length).toBeGreaterThan(200 + 3);

        const decoded = decodeFrame(frame);
        expect(decoded!.name).toBe('VoiceAssistantAudio');
        expect(Buffer.from(decoded!.message.data)).toEqual(audio);
        expect(decoded!.bytes).toBe(frame.length);
    });

    it('consumes exactly one frame from a concatenated stream and reports bytes', () => {
        const f1 = encodeFrame('HelloRequest', { clientInfo: 'first' });
        const f2 = encodeFrame('ConnectRequest', { password: 'second' });
        const stream = Buffer.concat([f1, f2]);

        const d1 = decodeFrame(stream);
        expect(d1!.name).toBe('HelloRequest');
        expect(d1!.message.clientInfo).toBe('first');
        expect(d1!.bytes).toBe(f1.length);

        const rest = stream.subarray(d1!.bytes);
        const d2 = decodeFrame(rest);
        expect(d2!.name).toBe('ConnectRequest');
        expect(d2!.message.password).toBe('second');
        expect(d2!.bytes).toBe(f2.length);
    });

    it('handles a frame carrying an unknown message id gracefully', () => {
        // Hand-build a frame: preamble, payload length 0, an id no message uses.
        const unknownId = 60000;
        const varintId: number[] = [];
        let v = unknownId;
        while (v > 0x7f) { varintId.push((v & 0x7f) | 0x80); v >>>= 7; }
        varintId.push(v);
        const frame = Buffer.from([0x00, 0x00, ...varintId]);

        const decoded = decodeFrame(frame);
        expect(decoded).not.toBeNull();
        expect(decoded!.name).toBeNull();
        expect(decoded!.message).toBeNull();
        expect(decoded!.id).toBe(unknownId);
        expect(decoded!.bytes).toBe(frame.length);
    });

    it('never throws while a multi-byte-varint frame arrives byte by byte', () => {
        const audio = Buffer.alloc(300, 0x11); // forces a 2-byte payload-length varint
        const frame = encodeFrame('VoiceAssistantAudio', { data: audio });
        for (let n = 1; n < frame.length; n++) {
            expect(() => decodeFrame(frame.subarray(0, n))).not.toThrow();
            expect(decodeFrame(frame.subarray(0, n))).toBeNull();
        }
        expect(decodeFrame(frame)).not.toBeNull();
    });

    it('throws on an absurd/hostile payload length instead of buffering', () => {
        // Build a header claiming a ~16 MB payload with only the header present.
        const huge = 16 * 1024 * 1024;
        const lenVarint: number[] = [];
        let v = huge;
        while (v > 0x7f) { lenVarint.push((v & 0x7f) | 0x80); v >>>= 7; }
        lenVarint.push(v);
        const frame = Buffer.from([0x00, ...lenVarint, 0x01]); // msgId=1, no payload yet
        expect(() => decodeFrame(frame)).toThrow(/too large/i);
    });

    it('exposes the VoiceAssistantEvent enum values', () => {
        expect(VA_EVENT).toBeTypeOf('object');
        // A couple of well-known members from the ESPHome enum.
        expect(Object.keys(VA_EVENT).length).toBeGreaterThan(0);
        expect(VA_EVENT).toHaveProperty('VOICE_ASSISTANT_RUN_START');
    });
});
