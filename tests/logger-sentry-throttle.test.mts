import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../src/helpers/logger.mjs';

// The Sentry report throttle in Logger.reportError: repeats of the same error
// (same logger + name + code) within the cooldown must not reach
// homeyLog.captureException again, while distinct errors still get through.

function mockHomey() {
    return { log: vi.fn(), error: vi.fn() } as any;
}

function mockHomeyLog() {
    return {
        captureException: vi.fn(async () => 'event-id'),
        captureMessage: vi.fn(async () => 'event-id'),
    };
}

function netError(code: string, message: string): Error {
    const err = new Error(message);
    (err as any).code = code;
    return err;
}

describe('Logger Sentry throttle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reports the first error and suppresses same-code repeats within the cooldown', () => {
        vi.setSystemTime(new Date('2026-07-11T10:00:00Z'));
        const homeyLog = mockHomeyLog();
        const logger = createLogger('THROTTLE-A');
        logger.setHomey(mockHomey(), homeyLog);

        logger.error('TCP connection error', netError('EHOSTUNREACH', 'connect EHOSTUNREACH 10.0.0.52:6053'));
        expect(homeyLog.captureException).toHaveBeenCalledTimes(1);

        // Same code, different host/port in the message — still a repeat.
        for (let i = 0; i < 50; i++) {
            vi.advanceTimersByTime(10_000);
            logger.error('TCP connection error', netError('EHOSTUNREACH', `connect EHOSTUNREACH 10.0.0.${i}:6053`));
        }
        expect(homeyLog.captureException).toHaveBeenCalledTimes(1);
    });

    it('reports again once the cooldown has elapsed', () => {
        vi.setSystemTime(new Date('2026-07-11T11:00:00Z'));
        const homeyLog = mockHomeyLog();
        const logger = createLogger('THROTTLE-B');
        logger.setHomey(mockHomey(), homeyLog);

        logger.error('TCP connection error', netError('ETIMEDOUT', 'connect ETIMEDOUT 10.0.0.52:6053'));
        vi.advanceTimersByTime(60 * 60 * 1000);
        logger.error('TCP connection error', netError('ETIMEDOUT', 'connect ETIMEDOUT 10.0.0.52:6053'));

        expect(homeyLog.captureException).toHaveBeenCalledTimes(2);
    });

    it('does not throttle errors with a different code or from a different logger', () => {
        vi.setSystemTime(new Date('2026-07-11T12:00:00Z'));
        const homeyLog = mockHomeyLog();
        const loggerA = createLogger('THROTTLE-C');
        const loggerB = createLogger('THROTTLE-D');
        loggerA.setHomey(mockHomey(), homeyLog);

        loggerA.error('TCP connection error', netError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.52:6053'));
        loggerA.error('TCP connection error', netError('ECONNRESET', 'read ECONNRESET'));
        loggerB.error('TCP connection error', netError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.52:6053'));

        expect(homeyLog.captureException).toHaveBeenCalledTimes(3);
    });

    it('distinguishes code-less errors by log message', () => {
        vi.setSystemTime(new Date('2026-07-11T13:00:00Z'));
        const homeyLog = mockHomeyLog();
        const logger = createLogger('THROTTLE-E');
        logger.setHomey(mockHomey(), homeyLog);

        logger.error('Failed to decode frame', new Error('boom'));
        logger.error('Error closing mic socket:', new Error('boom'));
        // Repeat of the first one — suppressed.
        logger.error('Failed to decode frame', new Error('boom'));

        expect(homeyLog.captureException).toHaveBeenCalledTimes(2);
    });
});
