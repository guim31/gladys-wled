// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr'];

// `segment_devices` options: the controller device always drives the segments
// selected in WLED; `all` also publishes one device per segment.
export const SEGMENT_MODES = ['none', 'all'];

export const DEFAULT_CONFIG = {
  hosts: '',
  segment_devices: 'none',
  language: 'en',
};

// A host is an IPv4 address or a DNS name, with an optional port. mDNS names
// (`wled-kitchen.local`) do not resolve inside the integration container: the
// documentation asks for IP addresses, but a resolvable name is accepted.
const HOST_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(:\d{1,5})?$/;
const MAX_HOSTS = 64;

/**
 * Parse the manual host list (commas, semicolons, spaces or new lines).
 * @param {unknown} raw
 * @returns {{ hosts: string[], invalid: string[] }}
 */
export function parseHosts(raw) {
  const hosts = [];
  const invalid = [];
  const entries = typeof raw === 'string' ? raw.split(/[\s,;]+/) : [];
  for (const entry of entries) {
    // Users paste URLs copied from the browser: keep the host part only.
    const host = entry
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .toLowerCase();
    if (!host) {
      continue;
    }
    if (!isValidHost(host)) {
      invalid.push(entry.trim());
    } else if (!hosts.includes(host) && hosts.length < MAX_HOSTS) {
      hosts.push(host);
    }
  }
  return { hosts, invalid };
}

function isValidHost(host) {
  const ipv4 = host.match(IPV4_PATTERN);
  if (ipv4) {
    return ipv4.slice(1, 5).every((part) => Number(part) <= 255) && validPort(ipv4[5]);
  }
  // A dotted string made of digits only is a mistyped address, not a name.
  if (/^[\d.]+(:\d+)?$/.test(host)) {
    return false;
  }
  return HOST_PATTERN.test(host) && validPort(host.match(/:(\d+)$/)?.[0]);
}

function validPort(suffix) {
  if (!suffix) {
    return true;
  }
  const port = Number(suffix.slice(1));
  return port >= 1 && port <= 65535;
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const hostsText = typeof source.hosts === 'string' ? source.hosts : DEFAULT_CONFIG.hosts;
  const { hosts, invalid } = parseHosts(hostsText);
  return {
    hosts,
    invalidHosts: invalid,
    segmentDevices: SEGMENT_MODES.includes(source.segment_devices)
      ? source.segment_devices
      : DEFAULT_CONFIG.segment_devices,
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
