/**
 * Minimal client for TypeSafe's System One endpoint (the Jev model).
 *
 * Raw fetch rather than @typesafe-ai/sdk: a voice turn cannot wait out a hung
 * request. The jev-test-001 benchmark saw TypeSafe occasionally hang a request
 * until the SDK's 10 s timeout fired and it retried — fine for a batch job,
 * dead air on a satellite. Here a slow request is HEDGED instead: an identical
 * duplicate is sent and whichever answers first wins — see systemOneBatch for
 * when.
 *
 * API reference: https://docs.typesafe.ai/api.md
 */

export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
// Pinned rather than jev-latest: the selection threshold/veto were tuned
// against jev-1.13 (jev-test-001), and a silent model bump would move them.
export const JEV_MODEL = 'jev-1.13.0';

export type ScoreQuestion = {
    type: 'score';
    instructions: unknown;
    criteria: unknown[];
};
export type ChoiceQuestion = {
    type: 'choice';
    instructions: unknown;
    criteria: Record<string, unknown>;
};
export type NoulQuestion = {
    type: 'noul';
    instructions: unknown;
    criteria?: { true?: unknown; false?: unknown };
};
export type Question = ScoreQuestion | ChoiceQuestion | NoulQuestion;

export type ScoreAnswer = {
    type: 'score';
    score: number;
    legend: Record<string, string>;
    probabilities: Record<string, number>;
    confidence: number;
};
export type ChoiceAnswer = {
    type: 'choice';
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
};
export type NoulAnswer = { type: 'noul'; noul: number };
export type Answer = ScoreAnswer | ChoiceAnswer | NoulAnswer;

export type SystemOneRequest = {
    state: unknown;
    questions: Record<string, Question>;
};
export type SystemOneResponse = {
    model: string;
    answers: Record<string, Answer>;
    usage: { input_tokens: number; output_tokens: number };
};

export class TypeSafeError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'TypeSafeError';
    }
}

export interface TypeSafeClientOptions {
    apiKey: string;
    model?: string;
    /** Per-attempt timeout (also capped by what is left of `deadlineMs`). */
    timeoutMs?: number;
    /** A whole batch gives up this long after it started. */
    deadlineMs?: number;
    /** Attempts per request, the first included. */
    maxAttempts?: number;
    /** A new attempt is not started with less than this left before the deadline. */
    minAttemptMs?: number;
    /** A LONE request gets another attempt when its newest has not answered by then. */
    hedgeAfterMs?: number;
    /** A batch where nothing has answered yet gets extra attempts only this late. */
    batchFallbackMs?: number;
    /** In a batch, re-send a request slower than this × the median answered one… */
    hedgeFactor?: number;
    /** …but never sooner than this after its previous attempt. */
    minHedgeMs?: number;
    fetchImpl?: typeof fetch;
}

export interface RequestStat {
    /** Wall time from batch start until this request's answer. */
    ms: number;
    /** Attempts started for it (1 = no re-send). */
    attempts: number;
}

export interface BatchResult {
    responses: SystemOneResponse[];
    stats: RequestStat[];
}

