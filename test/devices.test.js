// -----------------------------------------------------------------------------
// Discovery payloads, state values and commands, on the real answers of the
// fixtures (no network: the controller records are built from the files).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_KEYS,
  NO_PRESET,
  buildDevices,
  commandFor,
  controllerName,
  controllerValues,
  effectOptions,
  presetOptions,
  segmentDeviceIds,
  segmentValues,
} from '../src/devices.js';
import { parseEffects, parseInfo, parsePalettes, parsePresets } from '../src/wled/model.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { FIXTURES, readFixture } from './helpers/fakeWled.js';

/** A controller record as the hub keeps it, from a fixture. */
function record(fixture, overrides = {}) {
  const data = readFixture(fixture);
  return {
    mac: data.info.mac,
    host: data.info.ip,
    rawInfo: data.info,
    info: parseInfo(data.info),
    state: data.state,
    effects: parseEffects(data.effects),
    palettes: parsePalettes(data.palettes),
    presets: parsePresets(data.presets ?? readFixture('presets.json')),
    ...overrides,
  };
}

const gladys = createFakeGladys();
const keysOf = (device) => device.features.map((f) => f.external_id.split(':').pop());
const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

test('an RGB controller: light, effect lists, preset, nightlight and sync; no white', () => {
  const [device] = buildDevices(gladys, record(FIXTURES.rgb0154), {
    language: 'en',
    segmentDevices: 'none',
  });
  assert.equal(device.name, 'WLED EE0005', 'a controller left at "WLED" gets its MAC suffix');
  assert.equal(device.external_id, 'ext:test-integration:controller:02c0ffee0005');
  assert.equal(device.should_poll, false);
  assert.equal(device.poll_frequency, undefined);
  assert.deepEqual(device.params, [
    { name: 'IP_ADDRESS', value: '192.0.2.15' },
    { name: 'WLED_MAC', value: '02c0ffee0005' },
  ]);
  assert.deepEqual(keysOf(device), [
    'power',
    'brightness',
    'color',
    'effect',
    'palette',
    'effect-speed',
    'effect-intensity',
    'preset',
    'nightlight',
    'sync',
  ]);
  assert.deepEqual(featureOf(device, 'brightness'), {
    name: 'Brightness',
    external_id: 'ext:test-integration:controller:02c0ffee0005:brightness',
    category: 'light',
    type: 'brightness',
    unit: 'percent',
    min: 0,
    max: 100,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  });
  const effect = featureOf(device, 'effect');
  assert.equal(effect.category, 'text');
  assert.equal(effect.type, 'select');
  assert.equal(effect.min, 0);
  assert.equal(effect.max, 0);
  assert.equal(effect.keep_history, false);
  assert.deepEqual(effect.supported_options[0], { value: '0', label: 'Solid', sort_order: 0 });
  assert.equal(featureOf(device, 'effect-speed').type, 'dimmer');
  assert.equal(featureOf(device, 'effect-speed').unit, undefined);
});

test('RGBW gets a white channel, RGBW + CCT a colour temperature in kelvins', () => {
  const [rgbw] = buildDevices(gladys, record(FIXTURES.rgbwNoWebsocket), {
    language: 'en',
    segmentDevices: 'none',
  });
  assert.ok(keysOf(rgbw).includes('white'));
  assert.ok(!keysOf(rgbw).includes('color-temperature'));

  const [cct] = buildDevices(gladys, record(FIXTURES.rgbwCct), {
    language: 'en',
    segmentDevices: 'none',
  });
  assert.deepEqual(keysOf(cct).slice(0, 5), [
    'power',
    'brightness',
    'color',
    'color-temperature',
    'white',
  ]);
  const temperature = featureOf(cct, 'color-temperature');
  assert.equal(temperature.unit, 'kelvin');
  assert.deepEqual([temperature.min, temperature.max], [2000, 6535]);
});

test('a white-only strip has no colour nor palette', () => {
  const controller = record(FIXTURES.rgb0154);
  controller.info = { ...controller.info, capabilities: { rgb: false, white: true, cct: false } };
  const [device] = buildDevices(gladys, controller, { language: 'en', segmentDevices: 'none' });
  assert.deepEqual(keysOf(device).slice(0, 4), ['power', 'brightness', 'white', 'effect']);
  assert.ok(!keysOf(device).includes('palette'));
});

