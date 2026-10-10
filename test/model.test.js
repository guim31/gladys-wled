// -----------------------------------------------------------------------------
// Reading the WLED JSON API across versions, on real answers (python-wled
// fixtures: WLED 0.14.0, 0.14.4, 0.15.0-b3, 0.15.4, 0.99 beta, 16.0.1).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES, readFixture } from './helpers/fakeWled.js';
import {
  KELVIN_MAX,
  KELVIN_MIN,
  activePresetId,
  activeSegments,
  capabilitiesOf,
  cctToKelvin,
  controllerCapabilities,
  fromPercent,
  intToRgb,
  kelvinToCct,
  macOf,
  mainSegmentId,
  parseEffects,
  parseInfo,
  parsePalettes,
  parsePresets,
  primaryColor,
  rgbToInt,
  segmentCapabilities,
  targetSegmentIds,
  toPercent,
} from '../src/wled/model.js';

test('light capabilities follow the lc bits of each fixture', () => {
  const expected = {
    rgbTwoSegments: { rgb: true, white: false, cct: false },
    rgbwNoWebsocket: { rgb: true, white: true, cct: false },
    rgbwCct: { rgb: true, white: true, cct: true },
    rgb0154: { rgb: true, white: false, cct: false },
    rgbSegmentLc: { rgb: true, white: false, cct: false },
  };
  for (const [key, capabilities] of Object.entries(expected)) {
    const { info } = readFixture(FIXTURES[key]);
    assert.deepEqual(controllerCapabilities(info), capabilities, key);
  }
  assert.deepEqual(capabilitiesOf(4), { rgb: false, white: false, cct: true });
  assert.deepEqual(capabilitiesOf(undefined), { rgb: false, white: false, cct: false });
});

test('builds older than 0.13 (no lc) fall back on the rgbw and cct flags', () => {
  assert.deepEqual(controllerCapabilities({ leds: { count: 30, rgbw: false } }), {
    rgb: true,
    white: false,
    cct: false,
  });
  assert.deepEqual(controllerCapabilities({ leds: { rgbw: true, wv: true } }), {
    rgb: true,
    white: true,
    cct: false,
  });
  // rgbw without the white slider: the white channel is computed (auto white).
  assert.equal(controllerCapabilities({ leds: { rgbw: true, wv: false } }).white, false);
  assert.deepEqual(controllerCapabilities(undefined), { rgb: true, white: false, cct: false });
});

test('segment capabilities: seg.lc on 16.0, else info.leds.seglc by position', () => {
  const recent = readFixture(FIXTURES.rgbSegmentLc);
  assert.deepEqual(segmentCapabilities(recent.info, { ...recent.state.seg[0], lc: 3 }, 0), {
    rgb: true,
    white: true,
    cct: false,
  });
  const older = readFixture(FIXTURES.rgbwNoWebsocket);
  assert.equal(older.state.seg[0].lc, undefined);
  assert.deepEqual(segmentCapabilities(older.info, older.state.seg[0], 0), {
    rgb: true,
    white: true,
    cct: false,
  });
  // Unknown position: the controller's own.
  assert.deepEqual(segmentCapabilities(older.info, {}, 9), controllerCapabilities(older.info));
});

test('parseInfo keeps identity, live support and the list markers', () => {
  const info = parseInfo(readFixture(FIXTURES.rgbwCct).info);
  assert.equal(info.mac, '02c0ffee0003');
  assert.equal(info.name, 'WLED CCT light');
  assert.equal(info.version, '0.15.0-b3');
  assert.equal(info.ledCount, 178);
  assert.equal(info.websocket, true);
  assert.equal(info.catalogVersion, '0.15.0-b3|187|75');
  assert.equal(typeof info.presetsVersion, 'number');

  // ws: -1 = built without WebSocket support.
  assert.equal(parseInfo(readFixture(FIXTURES.rgbwNoWebsocket).info).websocket, false);
  // ws: 0 = supported, nobody connected yet.
  assert.equal(parseInfo(readFixture(FIXTURES.rgbSegmentLc).info).websocket, true);
  const empty = parseInfo({});
  assert.equal(empty.mac, null);
  assert.equal(empty.name, 'WLED');
  assert.equal(empty.presetsVersion, null);
});

test('macOf normalizes and rejects what is not a MAC address', () => {
  assert.equal(macOf({ mac: 'AA:BB:CC:DD:EE:FF' }), 'aabbccddeeff');
  assert.equal(macOf({ mac: '000000000000' }), null);
  assert.equal(macOf({ mac: 'abc' }), null);
  assert.equal(macOf({}), null);
});

test('segments: main one, selected ones, unused slots ignored', () => {
  // Two segments, the second selected and main.
  const { state } = readFixture(FIXTURES.rgbTwoSegments);
  assert.deepEqual(
    activeSegments(state).map(({ segment }) => segment.id),
    [0, 1],
  );
  assert.equal(mainSegmentId(state), 1);
  assert.deepEqual(targetSegmentIds(state), [1]);

  // Unused slots are reported as `{ stop: 0 }` (presets of 0.14+).
  const withSlots = { seg: [{ id: 0, start: 0, stop: 30, sel: false }, { stop: 0 }] };
  assert.equal(activeSegments(withSlots).length, 1);
  // Nothing selected: the main segment receives the commands.
  assert.deepEqual(targetSegmentIds(withSlots), [0]);
  // mainseg missing (0.14.0) or pointing nowhere.
  assert.equal(mainSegmentId(readFixture(FIXTURES.rgbMinimal).state), 0);
  assert.equal(mainSegmentId({ mainseg: 7, seg: [{ id: 2, stop: 10, sel: true }] }), 2);
  assert.equal(mainSegmentId({}), 0);
});

