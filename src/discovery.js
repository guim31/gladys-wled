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

export const MDNS_SERVICE = '_wled._tcp';
export const MDNS_TIMEOUT_SECONDS = 5;

/**
 * DNS-SD TXT entries to an object (RFC 6763): keys lower-cased, the value is
 * what follows the first `=`, an entry without `=` is `true`, the first
 * occurrence of a key wins. (The published SDK 0.14.0 has no parseMdnsTxt.)
 * @param {unknown} txt
 */
export function parseTxt(txt) {
  const record = {};
  for (const entry of Array.isArray(txt) ? txt : []) {
    if (typeof entry !== 'string' || entry === '' || entry.startsWith('=')) {
      continue;
    }
    const at = entry.indexOf('=');
    const key = (at === -1 ? entry : entry.slice(0, at)).toLowerCase();
    if (!(key in record)) {
      record[key] = at === -1 ? true : entry.slice(at + 1);
    }
  }
  return record;
}

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
    const txt = parseTxt(result.txt);
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
