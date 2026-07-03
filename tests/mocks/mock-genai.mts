// Fake `@google/genai` for GeminiLiveProvider unit tests. Mirrors the surface the
// provider uses: new GoogleGenAI({apiKey}) -> ai.live.connect({callbacks, config})
// returning a session, plus ai.models.generateContent for text-mode. Every live
// session is recorded so a test can grab it and drive its callbacks / assert sends.

export const geminiSessions: FakeLiveSession[] = [];

export function __resetGenai(): void {
    geminiSessions.length = 0;
    FakeLiveSession.failNextConnect = false;
}

// The provider imports Modality as a value (Modality.AUDIO), so it must exist.
export const Modality = { AUDIO: 'AUDIO', TEXT: 'TEXT', IMAGE: 'IMAGE' } as const;

interface LiveCallbacks {
    onopen?: () => void;
    onmessage?: (m: any) => void;
    onerror?: (e: any) => void;
    onclose?: (e: any) => void;
}

export class FakeLiveSession {
    /** Set true to make the NEXT live.connect() reject (simulate a failed connect). */
    static failNextConnect = false;

    public sent: Array<{ method: string; arg: any }> = [];
    public closed = false;
    constructor(public callbacks: LiveCallbacks, public config: any) { }

    sendRealtimeInput(arg: any) { this.sent.push({ method: 'sendRealtimeInput', arg }); }
    sendClientContent(arg: any) { this.sent.push({ method: 'sendClientContent', arg }); }
    sendToolResponse(arg: any) { this.sent.push({ method: 'sendToolResponse', arg }); }
    close() { this.closed = true; }

    // ---- Test drivers (invoke the SDK callbacks) ----
    __open() { this.callbacks.onopen?.(); }
    __message(m: any) { this.callbacks.onmessage?.(m); }
    __error(e: any) { this.callbacks.onerror?.(e); }
    __close(e: any = {}) { this.callbacks.onclose?.(e); }

    sentOf(method: string) { return this.sent.filter(s => s.method === method); }
}

export class GoogleGenAI {
    public apiKey: string;
    constructor(cfg: { apiKey?: string }) { this.apiKey = cfg?.apiKey ?? ''; }

    live = {
        connect: async (opts: { callbacks: LiveCallbacks; config: any }) => {
            if (FakeLiveSession.failNextConnect) {
                FakeLiveSession.failNextConnect = false;
                throw new Error('connect failed');
            }
            const session = new FakeLiveSession(opts.callbacks, opts.config);
            geminiSessions.push(session);
            return session;
        },
    };

    models = {
        generateContent: async (_req: any) => ({ text: 'stub response' }),
    };
}

export default { GoogleGenAI, Modality };
