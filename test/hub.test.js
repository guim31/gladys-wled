// -----------------------------------------------------------------------------
// The integration end to end, through the SDK handlers, against simulated WLED
// controllers: discovery, live states, commands, the preset trigger, the cache
// under /data, address changes and unreachable controllers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURES, createController, settle } from './helpers/fakeWled.js';
import { createAll, createWorld, controllerId, segmentId } from './helpers/world.js';

const feature = (deviceExternalId, key) => ({ external_id: `${deviceExternalId}:${key}` });
const device = (externalId) => ({ external_id: externalId });

test('mDNS through Gladys finds every controller and publishes its device', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { gladys, hub } = world;
  assert.deepEqual(gladys.scans, [{ type: 'mdns', timeoutSeconds: 5 }]);
  assert.equal(gladys.discoveredDevices.length, 6);
  assert.deepEqual(gladys.connectionStatuses.at(-1), { connected: true, message: undefined });
  // Nothing created yet: no state sent (Gladys would drop them).
  assert.equal(gladys.states.length, 0);
  const summary = hub.summary();
  assert.equal(summary.mdns, 'ok');
  assert.equal(summary.controllers.filter((c) => c.reachable).length, 6);
  // WebSocket for the builds that have one, poll for the others.
  const live = Object.fromEntries(summary.controllers.map((c) => [c.version, c.live]));
  assert.equal(live['0.15.4'], true);
  assert.equal(live['0.99.0b1'], false);
});

test('typed addresses work when the core refuses the mDNS scan', async (t) => {
  const controllers = [createController(FIXTURES.rgb0154), createController(FIXTURES.rgbwCct)];
  const world = await createWorld({
    controllers,
    mdnsDeclared: false,
    config: { hosts: `${controllers[0].host}, nonsense_host` },
  });
  t.after(() => world.app.stop());
  assert.deepEqual(
    world.gladys.discoveredDevices.map((d) => d.external_id),
    [controllerId(world.gladys, controllers[0])],
  );
  const message = await world.gladys.fake.call('action:search', {});
  assert.match(
    message.en,
    /1 controller\(s\), 1 answering: WLED EE0005 \(192\.0\.2\.15, 0\.15\.4, live\)/,
  );
  assert.match(message.en, /mDNS\) through Gladys is unavailable/);
  assert.match(message.en, /Ignored addresses: nonsense_host/);
  assert.match(message.fr, /1 contrôleur\(s\), 1 répondent/);
});

test('no controller found: the Configuration screen says so', async (t) => {
  const world = await createWorld({ controllers: [] });
  t.after(() => world.app.stop());
  assert.deepEqual(world.gladys.discoveredDevices, []);
  const status = world.gladys.connectionStatuses.at(-1);
  assert.equal(status.connected, false);
  assert.match(status.message.en, /No WLED controller found/);
  const message = await world.gladys.fake.call('action:search', {});
  assert.equal(message.en, 'No WLED controller found.');
});

test('one controller answering on two addresses is one device, on the typed address', async (t) => {
  const controller = createController(FIXTURES.rgb0154);
  const world = await createWorld({
    controllers: [controller],
    config: { hosts: 'wled.lan' },
    connect: false,
  });
  t.after(() => world.app.stop());
  // wled.lan is a DNS name of the controller mDNS announces by its IP.
  world.network.alias('wled.lan', controller);
  await world.gladys.fake.connect();
  await world.app.ready;
  await settle(world.hub);
  assert.equal(world.gladys.discoveredDevices.length, 1);
  assert.equal(world.hub.controllers.get(controller.mac).host, 'wled.lan');
  assert.deepEqual(world.gladys.discoveredDevices[0].params[0], {
    name: 'IP_ADDRESS',
    value: 'wled.lan',
  });
});

test('created devices get every state, their badge, and the widget a nudge', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { gladys, network } = world;
  const controller = network.find('192.0.2.13'); // RGBW + CCT, preset 2 active
  const id = controllerId(gladys, controller);
  const refreshesBefore = gladys.widgetRefreshes.length;
  await gladys.fake.createDevice(id);
  await settle(world.hub);

  const published = gladys.states.filter((s) => s.device_feature_external_id.startsWith(`${id}:`));
  assert.equal(published.length, 12, 'one state per feature');
  assert.equal(gladys.fake.lastState(`${id}:power`), 1);
  assert.equal(gladys.fake.lastState(`${id}:color-temperature`), 2943);
  assert.equal(gladys.fake.lastState(`${id}:preset`), '2');
  assert.deepEqual(gladys.fake.lastTransport(id), { external_id: id, transport: 'local' });
  assert.ok(gladys.widgetRefreshes.length > refreshesBefore);
  // Only the created device: the others stay silent.
  assert.ok(gladys.states.every((s) => s.device_feature_external_id.startsWith(`${id}:`)));
});

