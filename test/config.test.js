import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseHosts } from '../src/config.js';

test('normalizeConfig returns usable defaults when called with nothing', () => {
  assert.deepEqual(normalizeConfig(), {
    hosts: [],
    invalidHosts: [],
    segmentDevices: 'none',
    language: 'en',
  });
  assert.deepEqual(normalizeConfig(null), normalizeConfig());
});

test('normalizeConfig keeps the known values and drops the unknown ones', () => {
  const config = normalizeConfig({
    hosts: '192.168.1.50',
    segment_devices: 'all',
    language: 'fr',
  });
  assert.deepEqual(config.hosts, ['192.168.1.50']);
  assert.equal(config.segmentDevices, 'all');
  assert.equal(config.language, 'fr');

  const odd = normalizeConfig({ segment_devices: 'some', language: 'de', hosts: 42 });
  assert.equal(odd.segmentDevices, DEFAULT_CONFIG.segment_devices);
  assert.equal(odd.language, DEFAULT_CONFIG.language);
  assert.deepEqual(odd.hosts, []);
});

test('parseHosts accepts the separators and the URLs users paste', () => {
  const { hosts, invalid } = parseHosts(
    'http://192.168.1.50/, 192.168.1.51;192.168.1.52:8080\nwled-kitchen.lan  192.168.1.50',
  );
  assert.deepEqual(hosts, [
    '192.168.1.50',
    '192.168.1.51',
    '192.168.1.52:8080',
    'wled-kitchen.lan',
  ]);
  assert.deepEqual(invalid, []);
});

test('parseHosts reports what it cannot use', () => {
  const { hosts, invalid } = parseHosts(
    '192.168.1.300, 192.168.1, 10.0.0.1:99999, wled_kitchen, ok.lan',
  );
  assert.deepEqual(hosts, ['ok.lan']);
  assert.deepEqual(invalid, ['192.168.1.300', '192.168.1', '10.0.0.1:99999', 'wled_kitchen']);
});

test('parseHosts caps the list at 64 addresses', () => {
  const many = Array.from({ length: 80 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250}`);
  assert.equal(parseHosts(many.join(',')).hosts.length, 64);
});
