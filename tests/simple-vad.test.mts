import { describe, it, expect } from 'vitest';
import { SimpleVad } from '../src/llm/providers/local/simple-vad.mjs';

const RATE = 16000;

function silence(ms: number): Buffer {
    return Buffer.alloc(Math.round(RATE * ms / 1000) * 2);
}

function speech(ms: number, amplitude = 8000): Buffer {
    const samples = Math.round(RATE * ms / 1000);
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        buf.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 300 * i / RATE)), i * 2);
    }
    return buf;
}

/** Feed a buffer in device-sized chunks (~32 ms), merging the results. */
function feedAll(vad: SimpleVad, pcm: Buffer) {
    const out = { speechStart: false, utterance: null as Buffer | null, timeout: false };
    const chunk = 1024;
    for (let off = 0; off < pcm.length; off += chunk) {
        const r = vad.feed(pcm.subarray(off, Math.min(off + chunk, pcm.length)));
        out.speechStart = out.speechStart || r.speechStart;
        out.utterance = out.utterance ?? r.utterance;
        out.timeout = out.timeout || r.timeout;
    }
    return out;
}

describe('SimpleVad', () => {
    it('detects speech start and closes the utterance after trailing silence', () => {
        const vad = new SimpleVad({ silenceMs: 600, noSpeechTimeoutMs: 8000 });
        vad.reset();

        const lead = feedAll(vad, silence(300));
        expect(lead.speechStart).toBe(false);
        expect(lead.utterance).toBeNull();

        const talk = feedAll(vad, speech(700));
        expect(talk.speechStart).toBe(true);
        expect(talk.utterance).toBeNull(); // still talking

        const tail = feedAll(vad, silence(800));
        expect(tail.utterance).not.toBeNull();
        // Utterance covers pre-roll + speech + silence tail (roughly).
        const ms = (tail.utterance!.length / 2 / RATE) * 1000;
        expect(ms).toBeGreaterThan(700);
    });

    it('times out when the user never speaks', () => {
        const vad = new SimpleVad({ noSpeechTimeoutMs: 2000 });
        vad.reset();
        const r = feedAll(vad, silence(2500));
        expect(r.timeout).toBe(true);
        expect(r.utterance).toBeNull();
        expect(r.speechStart).toBe(false);
    });

    it('goes inert after the utterance until reset()', () => {
        const vad = new SimpleVad({ silenceMs: 400 });
        vad.reset();
        feedAll(vad, speech(500));
        const done = feedAll(vad, silence(600));
        expect(done.utterance).not.toBeNull();

        const after = feedAll(vad, speech(500));
        expect(after.speechStart).toBe(false);
        expect(after.utterance).toBeNull();

        vad.reset();
        const again = feedAll(vad, speech(500));
        expect(again.speechStart).toBe(true);
    });

    it('ignores a short click (below minSpeechMs) followed by quiet', () => {
        const vad = new SimpleVad({ minSpeechMs: 200, silenceMs: 400, noSpeechTimeoutMs: 60000 });
        vad.reset();
        feedAll(vad, silence(200));
        const click = feedAll(vad, speech(60)); // 60 ms pop
        expect(click.speechStart).toBe(true);   // best-effort signal fires...
        const quiet = feedAll(vad, silence(600));
        expect(quiet.utterance).toBeNull();     // ...but no utterance is produced

        // Real speech afterwards still works in the same turn.
        const talk = feedAll(vad, speech(600));
        const tail = feedAll(vad, silence(600));
        expect(talk.speechStart || tail.speechStart).toBe(true);
        expect(tail.utterance).not.toBeNull();
    });

    it('caps a never-ending utterance at maxUtteranceMs', () => {
        const vad = new SimpleVad({ maxUtteranceMs: 1000, silenceMs: 60000 });
        vad.reset();
        const r = feedAll(vad, speech(2000));
        expect(r.utterance).not.toBeNull();
        const ms = (r.utterance!.length / 2 / RATE) * 1000;
        expect(ms).toBeLessThan(1700);
    });
});
