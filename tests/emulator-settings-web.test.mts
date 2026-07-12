import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The emulator's config module reads HE_SETTINGS at import time (and exits the
// process when the file is missing), so the settings file and env var must
// exist BEFORE settings-web/settings-store are imported — hence the dynamic
// imports in beforeAll.
const tmp = mkdtempSync(join(tmpdir(), 'he-settings-web-'));
const settingsFile = join(tmp, 'settings.json');
writeFileSync(settingsFile, `${JSON.stringify({
  global: { openai_api_key: 'sk-test', selected_voice: 'alloy' },
  zones: [],
  devices: [],
}, null, 2)}\n`, 'utf8');
process.env.HE_SETTINGS = settingsFile;

/** Fake homey context: just the settings store the handler talks to. */
function makeFakeHomey() {
  const store = new Map<string, any>([['openai_api_key', 'sk-test'], ['selected_voice', 'alloy']]);
  const emitter = new EventEmitter();
  return {
    emitter,
    settings: {
      get: (k: string) => (store.has(k) ? store.get(k) : null),
      set: async (k: string, v: any) => { store.set(k, v); emitter.emit('set', k); },
      unset: async (k: string) => { store.delete(k); emitter.emit('set', k); },
    },
  };
}

const apiRoutes = {
  getVoices: { method: 'GET', path: '/voices' },
  testLocalStage: { method: 'POST', path: '/test-local-stage' },
};

let server: http.Server;
let base: string;
let homey: ReturnType<typeof makeFakeHomey>;
let apiCalls: any[];

beforeAll(async () => {
  const { createRequestHandler } = await import('../emulator/runtime/settings-web.mjs');
  const { saveGlobalSetting } = await import('../emulator/runtime/settings-store.mjs');

  homey = makeFakeHomey();
  apiCalls = [];
  const handler = createRequestHandler({
    homey,
    apiRoutes,
    apiHandlers: {
      getVoices: async (args: any) => { apiCalls.push(args); return [{ value: 'alloy', name: 'Alloy' }]; },
      testLocalStage: async (args: any) => { apiCalls.push(args); return { ok: true, message: 'pong' }; },
    },
    persist: saveGlobalSetting,
  });

  server = http.createServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as any;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(tmp, { recursive: true, force: true });
});

describe('settings web UI', () => {
  it('serves the real settings page at /', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('src="/homey.js"');
  });

  it('serves the homey.js shim with the API surface the page uses', async () => {
    const res = await fetch(`${base}/homey.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    const js = await res.text();
    for (const fn of ['ready', 'get', 'set', 'api', 'alert']) {
      expect(js).toContain(`${fn}:`);
    }
  });

  it('the shim bootstraps the page by calling onHomeyReady on DOM ready', async () => {
    const js = await (await fetch(`${base}/homey.js`)).text();
    // Without this call the page never attaches its event listeners.
    expect(js).toContain('window.onHomeyReady(window.Homey)');
    expect(js).toContain('DOMContentLoaded');
  });

  it('Homey.get reads from the fake settings store', async () => {
    const res = await fetch(`${base}/he/settings/openai_api_key`);
    expect(await res.json()).toEqual({ value: 'sk-test' });
  });

  it('Homey.get of a missing key returns null (matches homey.settings)', async () => {
    const res = await fetch(`${base}/he/settings/nope`);
    expect(await res.json()).toEqual({ value: null });
  });

  it('Homey.set updates the store, fires the set event, and persists to settings.json', async () => {
    const events: string[] = [];
    homey.emitter.on('set', (k: string) => events.push(k));

    const res = await fetch(`${base}/he/settings/selected_voice`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'nova' }),
    });
    expect(res.status).toBe(200);
    expect(homey.settings.get('selected_voice')).toBe('nova');
    expect(events).toContain('selected_voice');

    const onDisk = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(onDisk.global.selected_voice).toBe('nova');
    // Unrelated fields survive the write untouched.
    expect(onDisk.global.openai_api_key).toBe('sk-test');
    expect(onDisk.zones).toEqual([]);
  });

  it('persists non-string values as real JSON types', async () => {
    await fetch(`${base}/he/settings/weather_enabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: false }),
    });
    await fetch(`${base}/he/settings/music_assistant_port`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 8095 }),
    });
    const onDisk = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(onDisk.global.weather_enabled).toBe(false);
    expect(onDisk.global.music_assistant_port).toBe(8095);
  });

  it('setting null unsets the key in the store and removes it from settings.json', async () => {
    await fetch(`${base}/he/settings/weather_enabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: null }),
    });
    expect(homey.settings.get('weather_enabled')).toBe(null);
    const onDisk = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect('weather_enabled' in onDisk.global).toBe(false);
  });

  it('Homey.api GET dispatches with query params', async () => {
    const res = await fetch(`${base}/he/api/voices?provider=local&tts=piper`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ value: 'alloy', name: 'Alloy' }]);
    const call = apiCalls.at(-1);
    expect(call.query).toEqual({ provider: 'local', tts: 'piper' });
    expect(call.homey).toBe(homey);
  });

  it('Homey.api POST dispatches with a JSON body', async () => {
    const res = await fetch(`${base}/he/api/test-local-stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'llm', backend: 'ollama' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'pong' });
    expect(apiCalls.at(-1).body).toEqual({ stage: 'llm', backend: 'ollama' });
  });

  it('unknown API routes return 404 with an error payload', async () => {
    const res = await fetch(`${base}/he/api/does-not-exist`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toContain('does-not-exist');
  });

  it('a throwing handler returns 500 with the error message', async () => {
    const { createRequestHandler } = await import('../emulator/runtime/settings-web.mjs');
    const handler = createRequestHandler({
      homey,
      apiRoutes: { boom: { method: 'GET', path: '/boom' } },
      apiHandlers: { boom: async () => { throw new Error('kaput'); } },
    });
    const s = http.createServer(handler);
    await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
    const { port } = s.address() as any;
    const res = await fetch(`http://127.0.0.1:${port}/he/api/boom`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error).toBe('kaput');
    await new Promise<void>((done) => s.close(() => done()));
  });

  it('unknown paths return 404', async () => {
    const res = await fetch(`${base}/whatever`);
    expect(res.status).toBe(404);
  });
});