test('a command is sent to WLED and its answer published once', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { gladys, network } = world;
  const controller = network.find('192.0.2.15');
  const id = controllerId(gladys, controller);
  await createAll(world);
  const count = gladys.states.length;

  await gladys.fake.call('setValue', device(id), feature(id, 'brightness'), 30);
  await settle(world.hub);
  assert.deepEqual(controller.posts.at(-1), { on: true, bri: 77, v: true });
  assert.equal(gladys.fake.lastState(`${id}:brightness`), 30);
  // The WebSocket push that follows carries the same state: nothing new.
  const added = gladys.states.slice(count);
  assert.deepEqual(
    added.map((s) => s.device_feature_external_id.split(':').pop()),
    ['brightness'],
  );

  await gladys.fake.call('setValue', device(id), feature(id, 'effect'), '9');
  await settle(world.hub);
  assert.deepEqual(controller.posts.at(-1), { seg: [{ id: 0, fx: 9 }], v: true });
  assert.equal(gladys.fake.lastState(`${id}:effect`), '9');

  await gladys.fake.call('setValue', device(id), feature(id, 'color'), 0x00ff00);
  await settle(world.hub);
  assert.deepEqual(controller.posts.at(-1), {
    on: true,
    seg: [{ id: 0, col: [[0, 255, 0]] }],
    v: true,
  });
  assert.equal(gladys.fake.lastState(`${id}:color`), 0x00ff00);
});

test('"None" in the preset list sends nothing and shows the real preset back', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { gladys, network } = world;
  const controller = network.find('192.0.2.13');
  const id = controllerId(gladys, controller);
  await createAll(world);
  const posts = controller.posts.length;
  const count = gladys.states.length;
  await gladys.fake.call('setValue', device(id), feature(id, 'preset'), 'none');
  assert.equal(controller.posts.length, posts);
  assert.deepEqual(gladys.states.slice(count), [
    { device_feature_external_id: `${id}:preset`, text: '2' },
  ]);
});

test('commands on unknown devices or features fail with a message', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { gladys } = world;
  await assert.rejects(
    gladys.fake.call('setValue', device('ext:test-integration:controller:ffffffffffff'), {}, 1),
    /Unknown WLED device/,
  );
  const id = controllerId(gladys, world.network.find('192.0.2.15'));
  await assert.rejects(
    gladys.fake.call('setValue', device(id), feature(id, 'teleport'), 1),
    /Unknown feature/,
  );
});

test('a change made in the WLED app arrives over the WebSocket', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { gladys, network } = world;
  const controller = network.find('192.0.2.16'); // 16.0.1
  const id = controllerId(gladys, controller);
  await createAll(world);
  const count = gladys.states.length;

  controller.apply({ on: false, seg: [{ id: 0, pal: 5 }] });
  controller.push();
  await settle(world.hub);
  assert.equal(gladys.fake.lastState(`${id}:power`), 0);
  assert.equal(gladys.fake.lastState(`${id}:palette`), '5');
  // ps went from 3 to -1 (changed by hand), the rest did not move.
  assert.deepEqual(
    gladys.states
      .slice(count)
      .map((s) => s.device_feature_external_id.split(':').pop())
      .sort(),
    ['palette', 'power', 'preset'],
  );
  assert.equal(gladys.fake.lastState(`${id}:preset`), 'none');

  // The same document again: nothing published.
  const again = gladys.states.length;
  controller.push();
  await settle(world.hub);
  assert.equal(gladys.states.length, again);
});

test('a preset started outside Gladys fires the trigger, one started by Gladys does not', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { gladys, network } = world;
  const controller = network.find('192.0.2.15');
  controller.presets = {
    0: {},
    1: { n: 'Evening', on: true, bri: 60 },
    2: { n: 'Party', seg: [{ fx: 9 }] },
    3: { n: 'Loop', playlist: { ps: [1, 2], dur: [100, 100] } },
  };
  controller.savePreset(4, { n: 'Night', bri: 5 });
  controller.push(); // new pmt: the presets are read again
  await settle(world.hub);
  const id = controllerId(gladys, controller);
  assert.equal(gladys.sceneEvents.length, 0, 'the first state is not an activation');

  // From the WLED app.
  controller.apply({ ps: 1 });
  controller.push();
  await settle(world.hub);
  assert.deepEqual(gladys.sceneEvents, [
    { key: 'preset_activated', data: { device: id, preset: 'Evening', preset_id: 1 } },
  ]);

  // From Gladys (device list), then from a scene action: no event.
  await createAll(world);
  await gladys.fake.call('setValue', device(id), feature(id, 'preset'), '2');
  await settle(world.hub);
  await gladys.fake.call('sceneAction:apply_preset', { device: id, preset: 'night' });
  await settle(world.hub);
  assert.equal(gladys.sceneEvents.length, 1);
  assert.equal(gladys.fake.lastState(`${id}:preset`), '4');

  // A playlist started from the app fires once, not on every entry.
  controller.apply({ ps: 3 });
  controller.push();
  await settle(world.hub);
  controller.state.ps = 2;
  controller.push();
  await settle(world.hub);
  assert.equal(gladys.sceneEvents.length, 2);
  assert.deepEqual(gladys.sceneEvents[1].data, { device: id, preset: 'Loop', preset_id: 3 });
});

