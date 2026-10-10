// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or a test double) and
// returns the hub, so index.js stays a few lines and the tests drive the very
// same wiring.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { WledHub } from './hub.js';
import { SCENE_ACTIONS } from './scenes.js';
import { Store } from './store.js';
import { WIDGETS } from './widgets.js';

const logger = createLogger({ name: 'wled-app' });

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: store, fetch, createSocket, timers, timings, socketTimings
 */
export function registerHandlers(gladys, options = {}) {
  const hub = new WledHub({
    gladys,
    store: options.store ?? new Store(),
    fetch: options.fetch,
    createSocket: options.createSocket,
    timers: options.timers ?? true,
    timings: options.timings,
    socketTimings: options.socketTimings,
    now: options.now,
  });

  // Resolved once the hub has started; every handler waits for it, so a
  // command arriving during the first scan is not lost.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      return fn(...args);
    };

  gladys.on('connected', async () => {
    try {
      const config = normalizeConfig(await gladys.getConfig());
      if (started) {
        // A reconnection (Gladys restarted): re-sync what Gladys may have lost.
        await hub.resync(config);
        return;
      }
      started = true;
      await hub.start(config);
    } catch (err) {
      logger.error('Initialization failed', err);
      await gladys
        .setConnectionStatus(false, {
          en: 'Initialization failed, check the integration logs.',
          fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
        })
        .catch(() => {});
    } finally {
      resolveReady();
    }
  });

  gladys.onScanRequest(whenReady(() => hub.rediscover()));

  gladys.onSetValue(whenReady((device, feature, value) => hub.setValue(device, feature, value)));

  // The devices are published with should_poll: false (pushed over the
  // WebSocket); this only serves a Gladys that would poll anyway.
  gladys.onPoll(whenReady((device) => hub.poll(device)));

  gladys.onDeviceCreated(whenReady((device) => hub.onDeviceCreated(device)));

  gladys.onConfigUpdated(
    whenReady(async (newConfig) => {
      await hub.reconfigure(normalizeConfig(newConfig));
    }),
  );

  gladys.onAction(
    'search',
    whenReady(async () => {
      await hub.rediscover();
      return searchMessage(hub.summary());
    }),
  );

  for (const [key, handler] of Object.entries(SCENE_ACTIONS)) {
    gladys.onSceneAction(
      key,
      whenReady((fields) => handler(hub, { fields })),
    );
  }

  for (const [key, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(
      key,
      whenReady((request) => widget.get(hub, request)),
    );
    gladys.onWidgetAction(
      key,
      whenReady((actionKey, params, context = {}) =>
        widget.action(hub, { actionKey, params, ...context }),
      ),
    );
  }

  return {
    hub,
    ready,
    stop: () => hub.stop(),
  };
}

/** The bilingual report shown under the "Search" button. */
export function searchMessage(summary) {
  const { controllers, mdns, invalidHosts } = summary;
  const en = [];
  const fr = [];
  if (controllers.length === 0) {
    en.push('No WLED controller found.');
    fr.push('Aucun contrôleur WLED trouvé.');
  } else {
    const reachable = controllers.filter((controller) => controller.reachable).length;
    en.push(`${controllers.length} controller(s), ${reachable} answering:`);
    fr.push(`${controllers.length} contrôleur(s), ${reachable} répondent :`);
    const list = controllers.map(({ name, host, version, reachable: up, live }) => ({
      en: `${name} (${host}, ${version}, ${up ? (live ? 'live' : 'polled') : 'unreachable'})`,
      fr: `${name} (${host}, ${version}, ${up ? (live ? 'en direct' : 'interrogé') : 'injoignable'})`,
    }));
    en.push(`${list.map((entry) => entry.en).join(', ')}.`);
    fr.push(`${list.map((entry) => entry.fr).join(', ')}.`);
  }
  if (mdns === 'unavailable') {
    en.push('Automatic discovery (mDNS) through Gladys is unavailable: enter the IP addresses.');
    fr.push(
      'La découverte automatique (mDNS) par Gladys est indisponible : saisissez les adresses IP.',
    );
  }
  if (invalidHosts.length > 0) {
    const list = invalidHosts.slice(0, 3).join(', ');
    en.push(`Ignored addresses: ${list}.`);
    fr.push(`Adresses ignorées : ${list}.`);
  }
  return { en: en.join(' '), fr: fr.join(' ') };
}
