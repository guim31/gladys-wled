// -----------------------------------------------------------------------------
// The `wled` dashboard widget: contents checked with the SDK validator (the
// core's vocabulary and budget), live tiles cross-checked with the discovered
// devices (the validator does not know them), action fields checked against
// the core's field rules (the validator ignores them), and the actions.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { favoritePresets, fitButton, fitStatus } from '../src/widgets.js';
import { FIXTURES, createController, settle } from './helpers/fakeWled.js';
import { createWorld, controllerId, segmentId } from './helpers/world.js';

const get = (world, settings, language = 'en') =>
  world.gladys.fake.call('widgetGet:wled', { settings, language, units: 'metric' });

// Every device_feature of a content must exist in the discovered devices.
function assertLinkedFeatures(world, content) {
  const features = new Set(
    world.gladys.discoveredDevices.flatMap((d) => d.features.map((f) => f.external_id)),
  );
  for (const component of content.components) {
    if (component.device_feature) {
      assert.ok(features.has(component.device_feature), `${component.device_feature} exists`);
    }
  }
}

// The core validates action fields with its config-field rules: option labels
// are multi-language objects with `en`, a select default is one of its options.
function assertActionFields(content) {
  for (const component of content.components) {
    for (const field of component.action?.fields ?? []) {
      assert.ok(field.label.en, `${field.key}: label.en`);
      assert.ok(field.options.length > 0, `${field.key}: options`);
      for (const option of field.options) {
        assert.equal(typeof option.value, 'string');
        assert.ok(option.value.length > 0);
        assert.equal(typeof option.label.en, 'string', `${field.key}: option label.en`);
      }
      if (field.default !== undefined) {
        assert.ok(
          field.options.some((o) => o.value === field.default),
          'default in options',
        );
      }
    }
  }
}

test('without a device, or with an unknown one, the widget says what to do', async (t) => {
  const world = await createWorld({ controllers: [createController(FIXTURES.rgb0154)] });
  t.after(() => world.app.stop());
  for (const [settings, pattern] of [
    [{}, /Choose a WLED device/],
    [{ device: 'ext:test-integration:controller:ffffffffffff' }, /not known yet/],
  ]) {
    const content = await get(world, settings);
    assert.deepEqual(validateWidgetContent(content), []);
    assert.match(content.components[0].text, pattern);
  }
  const french = await get(world, {}, 'fr');
  assert.match(french.components[0].text, /Choisissez un appareil WLED/);
});

test('controller widget: caption, live brightness, status, favourite presets, effect picker', async (t) => {
  const controller = createController(FIXTURES.rgbwNoWebsocket);
  const world = await createWorld({ controllers: [controller] });
  t.after(() => world.app.stop());
  const id = controllerId(world.gladys, controller);
  const content = await get(world, { device: id });
  assert.deepEqual(validateWidgetContent(content), []);
  assertLinkedFeatures(world, content);
  assertActionFields(content);

  const [caption, tile, status, ...buttons] = content.components;
  assert.equal(caption.text, 'WLED RGBW Light · WLED 0.99.0b1 · 30 LEDs');
  assert.equal(tile.device_feature, `${id}:brightness`);
  assert.deepEqual(
    status.items.map((item) => [item.label, item.value]),
    [
      ['Light', 'On'],
      ['Effect', 'Solid'],
      ['Palette', 'Default'],
      ['Preset', 'None'],
    ],
  );
  assert.deepEqual(
    buttons.map((b) => [b.label, b.action.key, b.action.params]),
    [
      ['Preset 1', 'preset_1', { preset: 1 }],
      ['Preset 2', 'preset_2', { preset: 2 }],
      ['Playlist 1', 'preset_3', { preset: 3 }],
      ['Effect', 'effect', undefined],
    ],
  );
  assert.equal(buttons[3].action.fields[0].default, '0');
  assert.ok(
    buttons.every((b) => b.style === 'secondary'),
    'never primary (dark mode)',
  );
});

test('the active preset is marked by its icon, and the widget follows the language', async (t) => {
  const controller = createController(FIXTURES.rgbwNoWebsocket);
  const world = await createWorld({ controllers: [controller] });
  t.after(() => world.app.stop());
  const id = controllerId(world.gladys, controller);
  await world.gladys.fake.call(
    'widgetAction:wled',
    'preset_2',
    { preset: 2 },
    { settings: { device: id } },
  );
  const content = await get(world, { device: id }, 'fr');
  const buttons = content.components.filter((c) => c.type === 'button');
  assert.deepEqual(
    buttons.map((b) => b.icon),
    ['bookmark', 'check-circle', 'bookmark', 'play'],
  );
  const status = content.components.find((c) => c.type === 'status');
  assert.deepEqual(status.items.at(-1).value, 'Preset 2');
  assert.equal(status.items[0].label, 'Éclairage');
  assert.equal(status.items.at(-1).label, 'Préréglage');
  assert.match(content.components[0].text, /30 LED$/);
});