test('a preset saved in WLED reaches the preset list of the created device', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { gladys, network } = world;
  const controller = network.find('192.0.2.13');
  const id = controllerId(gladys, controller);
  const optionsOf = () =>
    gladys.discoveredDevices
      .find((d) => d.external_id === id)
      .features.find((f) => f.external_id === `${id}:preset`)
      .supported_options.map((o) => o.label);
  assert.deepEqual(optionsOf(), ['None']);
  const publications = gladys.publications;

  controller.savePreset(7, { n: 'Reading', bri: 200 });
  controller.push();
  await settle(world.hub);
  assert.equal(gladys.publications, publications + 1);
  assert.deepEqual(optionsOf(), ['None', 'Reading']);

  // No change: no new publication.
  controller.push();
  await settle(world.hub);
  assert.equal(gladys.publications, publications + 1);
});

test('a build without WebSocket is polled, and an unreachable controller is flagged', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { gladys, network, hub } = world;
  const controller = network.find('192.0.2.12'); // ws: -1
  const id = controllerId(gladys, controller);
  assert.ok(!network.sockets.some((s) => s.controller.host === controller.host));
  await createAll(world);

  controller.apply({ on: false });
  await gladys.fake.call('poll', device(id));
  assert.equal(gladys.fake.lastState(`${id}:power`), 0);

  controller.online = false;
  await gladys.fake.call('poll', device(id));
  assert.deepEqual(gladys.fake.lastTransport(id), { external_id: id, transport: 'unreachable' });
  assert.equal(hub.summary().controllers.find((c) => c.host === controller.host).reachable, false);
  await assert.rejects(
    gladys.fake.call('setValue', device(id), feature(id, 'power'), 1),
    /unreachable/,
  );

  controller.online = true;
  await gladys.fake.call('poll', device(id));
  assert.deepEqual(gladys.fake.lastTransport(id), { external_id: id, transport: 'local' });
});

test('every controller unreachable: the Configuration screen says so', async (t) => {
  const controller = createController(FIXTURES.rgbwNoWebsocket);
  const world = await createWorld({ controllers: [controller] });
  t.after(() => world.app.stop());
  controller.online = false;
  await world.gladys.fake.call('poll', device(controllerId(world.gladys, controller)));
  const status = world.gladys.connectionStatuses.at(-1);
  assert.equal(status.connected, false);
  assert.match(status.message.fr, /Aucun contrôleur WLED ne répond/);
});

test('known controllers stay in the Discovery list while they are off', async (t) => {
  const first = await createWorld();
  await first.app.stop();
  const saved = JSON.parse(await readFile(join(first.dataDir, 'wled-state.json'), 'utf8'));
  assert.equal(Object.keys(saved.controllers).length, 6);
  assert.ok(Array.isArray(saved.controllers['02c0ffee0003'].effects));

  // Restart with every controller off.
  const controllers = first.network.controllers.map((c) => Object.assign(c, { online: false }));
  const second = await createWorld({ controllers, dataDir: first.dataDir });
  t.after(() => second.app.stop());
  assert.equal(second.gladys.discoveredDevices.length, 6);
  const id = controllerId(second.gladys, controllers[2]);
  await second.gladys.fake.createDevice(id);
  assert.deepEqual(second.gladys.fake.lastTransport(id), {
    external_id: id,
    transport: 'unreachable',
  });
  // The cached state is published, so the device is not blank.
  assert.equal(second.gladys.fake.lastState(`${id}:power`), 1);
});

test('a controller that changed address (DHCP) keeps its device', async (t) => {
  const controller = createController(FIXTURES.rgb0154);
  const first = await createWorld({ controllers: [controller] });
  await first.app.stop();

  first.network.move(controller, '192.0.2.150');
  const second = await createWorld({ controllers: [controller], dataDir: first.dataDir });
  t.after(() => second.app.stop());
  const devices = second.gladys.discoveredDevices;
  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0].params[0], { name: 'IP_ADDRESS', value: '192.0.2.150' });
  assert.equal(second.hub.controllers.get(controller.mac).reachable, true);
});