test('the active preset is the running playlist, else the last preset', () => {
  assert.equal(activePresetId({ ps: 3, pl: -1 }), 3);
  assert.equal(activePresetId({ ps: 1, pl: 4 }), 4);
  assert.equal(activePresetId({ ps: -1, pl: -1 }), -1);
  assert.equal(activePresetId({ ps: 0 }), -1);
  assert.equal(activePresetId({}), -1);
});

test('effects and palettes lists skip the reserved slots and keep their ids', () => {
  const { effects, palettes } = readFixture(FIXTURES.rgbMinimal);
  assert.deepEqual(parseEffects(effects), [
    { id: 0, name: 'Solid' },
    { id: 1, name: 'Blink' },
    { id: 3, name: 'Breathe' },
  ]);
  assert.deepEqual(parsePalettes(palettes).slice(0, 1), [{ id: 0, name: 'Default' }]);
  assert.deepEqual(parsePalettes(null), []);
  assert.deepEqual(parseEffects('oops'), []);
  // A real list: 187 slots, some reserved.
  const full = parseEffects(readFixture(FIXTURES.rgbwCct).effects);
  assert.ok(full.length > 150 && full.length < 187);
  assert.ok(full.every(({ name }) => name !== 'RSVD' && name !== '-'));
});

test('presets: ids above 0, names, playlists, quick-load labels', () => {
  assert.deepEqual(parsePresets(readFixture('presets.json')), [
    { id: 1, name: 'My Preset', playlist: false, quickLabel: null },
    { id: 2, name: 'My Playlist', playlist: true, quickLabel: null },
  ]);
  assert.deepEqual(
    parsePresets({ 0: {}, 5: { ql: '🌅', on: true }, 251: { n: 'x' }, abc: { n: 'y' }, 3: [] }),
    [{ id: 5, name: 'Preset 5', playlist: false, quickLabel: '🌅' }],
  );
  assert.deepEqual(parsePresets(null), []);
  const fromFixture = parsePresets(readFixture(FIXTURES.rgbwNoWebsocket).presets);
  assert.deepEqual(
    fromFixture.map(({ id, name, playlist }) => [id, name, playlist]),
    [
      [1, 'Preset 1', false],
      [2, 'Preset 2', false],
      [3, 'Playlist 1', true],
      [4, 'Playlist 2', true],
    ],
  );
});

test('colours: arrays of 3 or 4 channels, hex strings, Gladys integers', () => {
  assert.deepEqual(primaryColor({ col: [[255, 0, 0, 139]] }), [255, 0, 0, 139]);
  assert.deepEqual(primaryColor({ col: [[127, 172, 255]] }), [127, 172, 255, 0]);
  assert.deepEqual(primaryColor({ col: ['#FF8000'] }), [255, 128, 0, 0]);
  assert.deepEqual(primaryColor({ col: ['FF800040'] }), [255, 128, 0, 64]);
  assert.equal(primaryColor({ col: ['r'] }), null);
  assert.equal(primaryColor({}), null);
  assert.equal(rgbToInt([255, 160, 0]), 0xffa000);
  assert.deepEqual(intToRgb(0xffa000), [255, 160, 0]);
  assert.deepEqual(intToRgb(-5), [0, 0, 0]);
  assert.deepEqual(intToRgb(0x1ffffff), [255, 255, 255]);
});

test('levels: 0-255 to percent and back, a lit level never reads 0 %', () => {
  assert.equal(toPercent(0), 0);
  assert.equal(toPercent(1), 1);
  assert.equal(toPercent(128), 50);
  assert.equal(toPercent(255), 100);
  assert.equal(toPercent(300), 100);
  assert.equal(fromPercent(50), 128);
  assert.equal(fromPercent(100), 255);
  assert.equal(fromPercent(-3), 0);
  for (let percent = 1; percent <= 100; percent += 1) {
    assert.equal(toPercent(fromPercent(percent)), percent, `round trip of ${percent} %`);
  }
});

test('white balance: 0-255 to kelvins (Home Assistant range) and back', () => {
  assert.equal(cctToKelvin(0), KELVIN_MIN);
  assert.equal(cctToKelvin(255), KELVIN_MAX);
  assert.equal(cctToKelvin(127), 4259);
  // A cct written in kelvins (1900 and up) is read as such.
  assert.equal(cctToKelvin(2700), 2700);
  assert.equal(cctToKelvin(10000), KELVIN_MAX);
  assert.equal(cctToKelvin(undefined), null);
  assert.equal(kelvinToCct(KELVIN_MIN), 0);
  assert.equal(kelvinToCct(KELVIN_MAX), 255);
  assert.equal(kelvinToCct(1000), 0);
  assert.equal(kelvinToCct(cctToKelvin(53)), 53);
});
