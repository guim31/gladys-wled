// -----------------------------------------------------------------------------
// Builds a complete test world: fake Gladys, simulated WLED network, temporary
// /data, and the integration wired on top through registerHandlers.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHandlers } from '../../src/app.js';
import { Store } from '../../src/store.js';
import { createFakeGladys } from './fakeGladys.js';
import { FIXTURES, createController, createFakeWled, settle } from './fakeWled.js';

// The integration logs every discovery; keep the test output readable
// (LOG_LEVEL is read on every log call). LOG_LEVEL=debug npm test shows them.
process.env.LOG_LEVEL ??= 'silent';

/** One controller per fixture, each on its own address. */
export const allControllers = () =>
  Object.values(FIXTURES).map((fixture) => createController(fixture));

/**
 * @param {object} [options]
 * @param {Array} [options.controllers] from createController
 * @param {object} [options.config] raw integration config
 * @param {boolean} [options.mdns] the core answers the mDNS scan
 * @param {boolean} [options.mdnsDeclared] false: the scan is refused (403)
 * @param {Array} [options.gladysDevices] devices already created in Gladys
 * @param {boolean} [options.connect]
 * @param {string} [options.dataDir]
 * @param {object} [options.timings] hub timing overrides
 */
export async function createWorld({
  controllers = allControllers(),
  config = {},
  mdns = true,
  mdnsDeclared = true,
  gladysDevices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-wled-')),
  timings = {},
  now,
} = {}) {
  const network = createFakeWled(controllers, { mdns });
  const gladys = createFakeGladys({
    config,
    devices: gladysDevices,
    scanNetwork: mdnsDeclared ? network.scanNetwork : undefined,
  });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    fetch: network.fetch,
    createSocket: network.createSocket,
    timers: false,
    timings: { debounceMs: 0, ...timings },
    now,
  });
  if (connect) {
    await gladys.fake.connect();
    await app.ready;
    await settle(app.hub);
  }
  return { gladys, network, app, hub: app.hub, dataDir };
}

/** External id of the controller device of a simulated controller. */
export const controllerId = (gladys, controller) =>
  gladys.externalIds('controller', controller.mac).device;

/** External id of a segment device. */
export const segmentId = (gladys, controller, id) =>
  gladys.externalIds('segment', `${controller.mac}-${id}`).device;

/** Create every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.gladys.discoveredDevices) {
    await world.gladys.fake.createDevice(device.external_id);
  }
  await settle(world.hub);
}
