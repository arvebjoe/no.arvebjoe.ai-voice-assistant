// ESM resolve hook: redirect the Homey-runtime bare specifiers to the emulator
// shims so the app can boot as a plain Node process (no Homey CLI / hardware).
//
// Registered (after tsx) by register.mjs. Because Node runs resolve hooks
// last-registered-first, this hook intercepts `homey` / `homey-api` / `homey-log`
// before tsx tries to resolve them from node_modules. Everything else falls
// through to the next resolver (tsx -> node), which also maps `.mjs` -> `.mts`.

const SHIMS = {
  homey: new URL('./shims/homey.mts', import.meta.url).href,
  'homey-api': new URL('./shims/homey-api.mts', import.meta.url).href,
  'homey-log': new URL('./shims/homey-log.mts', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  // `homey` and any subpath like `homey/lib/Homey.js`
  if (specifier === 'homey' || specifier.startsWith('homey/')) {
    return { url: SHIMS.homey, shortCircuit: true };
  }
  if (specifier === 'homey-api' || specifier.startsWith('homey-api/')) {
    return { url: SHIMS['homey-api'], shortCircuit: true };
  }
  if (specifier === 'homey-log' || specifier.startsWith('homey-log/')) {
    return { url: SHIMS['homey-log'], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
