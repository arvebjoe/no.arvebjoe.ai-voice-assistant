import { createLogger } from '../helpers/logger.mjs';
import type { EspVoiceAssistantClient } from './esp-voice-assistant-client.mjs';

/**
 * VoiceAssistantTimerEvent enum values (api.proto). These are sent inside a
 * VoiceAssistantTimerEventResponse (id 115) to drive the PE's on-device timer:
 * LED-ring countdown + finish chime. See
 * docs/home-assistant-voice-preview-edition/timer-feature.md.
 */
export const TIMER_EVENT = {
  STARTED: 0,
  UPDATED: 1,
  CANCELLED: 2,
  FINISHED: 3,
} as const;

export interface TimerSummary {
  id: string;
  name: string;
  total_seconds: number;
  seconds_left: number;
  is_active: boolean;
  /** FINISHED has been sent; the device is ringing until cancelled or button-pressed. */
  finished: boolean;
}

interface ActiveTimer {
  id: string;
  name: string;
  totalSeconds: number;
  endAt: number;                 // epoch ms when the countdown elapses
  timeout: NodeJS.Timeout | null;
  isActive: boolean;             // running (true) vs paused (false) — we never pause for now
  finished: boolean;             // FINISHED sent, device ring may be sounding
}

type StartResult =
  | { ok: true; timer: TimerSummary }
  | { ok: false; code: string; message: string; active?: TimerSummary };

type CancelResult =
  | { ok: true; cancelled: TimerSummary }
  | { ok: false; code: string; message: string };

/**
 * Owns the single authoritative countdown for a voice device. The PE renders
 * whatever we send (it ticks its own copy of the ring for display) but it never
 * rings on its own — only when WE send a FINISHED event. So this class holds a
 * real homey.setTimeout and fires FINISHED when the countdown elapses.
 *
 * Only ONE timer may exist at a time (product decision). starting a second one
 * while one is active returns TIMER_ALREADY_ACTIVE unless `replace` is set, so
 * the agent can ask the user what to do.
 */
export class TimerManager {
  private homey: any;
  private esp: EspVoiceAssistantClient;
  private timer: ActiveTimer | null = null;
  private seq = 0;
  private logger = createLogger('TimerManager', false);

  constructor(homey: any, esp: EspVoiceAssistantClient) {
    this.homey = homey;
    this.esp = esp;
  }

  private secondsLeft(t: ActiveTimer): number {
    return Math.max(0, Math.ceil((t.endAt - Date.now()) / 1000));
  }

  private summary(t: ActiveTimer): TimerSummary {
    return {
      id: t.id,
      name: t.name,
      total_seconds: t.totalSeconds,
      seconds_left: this.secondsLeft(t),
      is_active: t.isActive,
      finished: t.finished,
    };
  }

  hasActiveTimer(): boolean {
    return this.timer !== null;
  }

  getActiveTimer(): TimerSummary | null {
    return this.timer ? this.summary(this.timer) : null;
  }

  /**
   * Start a countdown. Returns TIMER_ALREADY_ACTIVE (with the current timer)
   * if one is running and `replace` is false, so the agent can ask the user.
   */
  startTimer(durationSeconds: number, name: string = '', replace: boolean = false): StartResult {
    durationSeconds = Math.floor(durationSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return { ok: false, code: 'INVALID_DURATION', message: 'Timer duration must be a positive number of seconds.' };
    }

    if (this.timer) {
      // A finished timer is just leftover (its ring may still be sounding). It's
      // not a real conflict — silence it and start the new one without asking.
      if (this.timer.finished) {
        this.clearTimer(true);
      } else if (!replace) {
        return {
          ok: false,
          code: 'TIMER_ALREADY_ACTIVE',
          message: 'A timer is already running. Only one timer can exist at a time. Ask the user whether to replace it before retrying with replace=true.',
          active: this.summary(this.timer),
        };
      } else {
        // Replacing a running timer: silence/remove it (and its ring) first.
        this.clearTimer(true);
      }
    }

    if (!this.esp.supportsTimers) {
      this.logger.warn('Device did not advertise TIMERS feature flag — sending timer events anyway (PE supports them).');
    }

    const id = `timer-${++this.seq}-${Date.now()}`;
    const t: ActiveTimer = {
      id,
      name: name || '',
      totalSeconds: durationSeconds,
      endAt: Date.now() + durationSeconds * 1000,
      timeout: null,
      isActive: true,
      finished: false,
    };
    this.timer = t;

    // We are authoritative: our own timer decides when it's up, then we tell
    // the device to ring. The device's local tick is display-only.
    t.timeout = this.homey.setTimeout(() => this.onFinish(id), durationSeconds * 1000);

    this.sendEvent(TIMER_EVENT.STARTED, t);
    this.logger.info(`Timer started: ${durationSeconds}s${name ? ` ("${name}")` : ''}`);
    return { ok: true, timer: this.summary(t) };
  }

  /**
   * Cancel the active timer. Also stops the finish chime if the timer has
   * already finished and the device is ringing.
   */
  cancelTimer(): CancelResult {
    if (!this.timer) {
      return { ok: false, code: 'NO_ACTIVE_TIMER', message: 'There is no timer to cancel.' };
    }
    const summary = this.summary(this.timer);
    this.clearTimer(true);
    this.logger.info('Timer cancelled');
    return { ok: true, cancelled: summary };
  }

  /**
   * Re-issue STARTED for a still-running timer after an ESP reconnect — the
   * device clears its timers on disconnect, so the ring must be re-armed. Our
   * own setTimeout keeps running across the disconnect, so the remaining time
   * stays correct.
   */
  reissue(): void {
    const t = this.timer;
    if (!t || t.finished) {
      return;
    }
    const left = this.secondsLeft(t);
    if (left <= 0) {
      return;
    }
    this.sendEvent(TIMER_EVENT.STARTED, t, left);
    this.logger.info(`Re-issued STARTED after reconnect (${left}s left)`);
  }

  /** Stop and forget the timer without sending CANCELLED (used on teardown). */
  dispose(): void {
    this.clearTimer(false);
  }

  private onFinish(id: string): void {
    const t = this.timer;
    if (!t || t.id !== id) {
      return;
    }
    t.timeout = null;
    t.isActive = false;
    t.finished = true;
    // FINISHED makes the PE play its looping finish chime + LED alert. It keeps
    // ringing until we send CANCELLED (cancelTimer) or the user presses the
    // device button. We keep the record so cancelTimer can silence the ring.
    this.sendEvent(TIMER_EVENT.FINISHED, t, 0);
    this.logger.info('Timer finished — sent FINISHED, device is ringing');
  }

  private clearTimer(sendCancelled: boolean): void {
    const t = this.timer;
    if (!t) {
      return;
    }
    if (t.timeout) {
      this.homey.clearTimeout(t.timeout);
      t.timeout = null;
    }
    if (sendCancelled) {
      this.sendEvent(TIMER_EVENT.CANCELLED, t, this.secondsLeft(t));
    }
    this.timer = null;
  }

  private sendEvent(eventType: number, t: ActiveTimer, secondsLeftOverride?: number): void {
    const secondsLeft = secondsLeftOverride ?? this.secondsLeft(t);
    this.esp.sendTimerEvent(eventType, {
      timerId: t.id,
      name: t.name,
      totalSeconds: t.totalSeconds,
      secondsLeft,
      isActive: t.isActive,
    });
  }
}
