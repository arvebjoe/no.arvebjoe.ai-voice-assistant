// Registers the Homey module-redirect loader (loader.mjs). Loaded via
// `node --import ./emulator/register.mjs`, which runs *after* `--import tsx`
// so our resolve hook takes priority over tsx for the Homey specifiers.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
