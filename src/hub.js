// -----------------------------------------------------------------------------
// The WLED hub: finds the controllers, keeps one live link per controller,
// publishes their devices and states to Gladys, and runs the commands.
//
// Real time: every controller pushes its state over its WebSocket on each
// change. While the WebSocket is down (or on a build without one), the hub
// polls the controller every 30 s and keeps trying to reconnect. Gladys never
// polls these devices (should_poll: false): its scheduler cannot follow a push.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  DEVICE_TYPES,
  FEATURE_KEYS,
  NO_PRESET,
  buildDevices,
  commandFor,
  controllerName,
  controllerSpecs,
  controllerValues,
  deviceIds,
  segmentDeviceIds,
  segmentSpecs,
  segmentValues,
} from './devices.js';
import { MDNS_TIMEOUT_SECONDS, mapLimit, mdnsCandidates } from './discovery.js';
import { WledClient } from './wled/client.js';
import {
  activePresetId,
  activeSegments,
  fromPercent,
  macOf,
  parseEffects,
  parseInfo,
  parsePalettes,
  parsePresets,
  targetSegmentIds,
} from './wled/model.js';
import { LiveSocket } from './wled/socket.js';

// Shown by Gladys under the integration name when it is not connected.
export const CONNECTION_TEXT = {
  noController: {
    en: 'No WLED controller found. Check that it is on the same network, or enter its IP address.',
    fr: "Aucun contrôleur WLED trouvé. Vérifiez qu'il est sur le même réseau, ou saisissez son adresse IP.",
    de: 'Kein WLED-Controller gefunden. Prüfe, ob er im selben Netzwerk ist, oder gib seine IP-Adresse ein.',
    es: 'No se ha encontrado ningún controlador WLED. Compruebe que está en la misma red o introduzca su dirección IP.',
  },
  noAnswer: {
    en: 'No WLED controller answers.',
    fr: 'Aucun contrôleur WLED ne répond.',
    de: 'Kein WLED-Controller antwortet.',
    es: 'Ningún controlador WLED responde.',
  },
};

const logger = createLogger({ name: 'wled-hub' });

export const WIDGET_KEY = 'wled';
export const PRESET_TRIGGER = 'preset_activated';

export const HUB_TIMINGS = {
  // Poll of a controller whose WebSocket is down or missing.
  fallbackPollMs: 30_000,
  // New scan (mDNS + typed addresses), to follow DHCP changes and new controllers.
  rediscoveryMs: 15 * 60_000,
  // WebSocket pushes closer than this are merged (a slider dragged in the app).
  debounceMs: 300,
  // A preset change seen this long after a Gladys command is Gladys' own.
  ownPresetMs: 5_000,
};

