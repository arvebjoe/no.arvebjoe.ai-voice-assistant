// Fake IVoiceProvider for device unit tests. An EventEmitter with no-op transport
// methods (recorded) so the device can wire handlers and drive provider events
// (silence, transcript.done, audio.delta, response.done, error, close, Unhealthy)
// without any websocket. A module-level registry records every instance the factory
// builds so tests can assert a runtime provider rebuild happened.
import { EventEmitter } from 'node:events';

export const createdProviders: FakeVoiceProvider[] = [];

export class FakeVoiceProvider extends EventEmitter {
    public calls: string[] = [];
    public started = false;
    public destroyed = false;
    public inputSampleRate = 24000; // OpenAI-like by default; override per test
    public apiKeySettingKey = 'openai_api_key';

    constructor(public providerId: string = 'openai-realtime') {
        super();
    }

    private rec(m: string) { this.calls.push(m); }

    async start(): Promise<void> { this.started = true; this.rec('start'); }
    close(): void { this.started = false; this.rec('close'); }
    destroy(): void { this.destroyed = true; this.rec('destroy'); this.removeAllListeners(); }
    async restart(): Promise<void> { this.rec('restart'); }
    isConnected(): boolean { return this.started; }
    hasApiKey(): boolean { return true; }

    sendAudioChunk(_chunk: Buffer): void { this.rec('sendAudioChunk'); }
    async sendTextForAudioResponse(_t: string): Promise<void> { this.rec('sendTextForAudioResponse'); }
    async sendTextForTextResponse(_t: string): Promise<void> { this.rec('sendTextForTextResponse'); }
    async textToSpeech(_t: string): Promise<Buffer> { this.rec('textToSpeech'); return Buffer.alloc(0); }
    resetConversation(): void { this.rec('resetConversation'); }

    async updateApiKey(_k: string): Promise<void> { this.rec('updateApiKey'); }
    async updateVoice(_v: string): Promise<void> { this.rec('updateVoice'); }
    async updateLanguage(_c: string, _n: string): Promise<void> { this.rec('updateLanguage'); }
    async updateAdditionalInstructions(_s: string): Promise<void> { this.rec('updateAdditionalInstructions'); }
    async updateZone(_z: string): Promise<void> { this.rec('updateZone'); }
    async updateTimerSupport(_b: boolean): Promise<void> { this.rec('updateTimerSupport'); }
    async updateShoppingListSupport(_b: boolean): Promise<void> { this.rec('updateShoppingListSupport'); }
    async updateMusicSupport(_b: boolean): Promise<void> { this.rec('updateMusicSupport'); }
}

/** Drop-in for createVoiceProvider — records instances, returns a fresh fake. */
export function createVoiceProvider(_homey: any, _tm: any, _opts: any, providerId?: string): FakeVoiceProvider {
    const p = new FakeVoiceProvider(providerId ?? 'openai-realtime');
    createdProviders.push(p);
    return p;
}

export const DEFAULT_VOICE_PROVIDER = 'openai-realtime';

/** Test helper to clear the registry between tests. */
export function __resetProviderRegistry(): void { createdProviders.length = 0; }
