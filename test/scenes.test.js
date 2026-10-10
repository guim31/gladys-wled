import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES, createController, settle } from './helpers/fakeWled.js';
import { createWorld, controllerId, segmentId } from './helpers/world.js';

test('apply_preset takes a name (any case) or a number, and says which preset ran', async (t) => {
  const controller = createController(FIXTURES.rgbwNoWebsocket);
  const world = await createWorld({ controllers: [controller] });
  t.after(() => world.app.stop());
  const id = controllerId(world.gladys, controller);
  const run = (fields) => world.gladys.fake.call('sceneAction:apply_preset', fields);

  assert.deepEqual(await run({ device: id, preset: '  playlist 1 ' }), {
    preset_id: 3,
    preset_name: 'Playlist 1',
  });
  assert.deepEqual(controller.posts.at(-1), { ps: 3, v: true });
  assert.deepEqual(await run({ device: id, preset: 2 }), { preset_id: 2, preset_name: 'Preset 2' });
  await assert.rejects(
    run({ device: id, preset: 'Disco' }),
    /No preset "Disco" on WLED RGBW Light/,
  );
  await assert.rejects(
    run({ device: 'ext:test-integration:controller:ffffffffffff', preset: 1 }),
    /Unknown WLED device/,
  );
});

test('start_effect lights the strip with the effect, palette, speed and intensity', async (t) => {
  const controller = createController(FIXTURES.rgbwCct);
  const world = await createWorld({ controllers: [controller] });
  t.after(() => world.app.stop());
  const id = controllerId(world.gladys, controller);
  const run = (fields) => world.gladys.fake.call('sceneAction:start_effect', fields);

  assert.deepEqual(
    await run({ device: id, effect: 'rainbow', palette: 'Party', speed: 100, intensity: 0 }),
    { effect_id: 9, effect_name: 'Rainbow' },
  );
  assert.deepEqual(controller.posts.at(-1), {
    on: true,
    seg: [{ id: 0, fx: 9, pal: 6, sx: 255, ix: 0 }],
    v: true,
  });
  // Only the effect: palette and levels untouched.
  await run({ device: id, effect: '2' });
  assert.deepEqual(controller.posts.at(-1), { on: true, seg: [{ id: 0, fx: 2 }], v: true });

  await assert.rejects(run({ device: id, effect: 'Moonwalk' }), /No effect "Moonwalk"/);
  await assert.rejects(
    run({ device: id, effect: 'Rainbow', palette: 'Plaid' }),
    /No palette "Plaid"/,
  );
});

test('start_effect on a segment device turns that segment on', async (t) => {
  const controller = createController(FIXTURES.rgbTwoSegments);
  const world = await createWorld({
    controllers: [controller],
    config: { segment_devices: 'all' },
  });
  t.after(() => world.app.stop());
  const ceiling = segmentId(world.gladys, controller, 0);
  await world.gladys.fake.call('sceneAction:start_effect', { device: ceiling, effect: 'Blink' });
  await settle(world.hub);
  assert.deepEqual(controller.posts.at(-1), {
    on: true,
    seg: [{ id: 0, fx: 1, on: true }],
    v: true,
  });
});
