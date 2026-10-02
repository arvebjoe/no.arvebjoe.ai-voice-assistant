import { describe, it, expect, vi } from 'vitest';
import { TypeSafeClient, TypeSafeError } from '../src/llm/jev/typesafe-client.mjs';

const ok = (tag: string) => new Response(JSON.stringify({ model: tag, answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });

/** A fetch whose Nth call resolves after delays[N] ms (or never, for null), honoring abort. */
function scriptedFetch(delays: (number | null)[], respond: (n: number) => Response = (n) => ok(`attempt-${n}`)) {
    let calls = 0;
    const aborted: number[] = [];
    const fetchImpl = vi.fn((_url: string, init: any) => {
        const n = calls++;
        return new Promise<Response>((resolve, reject) => {
            init.signal.addEventListener('abort', () => {
                aborted.push(n);
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
            const delay = delays[n];
            if (delay !== null && delay !== undefined) setTimeout(() => resolve(respond(n)), delay);
        });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls: () => calls, aborted };
}

const request = { state: 'x', questions: {} };

describe('TypeSafeClient hedging', () => {
    it('sends no duplicate when the first answer is quick', async () => {
        const f = scriptedFetch([10]);
        const client = new TypeSafeClient({ apiKey: 'k', fetchImpl: f.fetchImpl, hedgeAfterMs: 50 });
        const res = await client.systemOne(request);
        expect(res.model).toBe('attempt-0');
        await new Promise(r => setTimeout(r, 80));
        expect(f.calls()).toBe(1);
    });

    it('takes the duplicate when the first request straggles, and aborts the straggler', async () => {
        const f = scriptedFetch([null, 10]);
        const client = new TypeSafeClient({ apiKey: 'k', fetchImpl: f.fetchImpl, hedgeAfterMs: 30, timeoutMs: 1000 });
        const res = await client.systemOne(request);
        expect(res.model).toBe('attempt-1');
        expect(f.aborted).toEqual([0]);
    });

    it('fires the duplicate at once when the first fails with a retryable error', async () => {
        const f = scriptedFetch([5, 5], (n) => (n === 0 ? new Response('busy', { status: 529 }) : ok('second')));
        const client = new TypeSafeClient({ apiKey: 'k', fetchImpl: f.fetchImpl, hedgeAfterMs: 10_000 });
        const res = await client.systemOne(request);
        expect(res.model).toBe('second');
    });

    it('does not repeat a 401', async () => {
        const f = scriptedFetch([5], () => new Response('bad key', { status: 401 }));
        const client = new TypeSafeClient({ apiKey: 'k', fetchImpl: f.fetchImpl, hedgeAfterMs: 10_000 });
        await expect(client.systemOne(request)).rejects.toMatchObject({ status: 401 });
        expect(f.calls()).toBe(1);
    });

    it('fails when every attempt times out, naming the request and attempt count', async () => {
        const f = scriptedFetch([null, null, null]);
        const client = new TypeSafeClient({ apiKey: 'k', fetchImpl: f.fetchImpl, hedgeAfterMs: 10, timeoutMs: 40, minAttemptMs: 5 });
        const error = await client.systemOne(request).catch(e => e);
        expect(error).toBeInstanceOf(TypeSafeError);
        expect(error.message).toContain('request 1/1 failed after 3 attempt(s)');
        expect(error.message).toContain('timed out');
        expect(f.calls()).toBe(3);
    });

    it('a third attempt rescues a request whose first two copies hang', async () => {
        const f = scriptedFetch([null, null, 10]);
        const client = new TypeSafeClient({ apiKey: 'k', fetchImpl: f.fetchImpl, hedgeAfterMs: 20, timeoutMs: 1000, minAttemptMs: 5 });
        const { responses, stats } = await client.systemOneBatch([request]);
        expect(responses[0].model).toBe('attempt-2');
        expect(stats[0].attempts).toBe(3);
        expect(f.aborted.sort()).toEqual([0, 1]);
    });

    it('gives up at the batch deadline even when attempts would allow more', async () => {
        const f = scriptedFetch([null, null, null]);
        const client = new TypeSafeClient({ apiKey: 'k', fetchImpl: f.fetchImpl, deadlineMs: 150, hedgeAfterMs: 1000, timeoutMs: 5000, minAttemptMs: 50 });
        const t0 = Date.now();
        const error = await client.systemOne(request).catch(e => e);
        expect(Date.now() - t0).toBeLessThan(400);
        expect(error.message).toContain('timed out after 150 ms');
        expect(f.calls()).toBe(1);
    });

    it('in a batch, duplicates only the request lagging behind its siblings', async () => {
        // Calls 0-2 are the three requests; call 3 is the duplicate of #2.
        const f = scriptedFetch([10, 12, null, 10]);
        const client = new TypeSafeClient({ apiKey: 'k', fetchImpl: f.fetchImpl, minHedgeMs: 30, hedgeFactor: 1.5, batchFallbackMs: 10_000 });
        const { responses, stats } = await client.systemOneBatch([request, request, request]);
        expect(responses.map(r => r.model)).toEqual(['attempt-0', 'attempt-1', 'attempt-3']);
        expect(stats.map(s => s.attempts)).toEqual([1, 1, 2]);
        expect(f.aborted).toEqual([2]);
    });

    it('does not duplicate anything when the whole batch is uniformly slow', async () => {
        const f = scriptedFetch([120, 130, 125]);
        const client = new TypeSafeClient({ apiKey: 'k', fetchImpl: f.fetchImpl, minHedgeMs: 30, batchFallbackMs: 1000 });
        const { stats } = await client.systemOneBatch([request, request, request]);
        expect(stats.every(s => s.attempts === 1)).toBe(true);
        expect(f.calls()).toBe(3);
    });

    it('a non-retryable error in one request fails the batch and aborts the rest', async () => {
        const f = scriptedFetch([null, 5], (n) => new Response('bad', { status: 422 }));
        const client = new TypeSafeClient({ apiKey: 'k', fetchImpl: f.fetchImpl, batchFallbackMs: 10_000 });
        await expect(client.systemOneBatch([request, request])).rejects.toMatchObject({ status: 422 });
        expect(f.aborted).toEqual([0]);
    });
});