test('feature names follow the configured language', () => {
  const [device] = buildDevices(gladys, record(FIXTURES.rgbwCct), {
    language: 'fr',
    segmentDevices: 'none',
  });
  assert.deepEqual(
    device.features.map((f) => f.name),
    [
      'Éclairage',
      'Luminosité',
      'Couleur',
      'Température de couleur',
      'Canal blanc',
      'Effet',
      'Palette',
      "Vitesse de l'effet",
      "Intensité de l'effet",
      'Preset',
      'Veilleuse',
      'Synchro UDP',
    ],
  );
  assert.deepEqual(featureOf(device, 'preset').supported_options[0], {
    value: NO_PRESET,
    label: 'Aucun',
    sort_order: 0,
  });
});

test('one device per segment, only on controllers with several segments', () => {
  const two = record(FIXTURES.rgbTwoSegments);
  assert.deepEqual(segmentDeviceIds(two, 'all'), [0, 1]);
  assert.deepEqual(segmentDeviceIds(two, 'none'), []);
  assert.deepEqual(segmentDeviceIds(record(FIXTURES.rgb0154), 'all'), []);

  const devices = buildDevices(gladys, two, { language: 'en', segmentDevices: 'all' });
  assert.deepEqual(
    devices.map((d) => d.name),
    ['WLED RGB Light', 'WLED RGB Light – Ceiling', 'WLED RGB Light – Segment 1'],
  );
  const segment = devices[1];
  assert.equal(segment.external_id, 'ext:test-integration:segment:02c0ffee0001-0');
  assert.deepEqual(segment.params.at(-1), { name: 'WLED_SEGMENT', value: '0' });
  assert.ok(!keysOf(segment).includes('preset'), 'presets belong to the controller');
  assert.ok(!keysOf(segment).includes('nightlight'));
});

test('effect options: Solid first, then by name; presets: None then by number', () => {
  const options = effectOptions(record(FIXTURES.rgbwCct));
  assert.equal(options[0].label, 'Solid');
  const names = options.slice(1).map((o) => o.label);
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
  );
  assert.equal(new Set(options.map((o) => o.value)).size, options.length, 'unique values');

  assert.deepEqual(presetOptions(record(FIXTURES.rgbwNoWebsocket), 'en'), [
    { value: 'none', label: 'None' },
    { value: '1', label: 'Preset 1' },
    { value: '2', label: 'Preset 2' },
    { value: '3', label: 'Playlist 1' },
    { value: '4', label: 'Playlist 2' },
  ]);
});

test('controller values come from the main segment and the global state', () => {
  // Two segments: segment 1 is the main one (amber, effect 3, palette 1).
  const values = controllerValues(record(FIXTURES.rgbTwoSegments));
  assert.equal(values[FEATURE_KEYS.POWER], 1);
  assert.equal(values[FEATURE_KEYS.BRIGHTNESS], 50);
  assert.equal(values[FEATURE_KEYS.COLOR], 0xffaa00);
  assert.deepEqual(values[FEATURE_KEYS.EFFECT], { text: '3' });
  assert.deepEqual(values[FEATURE_KEYS.PALETTE], { text: '1' });
  assert.equal(values[FEATURE_KEYS.EFFECT_SPEED], 6);
  assert.deepEqual(values[FEATURE_KEYS.PRESET], { text: NO_PRESET });
  assert.equal(values[FEATURE_KEYS.NIGHTLIGHT], 0);
  assert.equal(values[FEATURE_KEYS.SYNC], 0);

  // RGBW + CCT, preset 2 active.
  const cct = controllerValues(record(FIXTURES.rgbwCct));
  assert.equal(cct[FEATURE_KEYS.COLOR], 0);
  assert.equal(cct[FEATURE_KEYS.WHITE], 100);
  assert.equal(cct[FEATURE_KEYS.COLOR_TEMPERATURE], 2943); // cct 53
  assert.deepEqual(cct[FEATURE_KEYS.PRESET], { text: '2' });
});

