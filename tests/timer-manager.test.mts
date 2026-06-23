import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimerManager, TIMER_EVENT } from '../src/voice_assistant/timer-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

interface SentEvent {
    eventType: number;
    timerId: string;
    name: string;
    totalSeconds: number;
    secondsLeft: number;
    isActive: boolean;
}

// Minimal stand-in for EspVoiceAssistantClient — records the timer events sent.
class FakeEsp {
    public sent: SentEvent[] = [];
    public supportsTimers = true;
    sendTimerEvent(eventType: number, opts: Omit<SentEvent, 'eventType'>): void {
        this.sent.push({ eventType, ...opts } as SentEvent);
    }
}

describe('TimerManager', () => {
    let homey: any;
    let esp: FakeEsp;
    let tm: TimerManager;

    beforeEach(() => {
        vi.useFakeTimers();
        homey = new MockHomey();
        esp = new FakeEsp();
        tm = new TimerManager(homey, esp as any);
    });

    afterEach(() => {
        tm.dispose();
        vi.useRealTimers();
    });

    it('starts a timer and sends STARTED', () => {
        const res = tm.startTimer(1200, 'pasta');
        expect(res.ok).toBe(true);
        expect(tm.hasActiveTimer()).toBe(true);
        expect(esp.sent).toHaveLength(1);
        expect(esp.sent[0].eventType).toBe(TIMER_EVENT.STARTED);
        expect(esp.sent[0].totalSeconds).toBe(1200);
        expect(esp.sent[0].name).toBe('pasta');
        expect(esp.sent[0].isActive).toBe(true);
    });

    it('rejects an invalid duration', () => {
        const res = tm.startTimer(0);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.code).toBe('INVALID_DURATION');
        expect(tm.hasActiveTimer()).toBe(false);
    });

    it('refuses a second timer with TIMER_ALREADY_ACTIVE and surfaces the running one', () => {
        tm.startTimer(600, 'first');
        const res = tm.startTimer(300, 'second');
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.code).toBe('TIMER_ALREADY_ACTIVE');
            expect(res.active?.name).toBe('first');
            expect(res.active?.seconds_left).toBeGreaterThan(0);
        }
        // No extra STARTED was sent for the rejected second timer.
        expect(esp.sent).toHaveLength(1);
    });

    it('replaces the running timer when replace=true (CANCELLED then STARTED)', () => {
        tm.startTimer(600, 'first');
        const res = tm.startTimer(300, 'second', true);
        expect(res.ok).toBe(true);
        const types = esp.sent.map(e => e.eventType);
        expect(types).toEqual([TIMER_EVENT.STARTED, TIMER_EVENT.CANCELLED, TIMER_EVENT.STARTED]);
        expect(tm.getActiveTimer()?.name).toBe('second');
    });

    it('cancels the running timer and sends CANCELLED', () => {
        tm.startTimer(600);
        const res = tm.cancelTimer();
        expect(res.ok).toBe(true);
        expect(tm.hasActiveTimer()).toBe(false);
        expect(esp.sent.at(-1)?.eventType).toBe(TIMER_EVENT.CANCELLED);
    });

    it('returns NO_ACTIVE_TIMER when cancelling with no timer', () => {
        const res = tm.cancelTimer();
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.code).toBe('NO_ACTIVE_TIMER');
    });

    it('sends FINISHED when the countdown elapses and keeps the record so the ring can be silenced', () => {
        tm.startTimer(5);
        vi.advanceTimersByTime(5000);
        const last = esp.sent.at(-1);
        expect(last?.eventType).toBe(TIMER_EVENT.FINISHED);
        expect(last?.secondsLeft).toBe(0);
        // Record kept (finished) so cancel_timer can stop the looping chime.
        const active = tm.getActiveTimer();
        expect(active?.finished).toBe(true);
        const cancel = tm.cancelTimer();
        expect(cancel.ok).toBe(true);
        expect(esp.sent.at(-1)?.eventType).toBe(TIMER_EVENT.CANCELLED);
    });

    it('starts a new timer over a finished (ringing) one without asking to replace', () => {
        tm.startTimer(5, 'first');
        vi.advanceTimersByTime(5000); // first timer finishes and is ringing
        expect(tm.getActiveTimer()?.finished).toBe(true);
        esp.sent = [];

        // No replace flag — a finished timer is not a real conflict.
        const res = tm.startTimer(300, 'second');
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.timer.name).toBe('second');
        // Ring of the finished timer silenced (CANCELLED) then new timer STARTED.
        const types = esp.sent.map(e => e.eventType);
        expect(types).toEqual([TIMER_EVENT.CANCELLED, TIMER_EVENT.STARTED]);
        expect(tm.getActiveTimer()?.finished).toBe(false);
    });

    it('re-issues STARTED with remaining time after a reconnect', () => {
        tm.startTimer(100);
        vi.advanceTimersByTime(40_000); // 40s elapsed
        esp.sent = [];
        tm.reissue();
        expect(esp.sent).toHaveLength(1);
        expect(esp.sent[0].eventType).toBe(TIMER_EVENT.STARTED);
        expect(esp.sent[0].secondsLeft).toBeLessThanOrEqual(60);
        expect(esp.sent[0].secondsLeft).toBeGreaterThan(55);
    });

    it('does not re-issue a finished timer', () => {
        tm.startTimer(5);
        vi.advanceTimersByTime(5000);
        esp.sent = [];
        tm.reissue();
        expect(esp.sent).toHaveLength(0);
    });
});