test('very old builds without /json/si are read through /json', async (t) => {
  const controller = createController(FIXTURES.rgbMinimal, { noSi: true });
  const world = await createWorld({ controllers: [controller] });
  t.after(() => world.app.stop());
  assert.equal(world.gladys.discoveredDevices.length, 1);
  assert.ok(controller.requests.some((r) => r.path === '/json'));
});

test('one device per segment: own states, commands to its segment, new segments listed', async (t) => {
  const world = await createWorld({ config: { segment_devices: 'all' } });
  t.after(() => world.app.stop());
  const { gladys, network } = world;
  const controller = network.find('192.0.2.11'); // two segments
  const ceiling = segmentId(gladys, controller, 0);
  assert.ok(gladys.discoveredDevices.some((d) => d.external_id === ceiling));
  await createAll(world);
  assert.equal(gladys.fake.lastState(`${ceiling}:color`), 0x7facff);

  await gladys.fake.call('setValue', device(ceiling), feature(ceiling, 'power'), 0);
  await settle(world.hub);
  assert.deepEqual(controller.posts.at(-1), { seg: [{ id: 0, on: false }], v: true });
  assert.equal(gladys.fake.lastState(`${ceiling}:power`), 0);
  const controllerDevice = controllerId(gladys, controller);
  assert.equal(gladys.fake.lastState(`${controllerDevice}:power`), 1, 'the controller stays on');

  // A third segment created in WLED appears in the Discovery list (this
  // build has no WebSocket: seen on the next poll).
  controller.state.seg.push({ ...controller.state.seg[1], id: 2, start: 20, n: 'Desk' });
  await gladys.fake.call('poll', device(controllerDevice));
  assert.ok(gladys.discoveredDevices.some((d) => d.name === 'WLED RGB Light – Desk'));
});

test('the configuration can change at run time', async (t) => {
  const controllers = [createController(FIXTURES.rgb0154), createController(FIXTURES.rgbwCct)];
  const world = await createWorld({ controllers, mdns: false });
  t.after(() => world.app.stop());
  const { gladys } = world;
  assert.equal(gladys.discoveredDevices.length, 0);

  await gladys.fake.call('configUpdated', { hosts: controllers[1].host, language: 'fr' });
  await settle(world.hub);
  assert.equal(gladys.discoveredDevices.length, 1);
  assert.equal(gladys.discoveredDevices[0].features[0].name, 'Éclairage');
  assert.equal(gladys.connectionStatuses.at(-1).connected, true);
});

test('Gladys reconnecting gets the devices and states again', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { gladys } = world;
  await createAll(world);
  const publications = gladys.publications;
  const count = gladys.states.length;
  await gladys.fake.connect();
  await settle(world.hub);
  assert.equal(gladys.publications, publications + 1);
  assert.equal(gladys.states.length, count * 2, 'every state sent again');
  assert.equal(gladys.scans.length, 1, 'no new scan on a reconnection');
});

test('a scan request from the Discovery screen looks again', async (t) => {
  const world = await createWorld({ controllers: [createController(FIXTURES.rgb0154)] });
  t.after(() => world.app.stop());
  await world.gladys.fake.call('scan');
  assert.equal(world.gladys.scans.length, 2);
  assert.equal(world.gladys.discoveredDevices.length, 1);
});

test('WebSocket pushes in a burst are merged', async (t) => {
  const controller = createController(FIXTURES.rgb0154);
  const world = await createWorld({ controllers: [controller], timings: { debounceMs: 30 } });
  t.after(() => world.app.stop());
  const { gladys } = world;
  await createAll(world);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const count = gladys.states.length;
  for (const bri of [10, 20, 30, 40, 50]) {
    controller.apply({ bri });
    controller.push();
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle(world.hub);
  const id = controllerId(gladys, controller);
  const brightness = gladys.states
    .slice(count)
    .filter((s) => s.device_feature_external_id === `${id}:brightness`);
  assert.deepEqual(
    brightness.map((s) => s.state),
    [20],
  );
});

test('a probe that times out does not flag a controller whose WebSocket is live', async (t) => {
  const controller = createController(FIXTURES.rgb0154);
  const world = await createWorld({ controllers: [controller] });
  t.after(() => world.app.stop());
  const { gladys, hub } = world;
  const id = controllerId(gladys, controller);
  await createAll(world);
  // The rescan's HTTP probe fails, the WebSocket stays up.
  controller.online = false;
  await gladys.fake.call('scan');
  controller.online = true;
  assert.deepEqual(gladys.fake.lastTransport(id), { external_id: id, transport: 'local' });

  // Flagged unreachable some other way: the next push sets it back.
  hub.setReachable(hub.controllers.get(controller.mac), false);
  controller.push();
  await settle(hub);
  assert.equal(hub.controllers.get(controller.mac).reachable, true);
  assert.deepEqual(gladys.fake.lastTransport(id), { external_id: id, transport: 'local' });
});
