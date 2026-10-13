// -----------------------------------------------------------------------------
// Following the controllers without Gladys' scheduler, and keeping the logs
// quiet: the devices are published with should_poll: false (and the devices
// created before never get polled by the core 5.2), so the hub must push every
// change by itself; and a normal day writes nothing at the info level.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../src/app.js';
import { controllerName } from '../src/devices.js';
import { toPercent } from '../src/wled/model.js';
import { Store } from '../src/store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES, createController, createFakeWled, settle } from './helpers/fakeWled.js';
import { createAll, createWorld, controllerId } from './helpers/world.js';

/** Wait until `check()` is true (the hub's own timers run in these tests). */
async function waitFor(check, what, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Capture the log lines (console, as the SDK logger writes) at LOG_LEVEL=info. */
function captureLogs(t) {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  const lines = [];
  const record = (...args) => lines.push(args.map(String).join(' '));
  t.mock.method(console, 'log', record);
  t.mock.method(console, 'error', record);
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  return lines;
}

test('devices created before are followed with no Gladys poll (real SDK client)', async (t) => {
  // One controller with a WebSocket, one without (polled by the hub itself).
  const pushed = createController(FIXTURES.rgb0154);
  const polled = createController(FIXTURES.rgbwNoWebsocket);
  const network = createFakeWled([pushed, polled]);

  // First run: what the user created back then, in Gladys' database.
  const before = createFakeGladys({ scanResults: { mdns: network.mdnsResults() } });
  const first = registerHandlers(before, {
    store: new Store(mkdtempSync(join(tmpdir(), 'gladys-wled-'))),
    fetch: network.fetch,
    createSocket: network.createSocket,
    timers: false,
  });
  await before.connect();
  await first.ready;
  const created = before.fake.discoveredDevices;
  assert.equal(created.length, 2);
  // The real SDK host checks accept them, and the core will never poll them.
  for (const device of created) {
    assert.equal(device.should_poll, false);
    assert.equal(device.poll_frequency, undefined);
  }
  await first.stop();
  await before.disconnect();

  // Restart: the devices exist, Gladys never calls onPoll.
  const gladys = createFakeGladys({
    devices: created,
    scanResults: { mdns: network.mdnsResults() },
  });
  const app = registerHandlers(gladys, {
    store: new Store(mkdtempSync(join(tmpdir(), 'gladys-wled-'))),
    fetch: network.fetch,
    createSocket: network.createSocket,
    timings: { fallbackPollMs: 20, debounceMs: 0 },
  });
  t.after(async () => {
    await app.stop();
    await gladys.disconnect();
  });
  await gladys.connect();
  await app.ready;
  await settle(app.hub);

  const pushedId = gladys.externalIds('controller', pushed.mac).device;
  const polledId = gladys.externalIds('controller', polled.mac).device;
  // Every state of the created devices is sent at start.
  assert.equal(gladys.fake.lastState(`${pushedId}:power`), 1);
  assert.equal(gladys.fake.lastState(`${polledId}:power`), 1);

  // Changes made outside Gladys reach it: pushed over the WebSocket...
  pushed.apply({ on: false });
  pushed.push();
  await waitFor(() => gladys.fake.lastState(`${pushedId}:power`) === 0, 'the push');
  // ... and read by the hub's own poll for the build without WebSocket.
  polled.apply({ on: false });
  await waitFor(() => gladys.fake.lastState(`${polledId}:power`) === 0, 'the fallback poll');

  // No poll request ever came from Gladys.
  assert.ok(!gladys.fake.wsMessages.some((message) => /poll/i.test(JSON.stringify(message))));

  // onPoll stays a working fallback for a Gladys that would poll anyway.
  polled.apply({ on: true });
  assert.deepEqual(await gladys.fake.poll({ external_id: polledId }), { success: true });
  assert.equal(gladys.fake.lastState(`${polledId}:power`), 1);
});

test('a normal cycle writes nothing at the info level', async (t) => {
  const pushed = createController(FIXTURES.rgb0154);
  const polled = createController(FIXTURES.rgbwNoWebsocket);
  const world = await createWorld({
    controllers: [pushed, polled],
    timers: true,
    timings: { fallbackPollMs: 20 },
  });
  t.after(() => world.app.stop());
  const { gladys, hub } = world;
  await createAll(world);

  const lines = captureLogs(t);
  // Pushes, fallback polls, a rescan and a command: the everyday traffic.
  const pollsBefore = polled.requests.length;
  for (const bri of [10, 60, 200]) {
    pushed.apply({ bri });
    pushed.push();
    polled.apply({ bri });
    await settle(hub);
  }
  await waitFor(() => polled.requests.length >= pollsBefore + 3, 'three fallback polls');
  await gladys.fake.call('scan');
  const id = controllerId(gladys, pushed);
  await gladys.fake.call('setValue', { external_id: id }, { external_id: `${id}:power` }, 0);
  await settle(hub);
  assert.equal(gladys.fake.lastState(`${id}:power`), 0);
  assert.deepEqual(lines, []);
});

test('repeated failures are logged once when they start and once when they end', async (t) => {
  const polled = createController(FIXTURES.rgbwNoWebsocket);
  const world = await createWorld({ controllers: [polled] });
  t.after(() => world.app.stop());
  const { gladys, hub } = world;
  await createAll(world);
  const id = controllerId(gladys, polled);
  const controller = hub.controllers.get(polled.mac);
  const lines = captureLogs(t);

  // Gladys restarting: every state is refused.
  const publishStates = gladys.publishStates;
  gladys.publishStates = async () => {
    throw new Error('fetch failed');
  };
  for (const bri of [10, 20, 30]) {
    polled.apply({ bri });
    await hub.refresh(controller).catch(() => {});
  }
  // Gladys' failure does not make the controller unreachable.
  assert.equal(controller.reachable, true);
  gladys.publishStates = publishStates;
  polled.apply({ bri: 40 });
  await hub.refresh(controller);
  assert.equal(gladys.fake.lastState(`${id}:brightness`), toPercent(40));

  // The controller unplugged for three polls, then back.
  polled.online = false;
  for (let i = 0; i < 3; i += 1) {
    await hub.refresh(controller);
  }
  polled.online = true;
  await hub.refresh(controller);

  // The mDNS scan refused by Gladys at every rescan.
  const scanNetwork = gladys.scanNetwork;
  gladys.scanNetwork = async () => {
    throw new Error('403 network_discovery');
  };
  await hub.rediscover();
  await hub.rediscover();
  gladys.scanNetwork = scanNetwork;
  await hub.rediscover();

  const strip = (line) => line.replace(/^\[[^\]]+\] /, '');
  assert.deepEqual(lines.map(strip), [
    '[WARN] [wled-hub] Gladys refused an update (publishStates): fetch failed',
    '[INFO] [wled-hub] Gladys accepts the updates again',
    `[INFO] [wled-hub] ${controllerName(controller)} is unreachable`,
    `[INFO] [wled-hub] ${controllerName(controller)} is reachable`,
    '[WARN] [wled-hub] mDNS scan through Gladys failed: 403 network_discovery',
    '[INFO] [wled-hub] mDNS scan through Gladys works again',
  ]);
});
