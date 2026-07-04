/**
 * Shared auto-reconnect campaign with exponential backoff (Org 2).
 *
 * Both providers used to carry their own copy of this machinery, and the two
 * copies drifted (C2 lived only in the OpenAI copy). The policy owns the
 * attempt counter, the pending timer and the backoff/jitter math; the provider
 * owns the transport and decides WHEN to call in:
 *
 *   - transport closed unexpectedly            -> schedule()
 *   - transport confirmed up (open event)      -> reset()
 *   - manual close()/destroy()                 -> reset()
 *   - manual start() superseding a retry timer -> clearTimer()
 *   - opportunistic kick (e.g. dropped frame)  -> schedule() gated on !isActive
 *
 * A connect() that throws re-schedules itself. A connect() that "succeeds" but
 * whose socket later dies re-enters through the transport's close handler
 * calling schedule() again — that path is what keeps the campaign alive across
 * repeated failures (the C2 fix), so schedule() must stay callable while a
 * campaign is active; only a duplicate PENDING timer is coalesced.
 */

export type ReconnectHooks = {
    /** One connection attempt. May throw (sync or async) — that counts as a failed attempt. */
    connect: () => Promise<void>;
    /** An attempt was scheduled (providers emit "reconnecting"). */
    onScheduled?: (attempt: number, delayMs: number) => void;
    /** connect() threw (providers emit "reconnectFailed"). The next attempt is already being scheduled. */
    onAttemptFailed?: (attempt: number, error: Error) => void;
};

type TimerHost = {
    setTimeout: (fn: (...args: any[]) => void, ms: number) => any;
    clearTimeout: (id: any) => void;
};

export class ReconnectPolicy {
    private attempts = 0;
    private timerId: any = null;
    private active = false;

    constructor(
        private homey: TimerHost,
        private hooks: ReconnectHooks,
        private logger?: { info: (...args: any[]) => void },
        private tuning: { baseDelayMs?: number; maxDelayMs?: number } = {},
    ) { }

    /** True from the first schedule() until reset(): a pending timer OR an attempt in flight. */
    get isActive(): boolean {
        return this.active;
    }

    /** Attempts since the last reset(). Non-zero in the open handler means "this was a reconnect". */
    get attemptCount(): number {
        return this.attempts;
    }

    /** Schedule the next attempt. Coalesces onto an already-pending timer. */
    schedule(): void {
        if (this.timerId) {
            return;
        }
        this.active = true;
        this.attempts++;

        const base = this.tuning.baseDelayMs ?? 1000;
        const max = this.tuning.maxDelayMs ?? 30000;
        const backoff = Math.min(base * Math.pow(2, this.attempts - 1), max);
        // ±25% jitter (floored at the base delay) to avoid thundering-herd retries.
        const jitter = backoff * 0.25 * (Math.random() - 0.5);
        const delay = Math.max(base, backoff + jitter);

        this.logger?.info(`Scheduling reconnect attempt ${this.attempts} in ${Math.round(delay)}ms`, 'RECONNECT');
        this.hooks.onScheduled?.(this.attempts, delay);

        this.timerId = this.homey.setTimeout(async () => {
            this.timerId = null;
            try {
                await this.hooks.connect();
            } catch (error) {
                this.logger?.info(`Reconnect attempt ${this.attempts} failed:`, 'RECONNECT', error);
                this.hooks.onAttemptFailed?.(this.attempts, error as Error);
                this.schedule();
            }
        }, delay);
    }

    /**
     * End the campaign: clear any pending timer, zero the attempt counter.
     * Call on a confirmed open (backoff restarts fresh next time) and on
     * manual close/destroy (no further attempts wanted).
     */
    reset(): void {
        this.clearTimer();
        this.attempts = 0;
        this.active = false;
    }

    /** Clear only the pending timer — a manual start() supersedes the scheduled attempt. */
    clearTimer(): void {
        if (this.timerId) {
            this.homey.clearTimeout(this.timerId);
            this.timerId = null;
        }
    }
}
