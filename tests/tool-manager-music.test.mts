import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';
import { MockWeatherHelper } from './mocks/mock-weather-helper.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';
import type { MaPlayer, MaSearchResults, MaQueueState } from '../src/helpers/music-assistant-client.mjs';

const MUSIC_TOOLS = ['search_music', 'play_music', 'music_control', 'get_music_state'];

async function makeManager(homey: MockHomey): Promise<ToolManager> {
    const deviceManager = new MockDeviceManager();
    const geoHelper = new MockGeoHelper();
    const weatherHelper = new MockWeatherHelper();
    await deviceManager.init();
    await deviceManager.fetchData();
    await geoHelper.init();
    await weatherHelper.init();
    settingsManager.init(homey);
    return new ToolManager(homey, 'Office', deviceManager as any, geoHelper as any, weatherHelper as any);
}

/** In-memory stand-in for MusicAssistantClient, recording what was called. */
class FakeMusicClient {
    players: MaPlayer[] = [];
    searchResults: MaSearchResults = { artists: [], albums: [], tracks: [], playlists: [], radio: [] };
    queue: MaQueueState = { queueId: 'q1', active: true, state: 'playing', shuffleEnabled: false, repeatMode: 'off', nowPlaying: 'Song — Artist', itemsInQueue: 3 };
    calls: Array<{ method: string; args: any[] }> = [];

    /** When set, playMedia resolves only after this many ms (real/fake timers). */
    playMediaDelayMs = 0;
    /** When set, playMedia rejects with this error (after any delay). */
    playMediaError: Error | null = null;

    private rec(method: string, ...args: any[]) { this.calls.push({ method, args }); }
    async getPlayers() { this.rec('getPlayers'); return this.players; }
    async search(q: string, types?: string[], limit?: number) { this.rec('search', q, types, limit); return this.searchResults; }
    async getActiveQueue(playerId: string) { this.rec('getActiveQueue', playerId); return { ...this.queue }; }
    async playMedia(queueId: string, media: any, option?: string, radioMode?: boolean) {
        this.rec('playMedia', queueId, media, option, radioMode);
        if (this.playMediaDelayMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, this.playMediaDelayMs));
        }
        if (this.playMediaError) throw this.playMediaError;
    }
    async queueCommand(queueId: string, command: string) { this.rec('queueCommand', queueId, command); }
    async setShuffle(queueId: string, enabled: boolean) { this.rec('setShuffle', queueId, enabled); }
}

function player(overrides: Partial<MaPlayer>): MaPlayer {
    return {
        playerId: 'p1', name: 'Player', provider: 'sendspin', available: true,
        state: 'idle', ipAddress: '', macAddress: '', ...overrides,
    };
}

function item(name: string, mediaType: string, uri: string, artists = '') {
    return { uri, name, mediaType, artists, album: '' };
}

describe('ToolManager Music Assistant gating', () => {
    beforeEach(() => {
        settingsManager.reset();
    });

    it('does not register the music tools when the feature is disabled', async () => {
        const homey = new MockHomey();
        const tm = await makeManager(homey);
        expect(tm.isMusicActive()).toBe(false);
        for (const name of MUSIC_TOOLS) expect(tm.hasTool(name)).toBe(false);
    });

    it('does not register the tools when enabled but the host is missing', async () => {
        const homey = new MockHomey();
        homey.setMockSetting('music_assistant_enabled', true);
        const tm = await makeManager(homey);
        expect(tm.isMusicActive()).toBe(false);
        for (const name of MUSIC_TOOLS) expect(tm.hasTool(name)).toBe(false);
    });

    it('registers the tools when enabled with a host present', async () => {
        const homey = new MockHomey();
        homey.setMockSetting('music_assistant_enabled', true);
        homey.setMockSetting('music_assistant_host', '192.168.1.50');
        const tm = await makeManager(homey);
        expect(tm.isMusicActive()).toBe(true);
        for (const name of MUSIC_TOOLS) expect(tm.hasTool(name)).toBe(true);
    });

    it('adds and removes the tools as the setting flips at runtime', async () => {
        const homey = new MockHomey();
        homey.setMockSetting('music_assistant_host', '192.168.1.50');
        const tm = await makeManager(homey);
        expect(tm.isMusicActive()).toBe(false);

        homey.setMockSetting('music_assistant_enabled', true);
        expect(tm.refreshMusicTools()).toBe(true);
        expect(tm.hasTool('play_music')).toBe(true);

        homey.setMockSetting('music_assistant_enabled', false);
        expect(tm.refreshMusicTools()).toBe(false);
        expect(tm.hasTool('play_music')).toBe(false);
    });

    it('accepts the string "true" from the settings store', async () => {
        const homey = new MockHomey();
        homey.setMockSetting('music_assistant_enabled', 'true');
        homey.setMockSetting('music_assistant_host', '192.168.1.50');
        const tm = await makeManager(homey);
        expect(tm.isMusicActive()).toBe(true);
    });
});

