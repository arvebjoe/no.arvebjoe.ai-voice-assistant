// Hosts the app's REAL settings page (settings/index.html) in a browser,
// without a Homey. The page is served unmodified; its single external
// dependency — the `/homey.js` webview bridge Homey normally injects — is
// replaced by a small shim that maps the same API onto HTTP endpoints:
//
//   Homey.get(key)        -> GET  /he/settings/<key>     (fake homey.settings)
//   Homey.set(key, value) -> PUT  /he/settings/<key>     (fires the normal
//                            'set' event so SettingsManager rebuilds the agent
//                            live, AND persists to settings.json -> global)
//   Homey.api(m, path)    -> <m>  /he/api<path>          (dispatched to the
//                            app's real api.mts handlers via the route table
//                            in .homeycompose/app.json)
//
// So edits made in the browser behave exactly like a save on a real Homey and
// survive an emulator restart.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createLogger } from '../../src/helpers/logger.mjs';
import { saveGlobalSetting } from './settings-store.mjs';

const log = createLogger('EMU-Settings', false);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_HTML_PATH = resolve(__dirname, '../../settings/index.html');

export const DEFAULT_SETTINGS_WEB_PORT = 8060;

/**
 * Browser-side replacement for Homey's `/homey.js` webview bridge. Implements
 * the subset the settings page uses (get/set/api/alert/ready) plus the
 * near-relatives (unset/confirm/__) so future page changes don't silently
 * break. Callback conventions match homey.js: cb(err) / cb(err, result).
 */
const HOMEY_JS_SHIM = `(function () {
  'use strict';

  function jsonOrNull(res) { return res.json().catch(function () { return null; }); }

  function fail(cb, res, data) {
    cb(new Error(data && data.error ? data.error : res.status + ' ' + res.statusText));
  }

  window.Homey = {
    ready: function () {},
    __: function (key) { return key; },

    get: function (key, cb) {
      fetch('/he/settings/' + encodeURIComponent(key))
        .then(function (res) {
          return jsonOrNull(res).then(function (data) {
            if (!res.ok) return fail(cb, res, data);
            cb(null, data && data.value !== undefined ? data.value : null);
          });
        })
        .catch(function (e) { cb(e); });
    },

    set: function (key, value, cb) {
      cb = cb || function () {};
      fetch('/he/settings/' + encodeURIComponent(key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: value === undefined ? null : value })
      })
        .then(function (res) {
          return jsonOrNull(res).then(function (data) {
            if (!res.ok) return fail(cb, res, data);
            cb(null);
          });
        })
        .catch(function (e) { cb(e); });
    },

    unset: function (key, cb) { this.set(key, null, cb); },

    api: function (method, path, body, cb) {
      if (typeof body === 'function') { cb = body; body = null; }
      cb = cb || function () {};
      var opts = { method: method };
      if (body != null) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
      }
      fetch('/he/api' + path, opts)
        .then(function (res) {
          return jsonOrNull(res).then(function (data) {
            if (!res.ok) return fail(cb, res, data);
            cb(null, data);
          });
        })
        .catch(function (e) { cb(e); });
    },

    alert: function (message, cb) {
      window.alert(message && message.message ? message.message : message);
      if (cb) cb();
    },

    confirm: function (message, icon, cb) {
      if (typeof icon === 'function') { cb = icon; }
      var ok = window.confirm(message && message.message ? message.message : message);
      if (cb) cb(null, ok);
    }
  };

  // The real homey.js calls the page's onHomeyReady(Homey) once the DOM is
  // ready — the settings page attaches ALL its event listeners and loads its
  // values inside that callback, so without this call the page is inert.
  // This shim is loaded from <head>, before onHomeyReady is defined, so wait
  // for DOMContentLoaded.
  function boot() {
    if (typeof window.onHomeyReady === 'function') window.onHomeyReady(window.Homey);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`;

interface ApiRoute { method: string; path: string; }

export interface SettingsWebDeps {
  /** The fake homey context (settings store + manifest). */
  homey: any;
  /** The app's Web API handlers (api.mts default export), keyed by route key. */
  apiHandlers: Record<string, (args: any) => Promise<any>>;
  /** Route table from .homeycompose/app.json `api` (routeKey -> method/path). */
  apiRoutes: Record<string, ApiRoute>;
  /** Called after each settings write; the real one persists to settings.json. */
  persist?: (key: string, value: any) => void;
}