test('a long preset name is cut cleanly in the status list', async (t) => {
  const long = 'Living room evening ambiance with warm amber glow';
  const controller = createController(FIXTURES.rgb0154, {
    presets: { 0: {}, 1: { n: long, on: true } },
  });
  const world = await createWorld({ controllers: [controller] });
  t.after(() => world.app.stop());
  const id = controllerId(world.gladys, controller);
  await world.gladys.fake.call(
    'setValue',
    { external_id: id },
    { external_id: `${id}:preset` },
    '1',
  );
  const content = await get(world, { device: id });
  assert.deepEqual(validateWidgetContent(content), []);
  const value = content.components.find((c) => c.type === 'status').items.at(-1).value;
  assert.equal(value, 'Living room evening ambiance with warm…');
  assert.ok(value.length <= 40);
  const button = content.components.find((c) => c.type === 'button');
  assert.equal(button.label, 'Living room evening amb…');
  assert.ok(button.label.length <= 24);
  assert.equal(fitStatus('Short'), 'Short');
  assert.equal(fitButton('Short'), 'Short');
});

test('presets with a quick-load label are the favourites', () => {
  const presets = [
    { id: 1, name: 'A', quickLabel: null },
    { id: 2, name: 'B', quickLabel: '★' },
    { id: 3, name: 'C', quickLabel: null },
    { id: 4, name: 'D', quickLabel: '🌙' },
  ];
  assert.deepEqual(
    favoritePresets({ presets }).map((p) => p.id),
    [2, 4],
  );
  assert.deepEqual(
    favoritePresets({ presets: presets.map((p) => ({ ...p, quickLabel: null })) }).map((p) => p.id),
    [1, 2, 3],
  );
  assert.deepEqual(favoritePresets({}), []);
});

test('segment widget: its own effect, no presets, unreachable shown', async (t) => {
  const controller = createController(FIXTURES.rgbTwoSegments);
  const world = await createWorld({
    controllers: [controller],
    config: { segment_devices: 'all' },
  });
  t.after(() => world.app.stop());
  const ceiling = segmentId(world.gladys, controller, 0);
  controller.online = false;
  await world.gladys.fake.call('poll', { external_id: ceiling });
  const content = await get(world, { device: ceiling });
  assert.deepEqual(validateWidgetContent(content), []);
  assertLinkedFeatures(world, content);
  assert.match(
    content.components[0].text,
    /^WLED RGB Light – Ceiling · WLED 0\.14\.4 · 30 LEDs · unreachable$/,
  );
  const status = content.components.find((c) => c.type === 'status');
  assert.deepEqual(
    status.items.map((item) => item.label),
    ['Light', 'Effect', 'Palette'],
  );
  const buttons = content.components.filter((c) => c.type === 'button');
  assert.deepEqual(
    buttons.map((b) => b.action.key),
    ['effect'],
  );
});

test('widget actions apply a preset or start the effect picked in the form', async (t) => {
  const controller = createController(FIXTURES.rgb0154);
  const world = await createWorld({ controllers: [controller] });
  t.after(() => world.app.stop());
  const id = controllerId(world.gladys, controller);
  const act = (key, params, context) =>
    world.gladys.fake.call('widgetAction:wled', key, params, context);

  controller.presets = { 0: {}, 4: { n: 'Cozy', bri: 40 } };
  controller.savePreset(5, { n: 'Bright', bri: 255 });
  controller.push();
  await settle(world.hub);

  assert.deepEqual(await act('preset_1', { preset: 4 }, { settings: { device: id } }), {
    message: { en: 'Preset applied: Cozy', fr: 'Préréglage appliqué : Cozy' },
  });
  assert.deepEqual(controller.posts.at(-1), { ps: 4, v: true });

  assert.deepEqual(await act('effect', {}, { settings: { device: id }, values: { effect: '9' } }), {
    message: { en: 'Effect started: Rainbow', fr: 'Effet lancé : Rainbow' },
  });
  assert.deepEqual(controller.posts.at(-1), { on: true, seg: [{ id: 0, fx: 9 }], v: true });

  await assert.rejects(act('effect', {}, { settings: { device: id } }), /Update Gladys/);
  await assert.rejects(act('dance', {}, { settings: { device: id } }), /Unknown action dance/);
  await assert.rejects(act('preset_1', { preset: 4 }, { settings: {} }), /Choose a WLED device/);
});
