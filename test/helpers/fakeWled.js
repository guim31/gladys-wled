// -----------------------------------------------------------------------------
// A simulated network of WLED controllers, built from the fixtures (real
// answers of WLED 0.14 to 16.0 collected by python-wled): a `fetch` double for
// the JSON API and a WebSocket factory for `/ws`.
//
// Each controller keeps its own state and applies the changes it receives the
// way WLED does for what the integration sends (on, bri, ps, nl, udpn, seg by
// id or the selected ones), then pushes `{ state, info }` to its WebSockets.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const readFixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/wled/${name}`, import.meta.url), 'utf8'));

// Every controller fixture, with the address the anonymized info reports.
export const FIXTURES = {
  rgbTwoSegments: 'rgb-two-segments-0.14.4.json',
  rgbwNoWebsocket: 'rgbw-no-websocket-0.99.json',
  rgbwCct: 'rgbw-cct-0.15.0-b3.json',
  rgbMinimal: 'rgb-minimal-0.14.0.json',
  rgb0154: 'rgb-0.15.4.json',
  rgbSegmentLc: 'rgb-segment-lc-16.0.1.json',
};

const clone = (value) => structuredClone(value);
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * One simulated controller.
 * @param {string} fixture file name in test/fixtures/wled
 * @param {object} [options]
 * @param {object} [options.presets] content of /presets.json (else the fixture's, else none)
 * @param {boolean} [options.noSi] answer 404 on /json/si (very old builds)
 * @param {string} [options.host] address it answers on (default: info.ip)
 */
export function createController(fixture, { presets, noSi = false, host } = {}) {
  const data = readFixture(fixture);
  const controller = {
    host: host ?? data.info.ip,
    state: clone(data.state),
    info: clone(data.info),
    effects: clone(data.effects),
    palettes: clone(data.palettes),
    presets: clone(presets ?? data.presets ?? null),
    noSi,
    online: true,
    sockets: new Set(),
    posts: [],
    requests: [],

    get mac() {
      return controller.info.mac;
    },

    document() {
      return { state: clone(controller.state), info: clone(controller.info) };
    },

    /** Push the current state to every open WebSocket, like WLED does. */
    push(document = controller.document()) {
      for (const socket of controller.sockets) {
        socket.emit('message', { data: JSON.stringify(document) });
      }
    },

    /** Apply a state change the way WLED does (the subset the integration sends). */
    apply(change) {
      const { state } = controller;
      let presetApplied = false;
      if (Number.isInteger(change.ps)) {
        const preset = controller.presets?.[String(change.ps)];
        if (preset && Object.keys(preset).length > 0) {
          presetApplied = true;
          if (preset.playlist) {
            state.pl = change.ps;
            state.ps = preset.playlist.ps?.[0] ?? -1;
          } else {
            state.pl = -1;
            state.ps = change.ps;
            controller.applyFields(preset);
          }
        }
      }
      controller.applyFields(change);
      if (!presetApplied && Object.keys(change).some((key) => key !== 'v')) {
        // A change made by hand: no preset is active anymore.
        state.ps = -1;
        state.pl = -1;
      }
    },

    applyFields(change) {
      const { state } = controller;
      if (typeof change.on === 'boolean') {
        state.on = change.on;
      }
      if (Number.isInteger(change.bri)) {
        state.bri = change.bri;
      }
      if (change.nl && typeof change.nl === 'object') {
        state.nl = { ...state.nl, ...change.nl };
      }
      if (change.udpn && typeof change.udpn === 'object') {
        state.udpn = { ...state.udpn, ...change.udpn };
      }
      const segments = Array.isArray(change.seg) ? change.seg : change.seg ? [change.seg] : [];
      for (const segmentChange of segments) {
        const targets = Number.isInteger(segmentChange.id)
          ? state.seg.filter((segment) => segment.id === segmentChange.id)
          : state.seg.filter((segment) => segment.sel);
        for (const segment of targets) {
          const { id: _id, col, ...fields } = segmentChange;
          Object.assign(segment, fields);
          if (Array.isArray(col)) {
            col.forEach((color, index) => {
              if (Array.isArray(color) && color.length > 0) {
                // WLED fills the channels left out with 0.
                segment.col[index] = [0, 1, 2, 3]
                  .slice(0, Math.max(3, segment.col[index]?.length ?? 3, color.length))
                  .map((channel) => color[channel] ?? 0);
              }
            });
          }
        }
      }
    },

    /** Save a preset in WLED's interface: new presets file and `pmt`. */
    savePreset(id, preset) {
      controller.presets = { ...(controller.presets ?? { 0: {} }), [String(id)]: preset };
      controller.info.fs = { ...controller.info.fs, pmt: (controller.info.fs?.pmt ?? 0) + 60 };
    },
  };
  return controller;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (typeof body === 'string') {
        throw new SyntaxError('Unexpected token');
      }
      return clone(body);
    },
  };
}