test('a segment shows lit only when the controller is on too', () => {
  const controller = record(FIXTURES.rgbTwoSegments);
  assert.equal(segmentValues(controller, 0)[FEATURE_KEYS.POWER], 1);
  assert.equal(segmentValues(controller, 0)[FEATURE_KEYS.COLOR], 0x7facff);
  controller.state = { ...controller.state, on: false };
  assert.equal(segmentValues(controller, 0)[FEATURE_KEYS.POWER], 0);
  assert.deepEqual(segmentValues(controller, 9), {});
});

test('controller commands go to the selected segments', () => {
  const controller = record(FIXTURES.rgbTwoSegments);
  const command = (key, value) => commandFor(controller, null, key, value);
  assert.deepEqual(command('power', 1), { on: true });
  assert.deepEqual(command('power', 0), { on: false });
  assert.deepEqual(command('brightness', 50), { on: true, bri: 128 });
  assert.deepEqual(command('brightness', 0), { on: false });
  assert.deepEqual(command('brightness', 0.2), { on: true, bri: 1 });
  assert.deepEqual(command('color', 0x112233), { seg: [{ id: 1, col: [[0x11, 0x22, 0x33]] }] });
  assert.deepEqual(command('effect', '9'), { seg: [{ id: 1, fx: 9 }] });
  assert.deepEqual(command('palette', '6'), { seg: [{ id: 1, pal: 6 }] });
  assert.deepEqual(command('effect-speed', 100), { seg: [{ id: 1, sx: 255 }] });
  assert.deepEqual(command('effect-intensity', 50), { seg: [{ id: 1, ix: 128 }] });
  assert.deepEqual(command('preset', '2'), { ps: 2 });
  assert.equal(command('preset', NO_PRESET), null);
  assert.deepEqual(command('nightlight', 1), { nl: { on: true } });
  assert.deepEqual(command('sync', 0), { udpn: { send: false } });
});

test('segment commands target their segment and light the controller', () => {
  const controller = record(FIXTURES.rgbTwoSegments);
  const command = (key, value) => commandFor(controller, 0, key, value);
  assert.deepEqual(command('power', 1), { on: true, seg: [{ id: 0, on: true }] });
  assert.deepEqual(command('power', 0), { seg: [{ id: 0, on: false }] });
  assert.deepEqual(command('brightness', 100), { on: true, seg: [{ id: 0, on: true, bri: 255 }] });
  assert.deepEqual(command('brightness', 0), { seg: [{ id: 0, on: false }] });
  assert.deepEqual(command('effect', 0), { seg: [{ id: 0, fx: 0 }] });
});

test('colour temperature turns the light white, white channel keeps the colour', () => {
  const cct = record(FIXTURES.rgbwCct);
  assert.deepEqual(commandFor(cct, null, 'color-temperature', 2000), {
    seg: [{ id: 0, cct: 0, col: [[0, 0, 0, 255]] }],
  });
  // RGB + CCT without a white channel: full RGB white.
  const rgbCct = record(FIXTURES.rgb0154);
  rgbCct.info = { ...rgbCct.info, capabilities: { rgb: true, white: false, cct: true } };
  assert.deepEqual(commandFor(rgbCct, null, 'color-temperature', 6535), {
    seg: [{ id: 0, cct: 255, col: [[255, 255, 255]] }],
  });

  const rgbw = record(FIXTURES.rgbwNoWebsocket);
  assert.deepEqual(commandFor(rgbw, null, 'white', 50), {
    seg: [{ id: 0, col: [[255, 0, 0, 128]] }],
  });
});

test('commands refuse what the controller does not have', () => {
  const controller = record(FIXTURES.rgbMinimal);
  assert.throws(() => commandFor(controller, null, 'effect', '2'), /Unknown effect "2"/);
  assert.throws(() => commandFor(controller, null, 'effect', 'abc'), /Unknown effect/);
  assert.throws(() => commandFor(controller, null, 'palette', '99'), /Unknown palette/);
  assert.throws(() => commandFor(controller, null, 'preset', '42'), /Unknown preset/);
  assert.throws(() => commandFor(controller, null, 'nope', 1), /Unknown feature/);
});

test('controllerName keeps a custom name', () => {
  assert.equal(controllerName(record(FIXTURES.rgbwCct)), 'WLED CCT light');
});
