// -----------------------------------------------------------------------------
// Where to look for WLED controllers: the mDNS announcements relayed by the
// Gladys core (`_wled._tcp`, declared in the manifest `network_discovery`), the
// addresses typed in the configuration, and the addresses already known.
//
// The integration container sits on a bridge network: it never sees mDNS
// itself, the core browses for it (mediated network discovery). Each address
// is then probed over HTTP, and the MAC address WLED reports identifies the
// controller whatever address it answers on.
// -----------------------------------------------------------------------------

import { parseMdnsTxt } from '@gladysassistant/integration-sdk';

export const MDNS_SERVICE = '_wled._tcp';
export const MDNS_TIMEOUT_SECONDS = 5;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Candidate addresses from the raw mDNS results of `scanNetwork('mdns')`:
 * `[{ host, mac, name }]`, IPv4 first (a link-local IPv6 address cannot be
 * reached from the container).
 * @param {Array} results `[{ name, host, addresses, port, txt }]`
 */
export function mdnsCandidates(results) {
  const candidates = [];
  for (const result of Array.isArray(results) ? results : []) {
    if (!result || typeof result !== 'object') {
      continue;
    }
    const addresses = Array.isArray(result.addresses) ? result.addresses : [];
    const ipv4 = addresses.find((address) => typeof address === 'string' && IPV4.test(address));
    if (!ipv4) {
      continue;
    }
    const port = Number.isInteger(result.port) && result.port !== 80 ? `:${result.port}` : '';
    const txt = parseMdnsTxt(result.txt);
    const mac = typeof txt.mac === 'string' ? txt.mac.toLowerCase().replace(/[^0-9a-f]/g, '') : '';
    const host = `${ipv4}${port}`;
    if (!candidates.some((candidate) => candidate.host === host)) {
      candidates.push({
        host,
        mac: /^[0-9a-f]{12}$/.test(mac) ? mac : null,
        name: typeof result.name === 'string' ? result.name : null,
      });
    }
  }
  return candidates;
}

/**
 * Run `task` on every item, `limit` at a time; resolves with the results in
 * order (`{ value }` or `{ error }`).
 */
export async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { value: await task(items[index]) };
      } catch (error) {
        results[index] = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
