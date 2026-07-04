import { isBlankOrHallucinatedTranscript } from '../llm/transcript-hallucinations.mjs';

/**
 * Named states of a conversation turn (Org 1). Only 'listening' gates anything
 * hard (the duplicate-wake guard); the others exist so the state is readable in
 * logs and tests instead of being implied by a soup of booleans.
 *
 *   idle       — no turn in flight
 *   listening  — mic streaming to the provider (was: isSteamingMic)
 *   thinking   — mic closed, waiting for/streaming the model's reply
 *   speaking   — reply playback started (announce first-play or in-band delivery)
 */
export type TurnState = 'idle' | 'listening' | 'thinking' | 'speaking';

export type TranscriptDecision =
    | { kind: 'proceed' }
    | { kind: 'spurious_retry'; turnMs: number; retry: number; maxRetries: number }
    | { kind: 'end_session' };

/**
 * All conversation-turn and PE-session state for a voice device, extracted from
 * voice-assistant-device.mts (Org 1). The device's event handlers became thin:
 * they call one method here per event and act on the returned decision; every
 * flag mutation lives in this class, and abort() is the single place that
 * resets a turn — the class of bug where an abort path forgot one flag (C1,
 * wake-death) can no longer be written by accident.
 *
 * Pure logic: no Homey, ESP or provider dependencies (clock injectable for
 * tests). The audio-output side (announce queue, in-band PCM) lives in
 * AudioOutputPipeline; the device composes the two.
 */
export class TurnStateMachine {
    private state_: TurnState = 'idle';

    // Set when the user's utterance ended (mic closed): the next reply delivery
    // owes the PE an INTENT_END. Consumed via takeIntent()/beginInbandDelivery().
    private hasIntent = false;

    // The finished reply ended in a question — reopen the mic after playback.
    // Decided on the COMPLETE reply in responseDone(), consumed exactly once at
    // delivery (finishAnnouncePlayback / beginInbandDelivery).
    private continueConversation = false;

    // True while the PE is in a start_conversation session: from the one
    // continue-conversation reopen until the session ends (silent turn or
    // context-TTL idle). While true, every turn replies in-band on TTS_END.
    private peConversationActive = false;

    // Accumulates the assistant's streamed reply (transcript or text deltas).
    private replyText = '';
    // The finished reply, captured on responseDone. The in-band TTS_START needs
    // it: the firmware discards a text-less TTS_START.
    private lastReplyText = '';

    // Wake-turn / follow-up-turn mic-skip accounting (bytes). The effective skip
    // is picked per turn in startTurn(); consumeMicChunk() trims against it.
    private skippedBytes = 0;
    private currentTurnSkipBytes = 0;

    private turnStartedAt = 0;
    private lastTurnEndedAt = 0;

    // Spurious empty-turn retries used in the current conversation. Bounded so a
    // noisy room (VAD tripping on background noise) can't hold the session open.
    private emptyTurnRetries = 0;
    private readonly MAX_EMPTY_TURN_RETRIES = 2;
    // An empty transcript arriving within this window of mic-open is a spurious
    // echo-trip (retry the mic), not the user declining to answer.
    private readonly SPURIOUS_TURN_MS = 2_500;
    // Idle gap after which the next wake starts a fresh conversation context.
    private readonly CONTEXT_TTL_MS = 10_000;

    constructor(private now: () => number = Date.now) { }

    get state(): TurnState {
        return this.state_;
    }

    /** Mic currently streaming (the old isSteamingMic). */
    get isListening(): boolean {
        return this.state_ === 'listening';
    }

    /** Duplicate-wake guard: a second 'starting' while the mic streams is dropped. */
    canStartTurn(): boolean {
        return this.state_ !== 'listening';
    }

    /**
     * Begin a turn (ESP 'starting'). Decides — in this order, mirroring the old
     * handler — whether the context TTL expired (fresh conversation: the caller
     * must reset the provider context), whether this is an in-band follow-up
     * turn, and which mic-skip applies (wake-ding skip vs the smaller follow-up
     * burst skip; the two are distinct signals, not a floor).
     */
    startTurn(cfg: { wakeSkipBytes: number; followupSkipBytes: number }): {
        freshConversation: boolean;
        followUp: boolean;
        idleMs: number;
    } {
        const now = this.now();
        const idleMs = now - this.lastTurnEndedAt;
        const freshConversation = this.lastTurnEndedAt > 0 && idleMs > this.CONTEXT_TTL_MS;
        if (freshConversation) {
            // Long gap => any prior start_conversation session is over.
            this.peConversationActive = false;
        }

        this.skippedBytes = 0;
        this.state_ = 'listening';
        this.turnStartedAt = now;
        // A fresh (non-follow-up) turn starts a new spurious-retry budget.
        if (!this.peConversationActive) {
            this.emptyTurnRetries = 0;
        }

        const followUp = this.peConversationActive;
        this.currentTurnSkipBytes = followUp ? cfg.followupSkipBytes : cfg.wakeSkipBytes;

        return { freshConversation, followUp, idleMs };
    }