const PROBE_CONCURRENCY = 8;
const MAX_STATES_PER_REQUEST = 100;
// Changes of these features change what the widget shows.
const WIDGET_KEYS = [
  FEATURE_KEYS.POWER,
  FEATURE_KEYS.EFFECT,
  FEATURE_KEYS.PALETTE,
  FEATURE_KEYS.PRESET,
];

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class WledHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the test double)
   * @param {object} options.store persistence (src/store.js)
   * @param {typeof fetch} [options.fetch] test seam for the HTTP client
   * @param {(url: string) => WebSocket} [options.createSocket] test seam
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {object} [options.socketTimings] SOCKET_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, fetch, createSocket, timers = true, timings, socketTimings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.fetch = fetch;
    this.createSocket = createSocket;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.socketTimings = socketTimings;
    this.now = now ?? (() => Date.now());
    this.config = null;
    /** @type {Map<string, object>} controller records, by MAC address */
    this.controllers = new Map();
    this.published = new Map();
    this.pending = new Set();
    this.rediscoveryTimer = null;
    this.lastScan = { mdns: 'not-run', found: 0, at: null };
    this.stopped = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    this.config = config;
    await this.restore();
    await this.discover();
    await this.publishDevices();
    for (const controller of this.controllers.values()) {
      this.connect(controller);
    }
    await this.publishAllStates({ force: true });
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.requestWidgetRefresh();
    if (this.timersEnabled) {
      this.rediscoveryTimer = setInterval(
        () => this.track(this.rediscover()),
        this.timings.rediscoveryMs,
      );
      this.rediscoveryTimer.unref?.();
    }
  }

  /** Gladys came back (restart, network): it may have lost what was published. */
  async resync(config) {
    this.config = config;
    this.published.clear();
    await this.publishDevices();
    await this.publishAllStates({ force: true });
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.requestWidgetRefresh();
  }

  async reconfigure(config) {
    const previous = this.config;
    this.config = config;
    if (previous && previous.hosts.join(',') !== config.hosts.join(',')) {
      await this.discover();
      for (const controller of this.controllers.values()) {
        this.connect(controller);
      }
    }
    await this.publishDevices();
    await this.publishAllStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.rediscoveryTimer);
    for (const controller of this.controllers.values()) {
      this.disconnect(controller);
    }
    await this.idle();
    await this.store.flush();
  }

  /** Keep track of background work, so the tests (and stop) can wait for it. */
  track(promise) {
    const tracked = Promise.resolve(promise)
      .catch((err) => logger.error('Background task failed', err))
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }

  /** Resolves once no background work is left. */
  async idle() {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  // --- Persistence -----------------------------------------------------------

  async restore() {
    const data = await this.store.load();
    for (const [mac, saved] of Object.entries(data.controllers ?? {})) {
      if (!saved || typeof saved.host !== 'string' || !saved.info || !saved.state) {
        continue;
      }
      const controller = this.createRecord(mac, saved.host);
      controller.rawInfo = saved.info;
      controller.info = parseInfo(saved.info);
      controller.state = saved.state;
      controller.effects = Array.isArray(saved.effects) ? saved.effects : [];
      controller.palettes = Array.isArray(saved.palettes) ? saved.palettes : [];
      controller.presets = Array.isArray(saved.presets) ? saved.presets : [];
      this.controllers.set(mac, controller);
    }
  }

  save() {
    const controllers = {};
    for (const controller of this.controllers.values()) {
      if (!controller.info) {
        continue;
      }
      controllers[controller.mac] = {
        host: controller.host,
        info: controller.rawInfo,
        state: controller.state,
        effects: controller.effects,
        palettes: controller.palettes,
        presets: controller.presets,
      };
    }
    return this.store.save({ controllers });
  }

  // --- Discovery -------------------------------------------------------------

  createRecord(mac, host) {
    return {
      mac,
      host,
      client: new WledClient(host, { fetch: this.fetch }),
      info: null,
      rawInfo: null,
      state: null,
      effects: [],
      palettes: [],
      presets: [],
      reachable: false,
      socket: null,
      pollTimer: null,
      debounceTimer: null,
      nextDocument: null,
      ownPreset: null,
      lastError: null,
    };
  }

  /**
   * Scan: mDNS through the Gladys core, the typed addresses and the known
   * ones. Resolves with the number of controllers answering.
   */
  async discover() {
    // Priority when one controller answers on several addresses: the typed
    // one, then the one mDNS announces, then the one known from before.
    const hosts = [];
    const add = (host) => {
      if (!hosts.includes(host)) {
        hosts.push(host);
      }
    };
    this.config.hosts.forEach(add);
    (await this.scanMdns()).forEach((candidate) => add(candidate.host));
    [...this.controllers.values()].forEach((controller) => add(controller.host));

    const results = await mapLimit(hosts, PROBE_CONCURRENCY, (host) => this.probe(host));
    const answers = new Map();
    results.forEach((result, index) => {
      if (result.error) {
        logger.debug(`No WLED answer from ${hosts[index]}: ${result.error.message}`);
      } else if (!answers.has(result.value.mac)) {
        answers.set(result.value.mac, result.value);
      }
    });
    for (const answer of answers.values()) {
      try {
        await this.adopt(answer);
      } catch (err) {
        logger.warn(`Cannot read ${answer.host}: ${err.message}`);
      }
    }
    for (const controller of this.controllers.values()) {
      // A live WebSocket is a better proof than one probe that timed out.
      if (!answers.has(controller.mac) && !controller.socket?.connected) {
        this.setReachable(controller, false);
      }
    }
    this.lastScan = {
      ...this.lastScan,
      found: answers.size,
      at: new Date(this.now()).toISOString(),
    };
    await this.save();
    return answers.size;
  }

  async scanMdns() {
    try {
      const results = await this.gladys.scanNetwork('mdns', {
        timeoutSeconds: MDNS_TIMEOUT_SECONDS,
      });
      const candidates = mdnsCandidates(results);
      this.lastScan = { ...this.lastScan, mdns: 'ok', mdnsCount: candidates.length };
      return candidates;
    } catch (err) {
      // 403: an older core, or the capture refused. Typed addresses still work.
      logger.warn(`mDNS scan through Gladys failed: ${err.message}`);
      this.lastScan = { ...this.lastScan, mdns: 'unavailable', mdnsError: err.message };
      return [];
    }
  }

  /** Ask one address who it is: `{ host, mac, state, info, client }`. */
  async probe(host) {
    const client = new WledClient(host, { fetch: this.fetch });
    const { state, info } = await client.getStateInfo();
    const mac = macOf(info);
    if (!mac) {
      throw new Error(`${host} answered without a MAC address`);
    }
    return { host, mac, state, info, client };
  }

  /**
   * Take a probe answer: a new controller is added, a known one found at a
   * new address (DHCP) moves there.
   */
  async adopt({ host, mac, state, info, client }) {
    let controller = this.controllers.get(mac);
    if (!controller) {
      controller = this.createRecord(mac, host);
      controller.client = client;
      this.controllers.set(mac, controller);
      logger.info(`WLED controller ${info.name ?? mac} found at ${host}`);
    } else if (controller.host !== host) {
      logger.info(`WLED controller ${mac} moved from ${controller.host} to ${host}`);
      this.disconnect(controller);
      controller.host = host;
      controller.client = client;
    }
    await this.applyInfo(controller, info, { force: !controller.info || !controller.reachable });
    controller.state = state;
    this.setReachable(controller, true);
    return controller;
  }

  async rediscover() {
    await this.discover();
    for (const controller of this.controllers.values()) {
      this.connect(controller);
    }
    // New controllers, and new addresses (DHCP) for the params of the
    // created devices.
    await this.publishDevices();
    await this.publishAllStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
  }

  /**
   * Take a fresh /json/info: refresh the effect and palette lists after a
   * firmware change, the presets after one was saved.
   */
  async applyInfo(controller, rawInfo, { force = false } = {}) {
    const info = parseInfo(rawInfo);
    const previous = controller.info;
    controller.rawInfo = rawInfo;
    controller.info = info;
    // A restart may come with a firmware update, and resets `pmt`.
    const rebooted =
      previous?.uptime !== null &&
      previous?.uptime !== undefined &&
      info.uptime !== null &&
      info.uptime < previous.uptime;
    const catalogChanged = force || rebooted || previous?.catalogVersion !== info.catalogVersion;
    // `pmt` (presets modification time) is missing on old builds: their
    // presets are only read again on a scan or a restart.
    const presetsChanged = force || rebooted || previous?.presetsVersion !== info.presetsVersion;
    if (catalogChanged) {
      controller.effects = parseEffects(await controller.client.getEffects());
      controller.palettes = parsePalettes(await controller.client.getPalettes());
    }
    if (presetsChanged) {
      controller.presets = parsePresets(await controller.client.getPresets());
    }
    return catalogChanged || presetsChanged;
  }

  // --- Devices ---------------------------------------------------------------

  /** Every device of every known controller. */
  buildAllDevices() {
    const devices = [];
    for (const controller of this.controllers.values()) {
      if (controller.info && controller.state) {
        devices.push(...buildDevices(this.gladys, controller, this.config));
      }
    }
    return devices;
  }

  async publishDevices() {
    await this.gladys.publishDiscoveredDevices(this.buildAllDevices());
  }

  /**
   * Find the controller (and segment) behind a Gladys device external id.
   * @returns {{ controller: object, segmentId: number|null } | null}
   */
  resolveDevice(externalId) {
    if (typeof externalId !== 'string') {
      return null;
    }
    const controllerPrefix = this.gladys.externalIds(DEVICE_TYPES.CONTROLLER, '').device;
    const segmentPrefix = this.gladys.externalIds(DEVICE_TYPES.SEGMENT, '').device;
    if (externalId.startsWith(controllerPrefix)) {
      const controller = this.controllers.get(externalId.slice(controllerPrefix.length));
      return controller ? { controller, segmentId: null } : null;
    }
    if (externalId.startsWith(segmentPrefix)) {
      const match = externalId.slice(segmentPrefix.length).match(/^([0-9a-f]{12})-(\d+)$/);
      const controller = match && this.controllers.get(match[1]);
      return controller ? { controller, segmentId: Number(match[2]) } : null;
    }
    return null;
  }

  /** External ids of the devices the user created in Gladys. */
  createdDeviceIds() {
    return new Set((this.gladys.devices ?? []).map((device) => device.external_id));
  }

  // --- States ----------------------------------------------------------------

  /**
   * States of the created devices of one controller: `[{ id, value }]`, with
   * `id` the feature external id. Only the features the device has.
   */
  statesOf(controller) {
    if (!controller.info || !controller.state) {
      return [];
    }
    const created = this.createdDeviceIds();
    const states = [];
    const collect = (ids, specs, values) => {
      if (!created.has(ids.device)) {
        return;
      }
      for (const spec of specs) {
        if (values[spec.key] !== undefined) {
          states.push({ id: ids.feature(spec.key), value: values[spec.key] });
        }
      }
    };
    const { language } = this.config;
    collect(
      deviceIds(this.gladys, controller),
      controllerSpecs(controller, language),
      controllerValues(controller),
    );
    for (const id of segmentDeviceIds(controller, this.config.segmentDevices)) {
      collect(
        deviceIds(this.gladys, controller, id),
        segmentSpecs(controller, id, language),
        segmentValues(controller, id),
      );
    }
    return states;
  }

  /**
   * Publish what changed since the last publication (Gladys caps states at
   * 300 a minute and re-evaluates scenes on each one). Resolves with the keys
   * of the controller-device features that changed.
   */
  async publishStates(controller, { force = false } = {}) {
    const changed = this.statesOf(controller).filter(
      ({ id, value }) => force || !sameValue(this.published.get(id), value),
    );
    if (changed.length === 0) {
      return [];
    }
    const payload = changed.map(({ id, value }) =>
      typeof value === 'object'
        ? { device_feature_external_id: id, text: value.text }
        : { device_feature_external_id: id, state: value },
    );
    for (let at = 0; at < payload.length; at += MAX_STATES_PER_REQUEST) {
      await this.gladys.publishStates(payload.slice(at, at + MAX_STATES_PER_REQUEST));
    }
    for (const { id, value } of changed) {
      this.published.set(id, value);
    }
    const prefix = `${deviceIds(this.gladys, controller).device}:`;
    return changed
      .filter(({ id }) => id.startsWith(prefix))
      .map(({ id }) => id.slice(prefix.length));
  }

  async publishAllStates(options) {
    for (const controller of this.controllers.values()) {
      try {
        await this.publishStates(controller, options);
      } catch (err) {
        logger.warn(`Cannot publish the states of ${controller.mac}: ${err.message}`);
      }
    }
  }

  /** Forget what was published for one device (Gladys drops early states). */
  forgetDevice(deviceExternalId) {
    for (const id of this.published.keys()) {
      if (id.startsWith(`${deviceExternalId}:`)) {
        this.published.delete(id);
      }
    }
  }

  /**
   * The user added a device: the states sent before were dropped by Gladys,
   * and so was the transport badge. Send them again, nudge the widget.
   */
  async onDeviceCreated(device) {
    const resolved = this.resolveDevice(device?.external_id);
    if (!resolved) {
      return;
    }
    this.forgetDevice(device.external_id);
    await this.publishStates(resolved.controller);
    await this.publishTransports([resolved.controller]);
    this.requestWidgetRefresh();
  }

  async publishTransports(controllers = [...this.controllers.values()]) {
    const created = this.createdDeviceIds();
    const entries = [];
    for (const controller of controllers) {
      const transport = controller.reachable ? 'local' : 'unreachable';
      const ids = [deviceIds(this.gladys, controller).device];
      for (const { segment } of activeSegments(controller.state)) {
        ids.push(deviceIds(this.gladys, controller, segment.id).device);
      }
      for (const externalId of ids) {
        if (created.has(externalId)) {
          entries.push({ external_id: externalId, transport });
        }
      }
    }
    for (let at = 0; at < entries.length; at += 100) {
      await this.gladys.publishTransports(entries.slice(at, at + 100));
    }
  }

  async publishConnectionStatus() {
    const controllers = [...this.controllers.values()];
    if (controllers.length === 0) {
      await this.gladys.setConnectionStatus(false, CONNECTION_TEXT.noController);
      return;
    }
    if (!controllers.some((controller) => controller.reachable)) {
      await this.gladys.setConnectionStatus(false, CONNECTION_TEXT.noAnswer);
      return;
    }
    await this.gladys.setConnectionStatus(true);
  }

  requestWidgetRefresh() {
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  setReachable(controller, reachable) {
    if (controller.reachable === reachable) {
      return false;
    }
    controller.reachable = reachable;
    if (controller.info) {
      logger.info(`${controllerName(controller)} is ${reachable ? 'reachable' : 'unreachable'}`);
    }
    return true;
  }

  // --- Live link ---------------------------------------------------------------

  connect(controller) {
    if (this.stopped || controller.socket || controller.pollTimer) {
      return;
    }
    if (controller.info?.websocket) {
      controller.socket = new LiveSocket({
        url: controller.client.websocketUrl,
        createSocket: this.createSocket,
        timings: this.socketTimings,
        logger,
        onMessage: (data) => {
          if (!controller.reachable) {
            this.track(this.reachabilityChanged(controller, true));
          }
          this.receive(controller, data);
        },
        onOpen: () => {
          this.stopPolling(controller);
          this.track(this.reachabilityChanged(controller, true));
        },
        onClose: () => this.startPolling(controller),
      });
      controller.socket.start();
      // Until the WebSocket opens, the controller is polled.
      this.startPolling(controller);
    } else {
      this.startPolling(controller);
    }
  }

  disconnect(controller) {
    controller.socket?.stop();
    controller.socket = null;
    this.stopPolling(controller);
    clearTimeout(controller.debounceTimer);
    controller.debounceTimer = null;
  }

  startPolling(controller) {
    if (!this.timersEnabled || this.stopped || controller.pollTimer) {
      return;
    }
    controller.pollTimer = setInterval(
      () => this.track(this.refresh(controller)),
      this.timings.fallbackPollMs,
    );
    controller.pollTimer.unref?.();
  }

  stopPolling(controller) {
    clearInterval(controller.pollTimer);
    controller.pollTimer = null;
  }

  /** Read the state over HTTP (fallback poll, Gladys poll, scan). */
  async refresh(controller) {
    try {
      const { state, info } = await controller.client.getStateInfo();
      await this.applyDocument(controller, { state, info });
      await this.reachabilityChanged(controller, true);
    } catch (err) {
      controller.lastError = err.message;
      logger.debug(`Refresh of ${controller.host} failed: ${err.message}`);
      await this.reachabilityChanged(controller, false);
    }
  }

  async reachabilityChanged(controller, reachable) {
    if (this.setReachable(controller, reachable)) {
      await this.publishTransports([controller]);
      await this.publishConnectionStatus();
      this.requestWidgetRefresh();
    }
  }

  /** A WebSocket push: merged with the next ones within the debounce delay. */
  receive(controller, data) {
    controller.nextDocument = data;
    if (this.timings.debounceMs <= 0) {
      controller.nextDocument = null;
      this.track(this.applyDocument(controller, data));
      return;
    }
    if (!controller.debounceTimer) {
      controller.debounceTimer = setTimeout(() => {
        controller.debounceTimer = null;
        const document = controller.nextDocument;
        controller.nextDocument = null;
        this.track(this.applyDocument(controller, document));
      }, this.timings.debounceMs);
    }
  }

  /**
   * A fresh `{ state, info? }` document: publish what changed, refresh the
   * lists and devices when the controller says they changed, fire the preset
   * trigger.
   */
  async applyDocument(controller, { state, info }) {
    const previousState = controller.state;
    const segmentsBefore = segmentKey(previousState);
    let listsChanged = false;
    if (info) {
      try {
        listsChanged = await this.applyInfo(controller, info);
      } catch (err) {
        logger.warn(`Cannot read the lists of ${controller.host}: ${err.message}`);
      }
    }
    if (state && typeof state === 'object') {
      controller.state = state;
    }
    const structureChanged =
      this.config.segmentDevices === 'all' && segmentsBefore !== segmentKey(controller.state);
    if (listsChanged || structureChanged) {
      // New effect, palette or preset lists reach the created devices through
      // a new publication (their options are upserted); new segments appear
      // in the Discovery list.
      await this.publishDevices();
      await this.save();
    }
    const changedKeys = await this.publishStates(controller);
    this.firePresetTrigger(controller, previousState);
    if (listsChanged || changedKeys.some((key) => WIDGET_KEYS.includes(key))) {
      this.requestWidgetRefresh();
    }
  }

  firePresetTrigger(controller, previousState) {
    if (!previousState) {
      return;
    }
    const before = activePresetId(previousState);
    const after = activePresetId(controller.state);
    if (after <= 0 || after === before) {
      return;
    }
    const own = controller.ownPreset;
    if (own && own.id === after && this.now() - own.at < this.timings.ownPresetMs) {
      // Applied by Gladys itself: an event here could loop through a scene.
      return;
    }
    const preset = controller.presets.find(({ id }) => id === after);
    this.track(
      this.gladys.publishSceneEvent(PRESET_TRIGGER, {
        device: deviceIds(this.gladys, controller).device,
        preset: preset?.name ?? `Preset ${after}`,
        preset_id: after,
      }),
    );
  }

  // --- Commands ----------------------------------------------------------------

  /** Send a state change, then publish the state WLED answers with. */
  async send(controller, change) {
    if (change.ps !== undefined) {
      controller.ownPreset = { id: change.ps, at: this.now() };
    }
    let state;
    try {
      state = await controller.client.setState(change);
    } catch (err) {
      if (err.unreachable) {
        await this.reachabilityChanged(controller, false);
      }
      throw err;
    }
    await this.reachabilityChanged(controller, true);
    // `v: true` makes WLED answer with its full new state; an old build may
    // not, the WebSocket push or the next poll brings it then.
    await this.applyDocument(controller, { state: state ?? undefined });
  }

  /** A Gladys command on a feature of one of the devices. */
  async setValue(device, feature, value) {
    const resolved = this.resolveDevice(device?.external_id);
    if (!resolved) {
      throw new Error(`Unknown WLED device ${device?.external_id}`);
    }
    const { controller, segmentId } = resolved;
    const prefix = `${device.external_id}:`;
    const key = feature?.external_id?.startsWith(prefix)
      ? feature.external_id.slice(prefix.length)
      : null;
    if (!controller.state) {
      throw new Error(`${controllerName(controller)} has not answered yet`);
    }
    const change = commandFor(controller, segmentId, key, value);
    if (change === null) {
      // "None" in the preset list: nothing to apply, show the real state back.
      if (key === FEATURE_KEYS.PRESET) {
        this.published.delete(feature.external_id);
      }
      await this.publishStates(controller);
      return;
    }
    await this.send(controller, change);
  }

  /** Gladys poll (not scheduled, devices have should_poll: false). */
  async poll(device) {
    const resolved = this.resolveDevice(device?.external_id);
    if (resolved) {
      await this.refresh(resolved.controller);
    }
  }

  /**
   * Apply a preset or playlist given by number or by name.
   * @returns {object} the preset applied
   */
  async applyPreset(deviceExternalId, reference) {
    const { controller } = this.require(deviceExternalId);
    const preset = findByReference(controller.presets, reference);
    if (!preset) {
      throw new Error(`No preset "${reference}" on ${controllerName(controller)}`);
    }
    await this.send(controller, { ps: preset.id });
    return preset;
  }

  /**
   * Start an effect (by number or name) on the device's segments, turning the
   * light on; palette, speed and intensity (0-100) optional.
   */
  async startEffect(deviceExternalId, { effect, palette, speed, intensity }) {
    const { controller, segmentId } = this.require(deviceExternalId);
    const found = findByReference(controller.effects, effect);
    if (!found) {
      throw new Error(`No effect "${effect}" on ${controllerName(controller)}`);
    }
    const fields = { fx: found.id };
    if (isGiven(palette)) {
      const foundPalette = findByReference(controller.palettes, palette);
      if (!foundPalette) {
        throw new Error(`No palette "${palette}" on ${controllerName(controller)}`);
      }
      fields.pal = foundPalette.id;
    }
    if (isGiven(speed) && Number.isFinite(Number(speed))) {
      fields.sx = fromPercent(speed);
    }
    if (isGiven(intensity) && Number.isFinite(Number(intensity))) {
      fields.ix = fromPercent(intensity);
    }
    const ids = segmentId === null ? targetSegmentIds(controller.state) : [segmentId];
    if (segmentId !== null) {
      fields.on = true;
    }
    await this.send(controller, { on: true, seg: ids.map((id) => ({ id, ...fields })) });
    return found;
  }

  require(deviceExternalId) {
    const resolved = this.resolveDevice(deviceExternalId);
    if (!resolved) {
      throw new Error(`Unknown WLED device ${deviceExternalId}`);
    }
    if (!resolved.controller.state) {
      throw new Error(`${controllerName(resolved.controller)} has not answered yet`);
    }
    return resolved;
  }

  /** What the Configuration screen's "Search" action reports. */
  summary() {
    return {
      mdns: this.lastScan.mdns,
      mdnsCount: this.lastScan.mdnsCount ?? 0,
      invalidHosts: this.config.invalidHosts,
      controllers: [...this.controllers.values()]
        .filter((controller) => controller.info)
        .map((controller) => ({
          name: controllerName(controller),
          host: controller.host,
          version: controller.info.version,
          reachable: controller.reachable,
          live: Boolean(controller.socket?.connected),
          websocket: controller.info.websocket,
        })),
    };
  }
}

const isGiven = (value) => value !== undefined && value !== null && String(value).trim() !== '';

/** Identity of the segment layout: ids and names. */
function segmentKey(state) {
  return activeSegments(state)
    .map(({ segment }) => `${segment.id}:${segment.n ?? ''}`)
    .join('|');
}

/** An entry of a `[{ id, name }]` list by number or by name (any case). */
export function findByReference(list, reference) {
  if (reference === undefined || reference === null) {
    return null;
  }
  const text = String(reference).trim();
  if (text === '' || text === NO_PRESET) {
    return null;
  }
  if (/^\d+$/.test(text)) {
    const byId = list.find(({ id }) => id === Number(text));
    if (byId) {
      return byId;
    }
  }
  const lower = text.toLowerCase();
  return list.find(({ name }) => name.toLowerCase() === lower) ?? null;
}
