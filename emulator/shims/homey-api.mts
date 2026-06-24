// Shim for the `homey-api` package. ApiHelper calls
// HomeyAPI.createAppAPI({ homey }); we return the in-memory fake world so the
// DeviceManager queries/controls the dummy devices from settings.json.
import { world } from '../runtime/fake-world.mjs';

export class HomeyAPI {
  static async createAppAPI(_opts?: any): Promise<any> {
    return world.createApi();
  }
}

export default { HomeyAPI };