class FakeSocket {
  constructor(controller, network) {
    this.controller = controller;
    this.network = network;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(listener);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
    if (this.network.silent.has(this.controller.host)) {
      return;
    }
    setImmediate(() => {
      if (!this.closed) {
        this.emit('message', { data: JSON.stringify(this.controller.document()) });
      }
    });
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.controller.sockets.delete(this);
    setImmediate(() => this.emit('close', {}));
  }
}

/**
 * @param {Array} controllers from createController
 * @param {object} [options]
 * @param {boolean} [options.mdns] answer the mDNS scan with every controller
 */
export function createFakeWled(controllers, { mdns = true } = {}) {
  const byHost = new Map(controllers.map((controller) => [controller.host, controller]));
  const network = {
    controllers,
    sockets: [],
    silent: new Set(),

    find(host) {
      return byHost.get(host);
    },

    /** Another address of the same controller (a DNS name, a second interface). */
    alias(host, controller) {
      byHost.set(host, controller);
    },

    /** Move a controller to another address (DHCP). */
    move(controller, host) {
      byHost.delete(controller.host);
      controller.host = host;
      controller.info.ip = host;
      byHost.set(host, controller);
    },

    async fetch(url, init = {}) {
      const { host, pathname } = new URL(url);
      const controller = byHost.get(host);
      if (!controller || !controller.online) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'EHOSTUNREACH' };
        throw error;
      }
      const method = init.method ?? 'GET';
      controller.requests.push({ method, path: pathname });
      if (method === 'POST' && pathname === '/json/state') {
        const change = JSON.parse(init.body);
        controller.posts.push(change);
        controller.apply(change);
        setImmediate(() => controller.push());
        return jsonResponse(200, change.v ? controller.state : { success: true });
      }
      switch (pathname) {
        case '/json/si':
          return controller.noSi
            ? jsonResponse(404, 'Not found')
            : jsonResponse(200, controller.document());
        case '/json':
          return jsonResponse(200, {
            ...controller.document(),
            effects: controller.effects,
            palettes: controller.palettes,
          });
        case '/json/eff':
          return jsonResponse(200, controller.effects);
        case '/json/pal':
          return jsonResponse(200, controller.palettes);
        case '/presets.json':
          return controller.presets ? jsonResponse(200, controller.presets) : jsonResponse(404, '');
        default:
          return jsonResponse(404, 'Not found');
      }
    },

    createSocket(url) {
      const { host } = new URL(url);
      const controller = byHost.get(host);
      const socket = new FakeSocket(controller ?? { host, sockets: new Set() }, network);
      network.sockets.push(socket);
      setImmediate(() => {
        if (socket.closed) {
          return;
        }
        if (!controller || !controller.online) {
          socket.closed = true;
          socket.emit('error', {});
          return;
        }
        controller.sockets.add(socket);
        socket.emit('open', {});
        // WLED sends its state as soon as a client connects.
        socket.emit('message', { data: JSON.stringify(controller.document()) });
      });
      return socket;
    },

    /** Raw results of `scanNetwork('mdns')`, as the core relays them. */
    mdnsResults() {
      return controllers
        .filter((controller) => controller.online)
        .map((controller) => ({
          name: `wled-${controller.mac.slice(-6)}`,
          host: `wled-${controller.mac.slice(-6)}.local`,
          addresses: ['fe80::1', controller.host],
          port: 80,
          txt: [`mac=${controller.mac}`],
        }));
    },

    async scanNetwork(type) {
      if (type !== 'mdns') {
        throw Object.assign(new Error('capture type not declared'), { status: 403 });
      }
      return mdns ? network.mdnsResults() : [];
    },
  };
  network.fetch = network.fetch.bind(network);
  network.createSocket = network.createSocket.bind(network);
  network.scanNetwork = network.scanNetwork.bind(network);
  return network;
}

/** Let the simulated sockets and pending timers of zero delay run. */
export async function settle(hub, rounds = 5) {
  for (let i = 0; i < rounds; i += 1) {
    await tick();
    await hub?.idle();
  }
}
