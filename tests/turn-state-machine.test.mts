import { describe, it, expect } from 'vitest';
import { TurnStateMachine } from '../src/homey/turn-state-machine.mjs';

/** Machine with a controllable clock. */
function makeMachine() {
    let t = 100_000;
    const machine = new TurnStateMachine(() => t);
    return { machine, advance: (ms: number) => { t += ms; }, nowMs: () => t };
}

const SKIP = { wakeSkipBytes: 1000, followupSkipBytes: 100 };

describe('TurnStateMachine', () => {
    describe('turn lifecycle and the duplicate-wake guard', () => {
        it('blocks a second startTurn only while listening', () => {
            const { machine } = makeMachine();
            expect(machine.canStartTurn()).toBe(true);
            machine.startTurn(SKIP);
            expect(machine.state).toBe('listening');
            expect(machine.canStartTurn()).toBe(false); // duplicate wake dropped

            machine.micClosed();
            expect(machine.state).toBe('thinking');
            expect(machine.canStartTurn()).toBe(true); // a new wake mid-reply is allowed (as before)
        });

        it('micClosed marks the pending intent, takeIntent consumes it once', () => {
            const { machine } = makeMachine();
            machine.startTurn(SKIP);
            expect(machine.takeIntent()).toBe(false);
            machine.micClosed();
            expect(machine.takeIntent()).toBe(true);
            expect(machine.takeIntent()).toBe(false);
        });
    });

    describe('context TTL (fresh conversation)', () => {
        it('the very first turn is not "fresh" (no previous turn to expire)', () => {
            const { machine } = makeMachine();
            expect(machine.startTurn(SKIP).freshConversation).toBe(false);
        });

        it('a quick follow-up keeps the context, a long idle clears it and the session', () => {
            const { machine, advance } = makeMachine();
            // Turn 1 ends with a question -> session open.
            machine.startTurn(SKIP);
            machine.micClosed();
            machine.addReplyDelta('Vil du høre mer?');
            machine.responseDone();
            expect(machine.finishAnnouncePlayback().reopenMic).toBe(true);

            // Reopen fires within ~1s: context kept, follow-up route.
            advance(1_000);
            const followUp = machine.startTurn(SKIP);
            expect(followUp.freshConversation).toBe(false);
            expect(followUp.followUp).toBe(true);

            // End this turn silently, then idle past the TTL.
            machine.transcriptDone('');
            advance(11_000);
            const fresh = machine.startTurn(SKIP);
            expect(fresh.freshConversation).toBe(true);
            expect(fresh.followUp).toBe(false); // session did not survive the gap
        });
    });

    describe('mic-skip accounting', () => {
        it('picks the wake skip on a plain turn and the follow-up skip on a reopen', () => {
            const { machine } = makeMachine();
            machine.startTurn(SKIP);
            // Wake skip = 1000 bytes: a 600-byte chunk is swallowed whole...
            expect(machine.consumeMicChunk(Buffer.alloc(600))).toBeNull();
            // ...the next 600-byte chunk is trimmed to its last 200 bytes.
            const trimmed = machine.consumeMicChunk(Buffer.alloc(600));
            expect(trimmed?.length).toBe(200);
            // Budget consumed: later chunks pass through untouched.
            expect(machine.consumeMicChunk(Buffer.alloc(600))?.length).toBe(600);
        });

        it('uses the smaller follow-up skip on a conversation reopen', () => {
            const { machine } = makeMachine();
            // Open the session (turn 1 ends in "?").
            machine.startTurn(SKIP);
            machine.micClosed();
            machine.addReplyDelta('Mer?');
            machine.responseDone();
            machine.finishAnnouncePlayback();

            machine.startTurn(SKIP); // follow-up
            const trimmed = machine.consumeMicChunk(Buffer.alloc(600));
            expect(trimmed?.length).toBe(500); // only 100 bytes skipped
        });

        it('drops chunks entirely when not listening', () => {
            const { machine } = makeMachine();
            expect(machine.consumeMicChunk(Buffer.alloc(600))).toBeNull(); // idle
            machine.startTurn({ wakeSkipBytes: 0, followupSkipBytes: 0 });
            expect(machine.consumeMicChunk(Buffer.alloc(600))?.length).toBe(600);
            machine.micClosed();
            expect(machine.consumeMicChunk(Buffer.alloc(600))).toBeNull(); // thinking
        });
    });

    describe('reply capture and the question heuristic', () => {
        it('detects a question only when the COMPLETE reply ends with one', () => {
            const { machine } = makeMachine();
            machine.startTurn(SKIP);
            // A mid-reply "?" (joke setup) must not latch.
            machine.addReplyDelta('Hvorfor kan ikke sykler stå oppreist? ');
            machine.addReplyDelta('Fordi de er totrøtte.');
            machine.responseDone();
            expect(machine.finishAnnouncePlayback().reopenMic).toBe(false);
        });

        it('ignores trailing quotes/brackets/markdown around the "?"', () => {
            const { machine } = makeMachine();
            machine.startTurn(SKIP);
            machine.addReplyDelta('Skal jeg fortsette?" *');
            machine.responseDone();
            expect(machine.finishAnnouncePlayback().reopenMic).toBe(true);
        });

        it('an empty response leaves the previous question decision untouched', () => {
            const { machine } = makeMachine();
            machine.startTurn(SKIP);
            machine.addReplyDelta('Vil du høre mer?');
            machine.responseDone();
            machine.responseDone(); // empty — must not clear the pending decision
            expect(machine.finishAnnouncePlayback().reopenMic).toBe(true);
        });

        it('responseDone returns the reply and hands it to the in-band delivery', () => {
            const { machine } = makeMachine();
            machine.startTurn(SKIP);
            machine.micClosed();
            machine.addReplyDelta('Her er svaret.');
            expect(machine.responseDone().reply).toBe('Her er svaret.');
            const delivery = machine.beginInbandDelivery();
            expect(delivery.replyText).toBe('Her er svaret.');
            expect(delivery.keepOpen).toBe(false);
        });
    });

    describe('spurious empty-turn retries', () => {
        function openSession(m: ReturnType<typeof makeMachine>) {
            m.machine.startTurn(SKIP);
            m.machine.micClosed();
            m.machine.addReplyDelta('Mer?');
            m.machine.responseDone();
            m.machine.finishAnnouncePlayback(); // reopen -> session open
        }

        it('retries an empty transcript arriving quickly after a follow-up mic-open', () => {
            const m = makeMachine();
            openSession(m);
            m.machine.startTurn(SKIP);
            m.advance(500); // well inside the spurious window
            const d = m.machine.transcriptDone('');
            expect(d.kind).toBe('spurious_retry');
            // The session survives a retry.
            expect(m.machine.startTurn(SKIP).followUp).toBe(true);
        });

        it('ends the session when the empty transcript arrives late (user really left)', () => {
            const m = makeMachine();
            openSession(m);
            m.machine.startTurn(SKIP);
            m.advance(5_000);
            expect(m.machine.transcriptDone('').kind).toBe('end_session');
            expect(m.machine.startTurn(SKIP).followUp).toBe(false);
        });

        it('bounds retries so a noisy room cannot hold the session open', () => {
            const m = makeMachine();
            openSession(m);
            for (const expected of ['spurious_retry', 'spurious_retry', 'end_session']) {
                m.machine.startTurn(SKIP);
                m.advance(100);
                expect(m.machine.transcriptDone('').kind).toBe(expected);
            }
        });

        it('a real answer restores the retry budget', () => {
            const m = makeMachine();
            openSession(m);
            m.machine.startTurn(SKIP);
            m.advance(100);
            expect(m.machine.transcriptDone('').kind).toBe('spurious_retry');

            // The retried turn hears a real answer...
            m.machine.startTurn(SKIP);
            expect(m.machine.transcriptDone('ja takk').kind).toBe('proceed');
            // ...reply ends in "?" -> in-band keep-open, session continues...
            m.machine.micClosed();
            m.machine.addReplyDelta('Neste?');
            m.machine.responseDone();
            const { keepOpen } = m.machine.beginInbandDelivery();
            m.machine.finishInbandDelivery(keepOpen, 0);
            // ...and the budget is back to two retries.
            for (const expected of ['spurious_retry', 'spurious_retry', 'end_session']) {
                m.machine.startTurn(SKIP);
                m.advance(100);
                expect(m.machine.transcriptDone('').kind).toBe(expected);
            }
        });

        it('hallucinated STT strings count as empty', () => {
            const m = makeMachine();
            m.machine.startTurn(SKIP);
            // A known silence-hallucination (from transcript-hallucinations list).
            expect(m.machine.transcriptDone('Undertekster av AI-Media').kind).toBe('end_session');
        });
    });

    describe('in-band delivery', () => {
        it('keepOpen mirrors the question decision and drives the session', () => {
            const { machine } = makeMachine();
            machine.startTurn(SKIP);
            machine.micClosed();
            machine.addReplyDelta('Vil du ha mer?');
            machine.responseDone();

            const { keepOpen } = machine.beginInbandDelivery();
            expect(keepOpen).toBe(true);
            expect(machine.takeIntent()).toBe(false); // intent consumed by the delivery
            machine.finishInbandDelivery(keepOpen, 3_000);
            expect(machine.state).toBe('idle');
            expect(machine.startTurn(SKIP).followUp).toBe(true); // session stayed open
        });

        it('stamps the turn end at END of playback, not send time', () => {
            const { machine, advance } = makeMachine();
            machine.startTurn(SKIP);
            machine.micClosed();
            machine.addReplyDelta('Et veldig langt svar. Mer?');
            machine.responseDone();
            const { keepOpen } = machine.beginInbandDelivery();
            machine.finishInbandDelivery(keepOpen, 9_000); // 9 s long reply

            // The PE reopens right after playback (9 s later) + 1 s: still within
            // the 10 s TTL measured from END of playback.
            advance(10_000);
            expect(machine.startTurn(SKIP).freshConversation).toBe(false);
        });
    });

    describe('abort', () => {
        it('resets every turn and session flag in one call', () => {
            const { machine } = makeMachine();
            machine.startTurn(SKIP);
            machine.micClosed();
            machine.addReplyDelta('Halvveis...');

            const { wasActive } = machine.abort();
            expect(wasActive).toBe(true);
            expect(machine.state).toBe('idle');
            expect(machine.canStartTurn()).toBe(true);       // no wake-death
            expect(machine.takeIntent()).toBe(false);        // intent cleared
            expect(machine.startTurn(SKIP).followUp).toBe(false); // session cleared
            expect(machine.responseDone().reply).toBe('');   // partial reply cleared
        });

        it('is idempotent and reports inactivity when idle', () => {
            const { machine } = makeMachine();
            expect(machine.abort().wasActive).toBe(false);
            expect(machine.abort().wasActive).toBe(false);
        });
    });

    describe('resetSession (say/ask flows)', () => {
        it('ends the PE session so the next turn uses the announce path', () => {
            const { machine } = makeMachine();
            machine.startTurn(SKIP);
            machine.micClosed();
            machine.addReplyDelta('Mer?');
            machine.responseDone();
            machine.finishAnnouncePlayback(); // session open

            machine.resetSession();
            expect(machine.startTurn(SKIP).followUp).toBe(false);
        });
    });
});