export class TypeSafeClient {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly timeoutMs: number;
    private readonly deadlineMs: number;
    private readonly maxAttempts: number;
    private readonly minAttemptMs: number;
    private readonly hedgeAfterMs: number;
    private readonly batchFallbackMs: number;
    private readonly hedgeFactor: number;
    private readonly minHedgeMs: number;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: TypeSafeClientOptions) {
        this.apiKey = opts.apiKey;
        this.model = opts.model ?? JEV_MODEL;
        this.timeoutMs = opts.timeoutMs ?? 4_000;
        this.deadlineMs = opts.deadlineMs ?? 6_000;
        this.maxAttempts = opts.maxAttempts ?? 3;
        this.minAttemptMs = opts.minAttemptMs ?? 800;
        this.hedgeAfterMs = opts.hedgeAfterMs ?? 1_500;
        this.batchFallbackMs = opts.batchFallbackMs ?? 3_000;
        this.hedgeFactor = opts.hedgeFactor ?? 1.5;
        this.minHedgeMs = opts.minHedgeMs ?? 600;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }

    async systemOne(request: SystemOneRequest): Promise<SystemOneResponse> {
        return (await this.systemOneBatch([request])).responses[0];
    }

    /**
     * Run requests in parallel. Each request may get up to `maxAttempts`
     * identical attempts, and whichever answers first wins (the rest are
     * aborted); the whole batch gives up at `deadlineMs`.
     *
     * WHEN to re-send is judged against the batch, not a fixed clock: live on a
     * Homey, a 5-request batch had three answers at 0.6-0.8 s and two
     * stragglers — while in another run ALL five took 2.2-2.7 s because the
     * service itself was slow, where re-sending everything only doubles load.
     * So once some requests have answered, a pending request gets another
     * attempt when its newest one has run `hedgeFactor` × the median answer
     * time (never sooner than `minHedgeMs`); until then only after
     * `batchFallbackMs` (`hedgeAfterMs` for a lone request, which has no
     * siblings to compare with). A third attempt exists because a live run had
     * BOTH copies of one request hang until the 4 s timeout.
     *
     * A failure a repeat can fix (timeout, 429/529, 5xx, network) re-sends at
     * once; 401/422 fail the whole batch immediately.
     */
    systemOneBatch(requests: SystemOneRequest[]): Promise<BatchResult> {
        type Slot = { attempts: number; lastLaunch: number; running: number; done: boolean; controllers: AbortController[]; lastError?: unknown };
        const slots: Slot[] = requests.map(() => ({ attempts: 0, lastLaunch: 0, running: 0, done: false, controllers: [] }));
        const responses: SystemOneResponse[] = [];
        const stats: RequestStat[] = [];
        const answeredMs: number[] = [];
        // Attempts still in flight — only these are ever aborted.
        const live = new Set<AbortController>();
        const started = Date.now();
        const remaining = () => this.deadlineMs - (Date.now() - started);

        return new Promise<BatchResult>((resolve, reject) => {
            let over = false;
            let pending = requests.length;
            const ticker = setInterval(() => evaluate(), 50);

            const end = () => {
                over = true;
                clearInterval(ticker);
                for (const c of live) c.abort();
            };
            const fail = (i: number, error: unknown) => {
                if (over) return;
                end();
                const slot = slots[i];
                const detail = error instanceof Error ? error.message : String(error);
                reject(new TypeSafeError(
                    `request ${i + 1}/${requests.length} failed after ${slot.attempts} attempt(s) in ${Date.now() - started} ms: ${detail}`,
                    error instanceof TypeSafeError ? error.status : undefined,
                ));
            };
            const hedgeThreshold = (): number => {
                if (answeredMs.length === 0) {
                    return requests.length === 1 ? this.hedgeAfterMs : this.batchFallbackMs;
                }
                const sorted = [...answeredMs].sort((a, b) => a - b);
                const median = sorted[Math.floor(sorted.length / 2)];
                return Math.max(this.minHedgeMs, median * this.hedgeFactor);
            };
            const canLaunch = (slot: Slot) =>
                !over && !slot.done && slot.attempts < this.maxAttempts && remaining() >= this.minAttemptMs;
            const evaluate = () => {
                if (over) return;
                const threshold = hedgeThreshold();
                const now = Date.now();
                slots.forEach((slot, i) => {
                    if (canLaunch(slot) && now - slot.lastLaunch >= threshold) launch(i);
                });
            };
            const launch = (i: number) => {
                const slot = slots[i];
                const controller = new AbortController();
                slot.attempts++;
                slot.lastLaunch = Date.now();
                slot.running++;
                slot.controllers.push(controller);
                live.add(controller);
                const timeout = Math.max(1, Math.min(this.timeoutMs, remaining()));
                this.once(requests[i], controller, timeout).finally(() => live.delete(controller)).then(
                    (response) => {
                        if (over || slot.done) return;
                        slot.done = true;
                        for (const c of slot.controllers) if (live.has(c)) c.abort();
                        const ms = Date.now() - started;
                        responses[i] = response;
                        stats[i] = { ms, attempts: slot.attempts };
                        answeredMs.push(ms);
                        if (--pending === 0) {
                            end();
                            resolve({ responses, stats });
                        } else {
                            evaluate();
                        }
                    },
                    (error) => {
                        slot.running--;
                        if (over || slot.done) return;
                        slot.lastError = error;
                        if (!TypeSafeClient.retryable(error)) fail(i, error);
                        else if (canLaunch(slot)) launch(i);
                        else if (slot.running === 0) fail(i, slot.lastError);
                    },
                );
            };

            requests.forEach((_, i) => launch(i));
            if (requests.length === 0) {
                end();
                resolve({ responses, stats });
            }
        });
    }

    /** 401/422 and other 4xx will not get better on a repeat. */
    private static retryable(error: unknown): boolean {
        if (!(error instanceof TypeSafeError) || error.status === undefined) return true;
        return error.status === 429 || error.status === 529 || error.status >= 500;
    }

    private async once(request: SystemOneRequest, controller: AbortController, timeoutMs: number): Promise<SystemOneResponse> {
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        try {
            const res = await this.fetchImpl(TYPESAFE_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ model: this.model, ...request }),
                signal: controller.signal,
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new TypeSafeError(`TypeSafe HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
            }
            return await res.json() as SystemOneResponse;
        } catch (error: any) {
            if (error?.name === 'AbortError') {
                throw new TypeSafeError(timedOut
                    ? `TypeSafe request timed out after ${timeoutMs} ms`
                    : 'TypeSafe request aborted');
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}
