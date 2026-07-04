import { describe, it, expect, vi } from 'vitest';

// Passthrough "FLAC" so buffers stay byte-identical through the pipeline.
vi.mock('../src/helpers/audio-encoders.mjs', () => ({
    pcmToFlacBuffer: async (b: any) => (Buffer.isBuffer(b) ? b : Buffer.from(b)),
}));

import { AudioOutputPipeline } from '../src/homey/audio-output-pipeline.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

function makePipeline(opts: { delayByFirstByte?: Record<number, number> } = {}) {
    const homey = new MockHomey();
    const built: Buffer[] = [];
    const webServer = {
        async buildStream(audioData: any) {
            const data: Buffer = audioData.data;
            built.push(data);
            const delay = opts.delayByFirstByte?.[data[0]] ?? 0;
            if (delay > 0) await tick(delay);
            return { filename: `f.flac`, filepath: `/tmp/f.flac`, url: `http://x/${data[0]}` };
        },
    };
    const logger = { error: vi.fn() };
    const pipeline = new AudioOutputPipeline(homey as any, webServer as any, logger);

    const segments: Array<{ url: string; action: string }> = [];
    pipeline.on('segment', ({ fileInfo, action }) => segments.push({ url: fileInfo.url, action }));
    const replies: any[] = [];
    pipeline.on('reply-done', (d) => replies.push(d));

    return { pipeline, homey, built, segments, replies, logger };
}

const chunk = (marker: number, len = 4) => {
    const b = Buffer.alloc(len);
    b[0] = marker;
    return b;
};

describe('AudioOutputPipeline', () => {
    describe('announce path', () => {
        it('emits the first segment as play and later ones as queued', async () => {
            const p = makePipeline();
            p.pipeline.segmenter.emit('chunk', chunk(1));
            p.pipeline.segmenter.emit('chunk', chunk(2));
            await tick(10);

            expect(p.segments).toEqual([
                { url: 'http://x/1', action: 'play' },
                { url: 'http://x/2', action: 'queued' },
            ]);
            expect(p.pipeline.isPlaying).toBe(true);
            expect(p.pipeline.queueLength).toBe(1);
        });

        it('serializes segments in emit order even when an earlier encode is slower (H-l)', async () => {
            const p = makePipeline({ delayByFirstByte: { 1: 30, 2: 0 } });
            p.pipeline.segmenter.emit('chunk', chunk(1));
            p.pipeline.segmenter.emit('chunk', chunk(2));
            await tick(80);

            expect(p.segments.map(s => s.url)).toEqual(['http://x/1', 'http://x/2']);
            expect(p.segments[0].action).toBe('play');
        });

        it('stamps playbackMs on segments (M9: 48 bytes/ms at PCM16 mono 24 kHz)', async () => {
            const p = makePipeline();
            const captured: any[] = [];
            p.pipeline.on('segment', ({ fileInfo }) => captured.push(fileInfo));
            p.pipeline.segmenter.emit('chunk', chunk(1, 4800));
            await tick(10);
            expect(captured[0].playbackMs).toBe(100);
        });

        it('announceFinished advances the queue and reports done when drained', async () => {
            const p = makePipeline();
            expect(p.pipeline.announceFinished().kind).toBe('ignore'); // nothing playing

            p.pipeline.segmenter.emit('chunk', chunk(1));
            p.pipeline.segmenter.emit('chunk', chunk(2));
            await tick(10);

            const next = p.pipeline.announceFinished();
            expect(next.kind).toBe('play');
            expect((next as any).fileInfo.url).toBe('http://x/2');
            expect(p.pipeline.isPlaying).toBe(true);

            expect(p.pipeline.announceFinished().kind).toBe('done');
            expect(p.pipeline.isPlaying).toBe(false);
            // Late acks (reopen/continue announces) are ignored after that.
            expect(p.pipeline.announceFinished().kind).toBe('ignore');
        });
    });

    describe('in-band path', () => {
        it('accumulates chunks and hands the concatenated PCM over on reply-done', async () => {
            const p = makePipeline();
            p.pipeline.beginTurn('inband');
            p.pipeline.segmenter.emit('chunk', Buffer.from([1, 2]));
            p.pipeline.segmenter.emit('chunk', Buffer.from([3, 4]));
            p.pipeline.segmenter.emit('done');
            await tick(5);

            expect(p.segments).toHaveLength(0); // nothing routed to announce
            expect(p.replies).toHaveLength(1);
            expect(p.replies[0].mode).toBe('inband');
            expect([...p.replies[0].pcm]).toEqual([1, 2, 3, 4]);
        });

        it('a stray second done cannot deliver a duplicate in-band reply', async () => {
            const p = makePipeline();
            p.pipeline.beginTurn('inband');
            p.pipeline.segmenter.emit('chunk', Buffer.from([1, 2]));
            p.pipeline.segmenter.emit('done');
            p.pipeline.segmenter.emit('done'); // stray
            await tick(5);

            expect(p.replies.map(r => r.mode)).toEqual(['inband', 'announce']);
        });

        it('cancelInband drops the buffer and reroutes to announce', async () => {
            const p = makePipeline();
            p.pipeline.beginTurn('inband');
            p.pipeline.segmenter.emit('chunk', Buffer.from([1, 2]));
            p.pipeline.cancelInband();
            p.pipeline.segmenter.emit('done');
            await tick(5);
            expect(p.replies[0]).toEqual({ mode: 'announce' });
        });

        it('buildReplyFile serves the file and schedules deletion extended by playback length (M2/M9)', async () => {
            const p = makePipeline();
            const timeoutSpy = vi.spyOn(p.homey, 'setTimeout');
            const file = await p.pipeline.buildReplyFile(Buffer.alloc(4800, 5));
            expect(file.url).toBe('http://x/5');
            expect(file.playbackMs).toBe(100);
            const ttlCalls = timeoutSpy.mock.calls.filter(c => (c[1] as number) >= 30_000);
            expect(ttlCalls).toHaveLength(1);
            expect(ttlCalls[0][1]).toBe(30_100);
            timeoutSpy.mockRestore();
        });
    });

    describe('abort', () => {
        it('drops queued segments and reports whether playback was active', async () => {
            const p = makePipeline();
            p.pipeline.segmenter.emit('chunk', chunk(1));
            p.pipeline.segmenter.emit('chunk', chunk(2));
            await tick(10);

            expect(p.pipeline.abort().wasActive).toBe(true);
            expect(p.pipeline.isPlaying).toBe(false);
            expect(p.pipeline.queueLength).toBe(0);
            expect(p.pipeline.abort().wasActive).toBe(false); // idempotent
        });

        it('a segment still encoding when abort hits never plays (generation guard)', async () => {
            const p = makePipeline({ delayByFirstByte: { 1: 30 } });
            p.pipeline.segmenter.emit('chunk', chunk(1)); // encode in flight
            p.pipeline.abort();
            await tick(60);
            expect(p.segments).toHaveLength(0); // stale segment dropped, not played late
        });

        it('drops accumulated in-band PCM', async () => {
            const p = makePipeline();
            p.pipeline.beginTurn('inband');
            p.pipeline.segmenter.emit('chunk', Buffer.from([1, 2]));
            p.pipeline.abort();
            p.pipeline.segmenter.emit('done');
            await tick(5);
            // Mode reset to announce; the stale PCM is gone.
            expect(p.replies[0]).toEqual({ mode: 'announce' });
        });
    });
});
