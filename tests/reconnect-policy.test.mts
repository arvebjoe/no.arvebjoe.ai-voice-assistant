import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ReconnectPolicy } from '../src/llm/reconnect-policy.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

// Attempt N's delay is base*2^(N-1) with ±25% jitter, floored at base.
// Advancing by the max possible delay for that attempt fires the timer.
const maxDelay = (attempt: number, base = 1000) => Math.ceil(base * Math.pow(2, attempt - 1) * 1.25);

describe('ReconnectPolicy', () => {
    let homey: MockHomey;

    beforeEach(() => {
        vi.useFakeTimers();
        homey = new MockHomey();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function makePolicy(connect: () => Promise<void>, hooks: { onScheduled?: any; onAttemptFailed?: any } = {}) {
        return new ReconnectPolicy(homey as any, { connect, ...hooks });
    }

    it('runs connect() after the backoff delay and reports the attempt via onScheduled', async () => {
        const connect = vi.fn(async () => { });
        const onScheduled = vi.fn();
        const policy = makePolicy(connect, { onScheduled });

        policy.schedule();
        expect(policy.isActive).toBe(true);
        expect(policy.attemptCount).toBe(1);
        expect(onScheduled).toHaveBeenCalledWith(1, expect.any(Number));
        expect(connect).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(maxDelay(1));
        expect(connect).toHaveBeenCalledTimes(1);
    });

    it('coalesces schedule() calls while an attempt is already pending', async () => {
        const connect = vi.fn(async () => { });
        const policy = makePolicy(connect);

        policy.schedule();
        policy.schedule();
        policy.schedule();
        expect(policy.attemptCount).toBe(1);

        await vi.advanceTimersByTimeAsync(maxDelay(1));
        expect(connect).toHaveBeenCalledTimes(1);
    });

    it('a throwing connect() reports the failure and schedules the next attempt itself', async () => {
        const connect = vi.fn(async () => { throw new Error('offline'); });
        const onAttemptFailed = vi.fn();
        const policy = makePolicy(connect, { onAttemptFailed });

        policy.schedule();
        await vi.advanceTimersByTimeAsync(maxDelay(1));
        expect(onAttemptFailed).toHaveBeenCalledWith(1, expect.any(Error));
        expect(policy.attemptCount).toBe(2); // next attempt already scheduled

        await vi.advanceTimersByTimeAsync(maxDelay(2));
        expect(connect).toHaveBeenCalledTimes(2);
        expect(policy.attemptCount).toBe(3);
    });

    it('stays schedulable while active — the transport close handler drives the campaign (C2 shape)', async () => {
        // connect() "succeeds" (start() never rejects on async connect failure);
        // the transport's close event calls schedule() again. That call must not
        // be blocked by the campaign being active.
        const connect = vi.fn(async () => { });
        const policy = makePolicy(connect);

        policy.schedule();
        await vi.advanceTimersByTimeAsync(maxDelay(1));
        expect(connect).toHaveBeenCalledTimes(1);
        expect(policy.isActive).toBe(true); // still active until reset()

        policy.schedule(); // the async close event of the failed socket
        await vi.advanceTimersByTimeAsync(maxDelay(2));
        expect(connect).toHaveBeenCalledTimes(2);
    });

    it('reset() ends the campaign: cancels the pending timer and restarts the backoff', async () => {
        const connect = vi.fn(async () => { });
        const onScheduled = vi.fn();
        const policy = makePolicy(connect, { onScheduled });

        policy.schedule();
        policy.schedule(); // coalesced
        policy.reset();
        expect(policy.isActive).toBe(false);
        expect(policy.attemptCount).toBe(0);

        await vi.advanceTimersByTimeAsync(maxDelay(1));
        expect(connect).not.toHaveBeenCalled(); // pending attempt was cancelled

        policy.schedule(); // a fresh campaign starts over at attempt 1
        expect(onScheduled).toHaveBeenLastCalledWith(1, expect.any(Number));
    });

    it('clearTimer() drops only the pending attempt, not the campaign', async () => {
        const connect = vi.fn(async () => { });
        const policy = makePolicy(connect);

        policy.schedule();
        policy.clearTimer(); // manual start() supersedes the scheduled attempt
        expect(policy.isActive).toBe(true);
        expect(policy.attemptCount).toBe(1);

        await vi.advanceTimersByTimeAsync(maxDelay(1));
        expect(connect).not.toHaveBeenCalled();

        policy.schedule(); // e.g. that manual start's socket also died
        expect(policy.attemptCount).toBe(2);
        await vi.advanceTimersByTimeAsync(maxDelay(2));
        expect(connect).toHaveBeenCalledTimes(1);
    });

    it('caps the backoff at maxDelayMs', async () => {
        const connect = vi.fn(async () => { throw new Error('still offline'); });
        const onScheduled = vi.fn();
        const policy = new ReconnectPolicy(homey as any, { connect, onScheduled }, undefined, { baseDelayMs: 1000, maxDelayMs: 4000 });

        policy.schedule();
        for (let i = 0; i < 6; i++) {
            await vi.advanceTimersByTimeAsync(5000); // > 4000 * 1.25
        }
        // Attempts 3+ would be 4000, 8000, 16000... uncapped; all delays must
        // stay within the cap plus jitter.
        for (const [, delay] of onScheduled.mock.calls) {
            expect(delay).toBeLessThanOrEqual(5000);
        }
        expect(connect.mock.calls.length).toBeGreaterThanOrEqual(5);
    });
});