/** Match `/voices` against a declared path like `/voices` or `/thing/:id`. */
function matchRoute(routePath: string, actualPath: string): Record<string, string> | null {
  const rp = routePath.split('/').filter(Boolean);
  const ap = actualPath.split('/').filter(Boolean);
  if (rp.length !== ap.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < rp.length; i++) {
    if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(ap[i]);
    else if (rp[i] !== ap[i]) return null;
  }
  return params;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: any): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload ?? null));
}

/**
 * The request handler, separated from the listen/bind plumbing so tests can
 * drive it with injected fakes.
 */
export function createRequestHandler(deps: SettingsWebDeps): http.RequestListener {
  const { homey, apiHandlers, apiRoutes, persist } = deps;

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();

      // The page itself — re-read per request so live edits show on reload.
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(readFileSync(SETTINGS_HTML_PATH, 'utf8'));
        return;
      }

      // The webview-bridge shim the page loads via <script src="/homey.js">.
      if (method === 'GET' && path === '/homey.js') {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.end(HOMEY_JS_SHIM);
        return;
      }

      // Homey.get / Homey.set — the fake homey.settings store.
      const settingMatch = path.match(/^\/he\/settings\/([^/]+)$/);
      if (settingMatch) {
        const key = decodeURIComponent(settingMatch[1]);
        if (method === 'GET') {
          sendJson(res, 200, { value: homey.settings.get(key) ?? null });
          return;
        }
        if (method === 'PUT') {
          let body: any;
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            sendJson(res, 400, { error: 'Invalid JSON body' });
            return;
          }
          const value = body?.value ?? null;
          // Fires homey.settings 'set' either way, so SettingsManager picks the
          // change up exactly like a save from the real settings page.
          if (value === null) await homey.settings.unset(key);
          else await homey.settings.set(key, value);
          persist?.(key, value);
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      // Homey.api — dispatch to the app's real api.mts handlers.
      if (path.startsWith('/he/api/')) {
        const apiPath = path.slice('/he/api'.length);
        for (const [routeKey, route] of Object.entries(apiRoutes)) {
          if (route.method.toUpperCase() !== method) continue;
          const params = matchRoute(route.path, apiPath);
          if (!params) continue;
          const handler = apiHandlers[routeKey];
          if (!handler) break;

          let body: any = null;
          if (method !== 'GET' && method !== 'HEAD') {
            const raw = await readBody(req);
            if (raw) {
              try {
                body = JSON.parse(raw);
              } catch {
                sendJson(res, 400, { error: 'Invalid JSON body' });
                return;
              }
            }
          }
          const query = Object.fromEntries(url.searchParams.entries());
          const result = await handler({ homey, query, params, body });
          sendJson(res, 200, result);
          return;
        }
        sendJson(res, 404, { error: `No API route for ${method} ${apiPath}` });
        return;
      }

      res.statusCode = 404;
      res.end('Not found');
    } catch (e: any) {
      log.error('Settings web request failed', e);
      if (!res.headersSent) sendJson(res, 500, { error: e?.message ?? String(e) });
      else res.end();
    }
  };
}

/**
 * Start the settings web UI. Resolves to the URL to open, or null when the
 * port can't be bound (the emulator keeps running without the web UI).
 * Port/interface come from HE_SETTINGS_PORT / HE_SETTINGS_HOST (settable in
 * settings.json -> env). Default binds localhost only — the page hands out
 * API keys to anyone who can reach it, so exposing it on the LAN
 * (HE_SETTINGS_HOST=0.0.0.0) is opt-in.
 */
export async function startSettingsWeb(homey: any): Promise<string | null> {
  // Loaded lazily: api.mts pulls in the provider stack, which tests that only
  // exercise the request handler shouldn't have to pay for.
  const { default: apiHandlers } = await import('../../api.mjs');

  const port = Number(process.env.HE_SETTINGS_PORT) || DEFAULT_SETTINGS_WEB_PORT;
  const host = process.env.HE_SETTINGS_HOST || '127.0.0.1';

  const handler = createRequestHandler({
    homey,
    apiHandlers,
    apiRoutes: homey.manifest?.api ?? {},
    persist: saveGlobalSetting,
  });

  return new Promise((done) => {
    const server = http.createServer(handler);
    server.on('error', (err: any) => {
      log.error(
        `Could not start the settings web UI on ${host}:${port} (${err?.code ?? err}). ` +
        'Set HE_SETTINGS_PORT to a free port. Continuing without it.',
      );
      done(null);
    });
    server.listen(port, host, () => {
      const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
      done(`http://${shownHost}:${port}/`);
    });
  });
}