describe('ToolManager music tool handlers', () => {
    let tm: ToolManager;
    let fake: FakeMusicClient;

    beforeEach(async () => {
        settingsManager.reset();
        const homey = new MockHomey();
        homey.setMockSetting('music_assistant_enabled', true);
        homey.setMockSetting('music_assistant_host', '192.168.1.50');
        tm = await makeManager(homey);
        fake = new FakeMusicClient();
        (tm as any).musicClient = fake;
        (tm as any).musicPlayersCache = null;
    });

    it('targets the satellite the user is talking to via the IP hint', async () => {
        fake.players = [
            player({ playerId: 'other', name: 'Bedroom', ipAddress: '10.0.0.9' }),
            player({ playerId: 'mine', name: 'Office speaker', ipAddress: '10.0.0.7' }),
        ];
        fake.searchResults.artists = [item('Queen', 'artist', 'library://artist/1')];
        tm.setMusicPlayerHint(() => ({ address: '10.0.0.7', deviceName: 'Voice PE', zone: 'Office' }));

        const { output } = await tm.execute('play_music', { query: 'Queen', media_type: 'artist' });
        expect(output.ok).toBe(true);
        expect(output.data.player).toBe('Office speaker');
        const play = fake.calls.find(c => c.method === 'playMedia')!;
        expect(play.args).toEqual(['q1', 'library://artist/1', 'replace', false]);
    });

    // MA 2.9 shapes observed live 2026-07-20: device_info.ip_address is null
    // for the satellites; the PE carries its MAC in device_info.mac_address,
    // the TR only embeds it in the player_id/name.
    it('targets the PE by MAC hint when MA reports no IP (mac_address field)', async () => {
        fake.players = [
            player({ playerId: 'other', name: 'Bedroom', macAddress: 'AA:AA:AA:AA:AA:AA' }),
            player({ playerId: 'up20f83b0908d1', name: 'Home Assistant Voice 0908d1', macAddress: '20:F8:3B:09:08:D1' }),
        ];
        tm.setMusicPlayerHint(() => ({ mac: '20f83b0908d1', address: '10.0.0.7', deviceName: 'Stua PE', zone: 'Stua' }));

        const { output } = await tm.execute('music_control', { action: 'next' });
        expect(output.ok).toBe(true);
        expect(output.data.player).toBe('Home Assistant Voice 0908d1');
    });

    it('targets the TR by MAC embedded in the player id/name (no mac_address in MA)', async () => {
        fake.players = [
            player({ playerId: 'other', name: 'Bedroom' }),
            player({ playerId: 'up3rspka8e29151dbad', name: '3RSPK-A8E29151DBAD' }),
        ];
        tm.setMusicPlayerHint(() => ({ mac: 'A8:E2:91:51:DB:AD', deviceName: 'TR speaker', zone: 'Kontor' }));

        const { output } = await tm.execute('music_control', { action: 'next' });
        expect(output.ok).toBe(true);
        expect(output.data.player).toBe('3RSPK-A8E29151DBAD');
    });

    it('ignores a malformed MAC hint and falls through to the other hints', async () => {
        fake.players = [
            player({ playerId: 'a', name: 'Kitchen' }),
            player({ playerId: 'b', name: 'Office speaker' }),
        ];
        tm.setMusicPlayerHint(() => ({ mac: 'not-a-mac', zone: 'Office' }));

        const { output } = await tm.execute('music_control', { action: 'next' });
        expect(output.ok).toBe(true);
        expect(output.data.player).toBe('Office speaker');
    });

    it('falls back to zone-name matching when the IP does not match', async () => {
        fake.players = [
            player({ playerId: 'a', name: 'Kitchen' }),
            player({ playerId: 'b', name: 'Office speaker' }),
        ];
        tm.setMusicPlayerHint(() => ({ address: '10.9.9.9', deviceName: 'Voice PE', zone: 'Office' }));

        const { output } = await tm.execute('music_control', { action: 'next' });
        expect(output.ok).toBe(true);
        expect(output.data.player).toBe('Office speaker');
        expect(fake.calls.find(c => c.method === 'queueCommand')!.args).toEqual(['q1', 'next']);
    });

    describe('slow-play acknowledgement', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('speaks "putting on X" when play_media is still pending after the delay', async () => {
            vi.useFakeTimers();
            fake.players = [player({ playerId: 'mine', name: 'Office speaker' })];
            fake.searchResults.artists = [item('Metallica', 'artist', 'library://artist/2')];
            fake.playMediaDelayMs = 30_000; // a first-played artist on MA 2.9
            const spoken: string[] = [];
            tm.setMusicPlayerHint(() => ({ zone: 'Office' }));
            tm.setInterimSpeak((text) => spoken.push(text));

            const pending = tm.execute('play_music', { query: 'Metallica', media_type: 'artist' });
            await vi.advanceTimersByTimeAsync(5_000); // past the 4s ack delay
            expect(spoken).toEqual(['Putting on Metallica, one moment.']);

            await vi.advanceTimersByTimeAsync(30_000);
            const { output } = await pending;
            expect(output.ok).toBe(true);
            expect(spoken).toHaveLength(1); // spoken once, not repeated
        });

        it('stays silent when play_media answers quickly', async () => {
            vi.useFakeTimers();
            fake.players = [player({ playerId: 'mine', name: 'Office speaker' })];
            fake.searchResults.artists = [item('Queen', 'artist', 'library://artist/1')];
            const spoken: string[] = [];
            tm.setMusicPlayerHint(() => ({ zone: 'Office' }));
            tm.setInterimSpeak((text) => spoken.push(text));

            const { output } = await tm.execute('play_music', { query: 'Queen', media_type: 'artist' });
            expect(output.ok).toBe(true);
            await vi.advanceTimersByTimeAsync(10_000); // ack timer must have been cancelled
            expect(spoken).toEqual([]);
        });

        it('reports "preparing" (not failure) when play_media times out — MA finishes late', async () => {
            fake.players = [player({ playerId: 'mine', name: 'Office speaker' })];
            fake.searchResults.artists = [item('Rammstein', 'artist', 'library://artist/4')];
            const timeout = new Error("Music Assistant did not answer 'player_queues/play_media' within 45s.");
            (timeout as any).code = 'MA_TIMEOUT';
            fake.playMediaError = timeout;
            tm.setMusicPlayerHint(() => ({ zone: 'Office' }));

            const { output } = await tm.execute('play_music', { query: 'Rammstein', media_type: 'artist' });
            expect(output.ok).toBe(true);
            expect(output.data.status).toBe('preparing');
            expect(output.data.playing.name).toBe('Rammstein');
            expect(output.data.note).toMatch(/start within a minute/i);
        });

        it('still fails on a real (non-timeout) play_media error', async () => {
            fake.players = [player({ playerId: 'mine', name: 'Office speaker' })];
            fake.searchResults.artists = [item('Queen', 'artist', 'library://artist/1')];
            fake.playMediaError = new Error('Invalid media uri');
            tm.setMusicPlayerHint(() => ({ zone: 'Office' }));

            const { output } = await tm.execute('play_music', { query: 'Queen', media_type: 'artist' });
            expect(output.ok).toBe(false);
            expect(output.error.code).toBe('MUSIC_UNAVAILABLE');
        });

        it('speaks in the selected language', async () => {
            vi.useFakeTimers();
            const homey = new MockHomey();
            homey.setMockSetting('music_assistant_enabled', true);
            homey.setMockSetting('music_assistant_host', '192.168.1.50');
            homey.setMockSetting('selected_language_code', 'no');
            settingsManager.reset(); // re-prime from THIS homey (incl. the language)
            const tmNo = await makeManager(homey);
            const fakeNo = new FakeMusicClient();
            (tmNo as any).musicClient = fakeNo;
            (tmNo as any).musicPlayersCache = null;
            fakeNo.players = [player({ playerId: 'mine', name: 'Office speaker' })];
            fakeNo.searchResults.artists = [item('Heilung', 'artist', 'library://artist/3')];
            fakeNo.playMediaDelayMs = 30_000;
            const spoken: string[] = [];
            tmNo.setMusicPlayerHint(() => ({ zone: 'Office' }));
            tmNo.setInterimSpeak((text) => spoken.push(text));

            const pending = tmNo.execute('play_music', { query: 'Heilung', media_type: 'artist' });
            await vi.advanceTimersByTimeAsync(5_000);
            expect(spoken).toEqual(['Setter på Heilung, et øyeblikk.']);
            await vi.advanceTimersByTimeAsync(30_000);
            await pending;
        });
    });

    it('uses an explicitly named player over the hint', async () => {
        fake.players = [
            player({ playerId: 'a', name: 'Kitchen', ipAddress: '10.0.0.7' }),
            player({ playerId: 'b', name: 'Bedroom' }),
        ];
        tm.setMusicPlayerHint(() => ({ address: '10.0.0.7' }));

        const { output } = await tm.execute('music_control', { action: 'pause', player: 'bedroom' });
        expect(output.ok).toBe(true);
        expect(output.data.player).toBe('Bedroom');
    });

    it('asks which player to use when nothing matches and several exist', async () => {
        fake.players = [
            player({ playerId: 'a', name: 'Kitchen' }),
            player({ playerId: 'b', name: 'Bedroom' }),
        ];
        tm.setMusicPlayerHint(() => ({ address: '10.0.0.7', deviceName: 'Voice PE', zone: 'Office' }));

        const { output } = await tm.execute('play_music', { query: 'Queen' });
        expect(output.ok).toBe(false);
        expect(output.error.code).toBe('PLAYER_AMBIGUOUS');
        expect(output.error.message).toContain('Kitchen');
        expect(output.error.message).toContain('Bedroom');
    });

    it('prefers an exact match in a lower-priority list over a partial in a higher one', async () => {
        fake.players = [player({ playerId: 'p', name: 'Office speaker' })];
        tm.setMusicPlayerHint(() => ({ zone: 'Office' }));
        fake.searchResults = {
            artists: [item('Hotel California Tribute Band', 'artist', 'library://artist/9')],
            albums: [],
            tracks: [item('Hotel California', 'track', 'library://track/3', 'Eagles')],
            playlists: [],
            radio: [],
        };

        const { output } = await tm.execute('play_music', { query: 'Hotel California' });
        expect(output.ok).toBe(true);
        expect(output.data.playing.name).toBe('Hotel California');
        expect(output.data.playing.media_type).toBe('track');
    });

    it('reports NO_MATCH when the search comes back empty', async () => {
        fake.players = [player({ playerId: 'p', name: 'Office speaker' })];
        tm.setMusicPlayerHint(() => ({ zone: 'Office' }));

        const { output } = await tm.execute('play_music', { query: 'Nonexistent Band', media_type: 'artist' });
        expect(output.ok).toBe(false);
        expect(output.error.code).toBe('NO_MATCH');
    });

    it('plays a uri directly without searching', async () => {
        fake.players = [player({ playerId: 'p', name: 'Office speaker' })];
        tm.setMusicPlayerHint(() => ({ zone: 'Office' }));

        const { output } = await tm.execute('play_music', { uri: 'library://album/7', mode: 'add' });
        expect(output.ok).toBe(true);
        expect(fake.calls.some(c => c.method === 'search')).toBe(false);
        expect(fake.calls.find(c => c.method === 'playMedia')!.args).toEqual(['q1', 'library://album/7', 'add', false]);
    });

    it('maps resume to play when the queue is paused', async () => {
        fake.players = [player({ playerId: 'p', name: 'Office speaker' })];
        fake.queue.state = 'paused';
        tm.setMusicPlayerHint(() => ({ zone: 'Office' }));

        const { output } = await tm.execute('music_control', { action: 'resume' });
        expect(output.ok).toBe(true);
        expect(fake.calls.find(c => c.method === 'queueCommand')!.args).toEqual(['q1', 'play']);
    });

    it('toggles shuffle through the shuffle command', async () => {
        fake.players = [player({ playerId: 'p', name: 'Office speaker' })];
        tm.setMusicPlayerHint(() => ({ zone: 'Office' }));

        const { output } = await tm.execute('music_control', { action: 'shuffle_on' });
        expect(output.ok).toBe(true);
        expect(fake.calls.find(c => c.method === 'setShuffle')!.args).toEqual(['q1', true]);
    });

    it('returns the now-playing state', async () => {
        fake.players = [player({ playerId: 'p', name: 'Office speaker' })];
        tm.setMusicPlayerHint(() => ({ zone: 'Office' }));

        const { output } = await tm.execute('get_music_state', {});
        expect(output.ok).toBe(true);
        expect(output.data.now_playing).toBe('Song — Artist');
        expect(output.data.state).toBe('playing');
        expect(output.data.items_in_queue).toBe(3);
    });

    it('search_music returns compact per-type lists with uris', async () => {
        fake.searchResults = {
            artists: [item('Queen', 'artist', 'library://artist/1')],
            albums: [item('A Night at the Opera', 'album', 'library://album/2', 'Queen')],
            tracks: [], playlists: [], radio: [],
        };
        const { output } = await tm.execute('search_music', { query: 'queen' });
        expect(output.ok).toBe(true);
        expect(output.data.artists[0]).toEqual({ name: 'Queen', uri: 'library://artist/1' });
        expect(output.data.albums[0]).toEqual({ name: 'A Night at the Opera', artists: 'Queen', uri: 'library://album/2' });
    });

    it('surfaces client failures as MUSIC_UNAVAILABLE', async () => {
        fake.getPlayers = async () => { throw new Error('server unreachable'); };
        const { output } = await tm.execute('play_music', { query: 'Queen' });
        expect(output.ok).toBe(false);
        expect(output.error.code).toBe('MUSIC_UNAVAILABLE');
        expect(output.error.message).toContain('server unreachable');
    });
});
