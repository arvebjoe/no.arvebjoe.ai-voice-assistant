import { describe, it, expect, beforeEach } from 'vitest';
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

    private rec(method: string, ...args: any[]) { this.calls.push({ method, args }); }
    async getPlayers() { this.rec('getPlayers'); return this.players; }
    async search(q: string, types?: string[], limit?: number) { this.rec('search', q, types, limit); return this.searchResults; }
    async getActiveQueue(playerId: string) { this.rec('getActiveQueue', playerId); return { ...this.queue }; }
    async playMedia(queueId: string, media: any, option?: string, radioMode?: boolean) { this.rec('playMedia', queueId, media, option, radioMode); }
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
