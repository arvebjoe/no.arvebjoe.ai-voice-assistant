// Fake EspVoiceAssistantClient for device unit tests. An EventEmitter that records
// every protocol call the device makes and lets a test drive device-facing events
// (starting, chunk, silence, Unhealthy, announce_finished, …) without any TCP.
import { EventEmitter } from 'node:events';

export class EspVoiceAssistantClient extends EventEmitter {
    // Ordered log of protocol calls: [method, ...args]. Tests assert against this.
    public calls: Array<{ method: string; args: any[] }> = [];
    public supportsTimers = true;
    public started = false;

    constructor(public homey: any, public opts: any) {
        super();
    }

    private record(method: string, ...args: any[]) {
        this.calls.push({ method, args });
    }
    /** Convenience: names of calls in order (e.g. ['run_start','stt_start']). */
    callNames(): string[] { return this.calls.map(c => c.method); }
    countOf(method: string): number { return this.calls.filter(c => c.method === method).length; }

    async start(): Promise<void> { this.started = true; this.record('start'); }
    async disconnect(): Promise<boolean> { this.record('disconnect'); return true; }
    setHost(host: string, port?: number) { this.record('setHost', host, port); }

    isConnected(): boolean { return this.started; }

    run_start() { this.record('run_start'); }
    run_end() { this.record('run_end'); }
    wake_word_end() { this.record('wake_word_end'); }
    begin_mic_capture() { this.record('begin_mic_capture'); }
    closeMic() { this.record('closeMic'); }
    stt_start() { this.record('stt_start'); }
    stt_end(text?: string) { this.record('stt_end', text); }
    stt_vad_start() { this.record('stt_vad_start'); }
    stt_vad_end(text?: string) { this.record('stt_vad_end', text); }
    intent_start() { this.record('intent_start'); }
    intent_progress(text?: string) { this.record('intent_progress', text); }
    intent_end(text?: string, cont?: boolean) { this.record('intent_end', text, cont); }
    tts_start(text?: string) { this.record('tts_start', text); }
    tts_end(url?: string) { this.record('tts_end', url); }
    pipeline_error(code: string, message: string) { this.record('pipeline_error', code, message); }
    send_voice_assistant_request(...a: any[]) { this.record('send_voice_assistant_request', ...a); }
    playAudioFromUrl(url: string, startConversation: boolean) { this.record('playAudioFromUrl', url, startConversation); }
    setVolume(v: number) { this.record('setVolume', v); }
    setMute(v: boolean) { this.record('setMute', v); }
}
