// -----------------------------------------------------------------------------
// In-memory stand-in for the Gladys SDK client.
//
// The published SDK (0.14.0) does not ship `createFakeGladys` yet, so this
// double reproduces the surface the integration uses, with the host API checks
// that bite most often (external id prefix, known category/type/unit, poll
// frequency, supported options, numeric or text states), using the feature
// table taken from the core. It records what Gladys would receive and lets the
// tests call the handlers the way Gladys does.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

const table = JSON.parse(
  readFileSync(new URL('../fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

export const SELECTOR = 'test-integration';

export class FakeApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Mirror of the core's normalizeSupportedOptions: a non-empty label, unique
// values (compared as strings), string values on text/select only.
function checkSupportedOptions(feature) {
  if (feature.supported_options === undefined) {
    return;
  }
  const allowStrings = feature.category === 'text' && feature.type === 'select';
  const seen = new Set();
  for (const option of feature.supported_options) {
    const value = option.value;
    const validValue =
      Number.isInteger(value) || (allowStrings && typeof value === 'string' && value.trim() !== '');
    if (!validValue) {
      throw new FakeApiError(400, `invalid supported option value ${value}`);
    }
    if (typeof option.label !== 'string' || option.label.trim() === '') {
      throw new FakeApiError(400, `supported option ${value} without label`);
    }
    if (seen.has(`${value}`)) {
      throw new FakeApiError(400, `duplicate supported option ${value}`);
    }
    seen.add(`${value}`);
  }
}

export function createFakeGladys({ config = {}, devices = [], scanNetwork } = {}) {
  const gladys = new EventEmitter();
  const handlers = new Map();
  const prefix = `ext:${SELECTOR}:`;

  Object.assign(gladys, {
    config: { ...config },
    devices: [...devices],
    discoveredDevices: [],
    publications: 0,
    states: [],
    transports: [],
    connectionStatuses: [],
    widgetRefreshes: [],
    sceneEvents: [],
    scans: [],

    externalId(suffix) {
      return `${prefix}${suffix}`;
    },
    externalIds(type, platformId) {
      const device = `${prefix}${type}:${platformId}`;
      return { device, feature: (key) => `${device}:${key}` };
    },

    async getConfig() {
      return { ...gladys.config };
    },

    async publishDiscoveredDevices(list) {
      for (const device of list) {
        if (typeof device.name !== 'string' || device.name === '') {
          throw new FakeApiError(400, 'device without name');
        }
        if (!device.external_id?.startsWith(prefix)) {
          throw new FakeApiError(400, `bad device external_id ${device.external_id}`);
        }
        if (
          device.poll_frequency !== undefined &&
          !table.poll_frequencies_ms.includes(device.poll_frequency)
        ) {
          throw new FakeApiError(400, 'invalid poll frequency');
        }
        for (const param of device.params ?? []) {
          if (String(param.name).toUpperCase().startsWith('GLADYS_')) {
            throw new FakeApiError(400, `reserved param ${param.name}`);
          }
        }
        for (const feature of device.features) {
          if (!feature.external_id?.startsWith(prefix)) {
            throw new FakeApiError(400, `bad feature external_id ${feature.external_id}`);
          }
          if (!table.categories.includes(feature.category) || !table.types.includes(feature.type)) {
            throw new FakeApiError(
              400,
              `unknown category/type ${feature.category}/${feature.type}`,
            );
          }
          if (feature.unit !== undefined && !table.units.includes(feature.unit)) {
            throw new FakeApiError(400, `unknown unit ${feature.unit}`);
          }
          checkSupportedOptions(feature);
        }
      }
      gladys.publications += 1;
      gladys.discoveredDevices = structuredClone(list);
    },

    async publishStates(states) {
      if (states.length > 100) {
        throw new FakeApiError(400, 'max 100 states per request');
      }
      for (const state of states) {
        if (!state.device_feature_external_id?.startsWith(prefix)) {
          throw new FakeApiError(400, 'bad state external id');
        }
        const numeric = typeof state.state === 'number' && Number.isFinite(state.state);
        const text = typeof state.text === 'string';
        if (!numeric && !text) {
          throw new FakeApiError(400, `state must be a number or a text, got ${state.state}`);
        }
      }
      gladys.states.push(...structuredClone(states));
    },

    async publishTransports(entries) {
      if (entries.length < 1 || entries.length > 100) {
        throw new FakeApiError(400, 'transports: 1-100 entries');
      }
      gladys.transports.push(...structuredClone(entries));
    },

    async setConnectionStatus(connected, message) {
      gladys.connectionStatuses.push({ connected, message });
    },

    async publishSceneEvent(key, data = {}) {
      gladys.sceneEvents.push({ key, data: structuredClone(data) });
      return { success: true };
    },

    requestWidgetRefresh(key) {
      gladys.widgetRefreshes.push(key);
    },

    async scanNetwork(type, options = {}) {
      gladys.scans.push({ type, ...options });
      if (!scanNetwork) {
        throw new FakeApiError(403, 'network_discovery: capture type not declared');
      }
      return scanNetwork(type, options);
    },

    // --- Handler registration (the SDK surface) ------------------------------
    onScanRequest: (cb) => handlers.set('scan', cb),
    onSetValue: (cb) => handlers.set('setValue', cb),
    onPoll: (cb) => handlers.set('poll', cb),
    onDeviceCreated: (cb) => handlers.set('deviceCreated', cb),
    onConfigUpdated: (cb) => handlers.set('configUpdated', cb),
    onAction: (key, cb) => handlers.set(`action:${key}`, cb),
    onSceneAction: (key, cb) => handlers.set(`sceneAction:${key}`, cb),
    onWidgetGet: (key, cb) => handlers.set(`widgetGet:${key}`, cb),
    onWidgetAction: (key, cb) => handlers.set(`widgetAction:${key}`, cb),

    // --- Gladys calling the integration ---------------------------------------
    fake: {
      handlers,
      async connect() {
        await Promise.all(gladys.listeners('connected').map((listener) => listener()));
      },
      call(name, ...args) {
        const handler = handlers.get(name);
        if (!handler) {
          throw new Error(`no handler registered for ${name}`);
        }
        return handler(...args);
      },
      /** The user clicks "Add" in the Discovery screen. */
      async createDevice(externalId) {
        const device = gladys.discoveredDevices.find((d) => d.external_id === externalId);
        if (!device) {
          throw new Error(`${externalId} is not in the discovered devices`);
        }
        gladys.devices = [...gladys.devices.filter((d) => d.external_id !== externalId), device];
        await handlers.get('deviceCreated')(device);
        return device;
      },
      lastState(featureExternalId) {
        const state = gladys.states.findLast(
          (s) => s.device_feature_external_id === featureExternalId,
        );
        return state?.text ?? state?.state;
      },
      lastTransport(externalId) {
        return gladys.transports.findLast((t) => t.external_id === externalId);
      },
    },
  });
  return gladys;
}