    /**
     * Trim a mic chunk against this turn's skip budget and the listening gate.
     * Returns the bytes to forward, or null to drop the chunk entirely. Skip
     * accounting runs before the listening gate (as before), so early chunks
     * consume the budget even when not streaming.
     */
    consumeMicChunk(data: Buffer): Buffer | null {
        if (this.currentTurnSkipBytes && this.skippedBytes < this.currentTurnSkipBytes) {
            const remainingToSkip = this.currentTurnSkipBytes - this.skippedBytes;
            const bytesToSkip = Math.min(data.length, remainingToSkip);
            this.skippedBytes += bytesToSkip;
            if (bytesToSkip >= data.length) {
                return null;
            }
            data = data.subarray(bytesToSkip);
        }
        if (this.state_ !== 'listening') {
            return null;
        }
        return data;
    }

    /** The user stopped speaking (provider VAD): close of the listening phase. */
    micClosed(): void {
        this.hasIntent = true;
        if (this.state_ === 'listening') {
            this.state_ = 'thinking';
        }
    }

    /** Consume the pending-intent marker (INTENT_END owed to the PE). */
    takeIntent(): boolean {
        const had = this.hasIntent;
        this.hasIntent = false;
        return had;
    }

    /** Accumulate an assistant reply delta (audio transcript or text output). */
    addReplyDelta(delta: string): void {
        this.replyText += delta ?? '';
    }

    /**
     * The model's response finished. Captures the full reply and decides —
     * on the COMPLETE reply, never per-delta — whether it ends in a question
     * (ignoring trailing quotes/brackets/markdown). An empty reply leaves the
     * previous decision untouched (as before).
     */
    responseDone(): { reply: string } {
        const reply = this.replyText.trim();
        this.lastReplyText = reply;
        this.replyText = '';
        if (reply) {
            const trimmed = reply.replace(/[\s"'«»()\[\]*_~`.]+$/u, '');
            this.continueConversation = /[?？]$/.test(trimmed);
        }
        return { reply };
    }

    /**
     * The user's final transcript arrived. A real utterance proceeds (and
     * restores the spurious-retry budget). A blank/hallucinated one either
     * retries the mic (echo tripped VAD right after a follow-up mic-open,
     * bounded by MAX_EMPTY_TURN_RETRIES) or ends the session.
     */
    transcriptDone(transcript: string): TranscriptDecision {
        if (!isBlankOrHallucinatedTranscript(transcript)) {
            this.emptyTurnRetries = 0;
            return { kind: 'proceed' };
        }

        const now = this.now();
        const turnMs = now - this.turnStartedAt;
        if (this.peConversationActive && turnMs < this.SPURIOUS_TURN_MS && this.emptyTurnRetries < this.MAX_EMPTY_TURN_RETRIES) {
            this.emptyTurnRetries++;
            this.state_ = 'idle';
            this.lastTurnEndedAt = now;
            return { kind: 'spurious_retry', turnMs, retry: this.emptyTurnRetries, maxRetries: this.MAX_EMPTY_TURN_RETRIES };
        }

        // No answer => the user has left the conversation: end the PE session so
        // it stops auto-reopening and the next turn starts fresh.
        this.peConversationActive = false;
        this.state_ = 'idle';
        this.lastTurnEndedAt = now;
        return { kind: 'end_session' };
    }

    /** Reply playback started (first announce play or in-band delivery). */
    speakingStarted(): void {
        this.state_ = 'speaking';
    }

    /**
     * The announce queue drained (end of an announce-path turn). Consumes the
     * question decision: reopening puts the PE into its start_conversation
     * session, so subsequent turns reply in-band.
     */
    finishAnnouncePlayback(): { reopenMic: boolean } {
        this.state_ = 'idle';
        this.lastTurnEndedAt = this.now();
        if (this.continueConversation) {
            this.continueConversation = false;
            this.peConversationActive = true;
            return { reopenMic: true };
        }
        return { reopenMic: false };
    }

    /**
     * Start delivering an in-band reply: consumes the question decision (the
     * PE is told explicitly whether to reopen via INTENT_END, since its own
     * flag is sticky) and the pending intent, and hands over the reply text
     * the TTS_START must carry.
     */
    beginInbandDelivery(): { keepOpen: boolean; replyText: string } {
        const keepOpen = this.continueConversation;
        this.continueConversation = false;
        this.hasIntent = false;
        this.state_ = 'speaking';
        return { keepOpen, replyText: this.lastReplyText };
    }

    /**
     * In-band delivery sent. Session tracking mirrors what the PE was told:
     * keepOpen => it reopens after playback, else it goes idle. The turn ends at
     * END OF PLAYBACK, not send time — stamping at send time made a long reply
     * eat the whole context TTL and wiped the context mid-conversation.
     */
    finishInbandDelivery(keepOpen: boolean, playbackMs: number): void {
        this.peConversationActive = keepOpen;
        this.state_ = 'idle';
        this.lastTurnEndedAt = this.now() + playbackMs;
    }

    /** A say/ask flow starts a fresh turn on the announce path: end any PE session. */
    resetSession(): void {
        this.peConversationActive = false;
    }

    /**
     * THE single reset for a mid-turn failure or transport drop (C1). Idempotent
     * and safe to call when idle. Reports whether a turn was actually in flight
     * so the caller can notify the device/user only when something was cut off.
     */
    abort(): { wasActive: boolean } {
        const wasActive = this.state_ !== 'idle' || this.hasIntent;
        this.state_ = 'idle';
        this.hasIntent = false;
        this.continueConversation = false;
        this.peConversationActive = false;
        this.emptyTurnRetries = 0;
        this.replyText = '';
        return { wasActive };
    }
}
