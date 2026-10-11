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

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// The pieces of the "Search" report, one table per language.
export const SEARCH_TEXT = {
  en: {
    none: 'No WLED controller found.',
    count: (total, reachable) => `${total} controller(s), ${reachable} answering:`,
    live: 'live',
    polled: 'polled',
    unreachable: 'unreachable',
    noMdns: 'Automatic discovery (mDNS) through Gladys is unavailable: enter the IP addresses.',
    ignored: (list) => `Ignored addresses: ${list}.`,
  },
  fr: {
    none: 'Aucun contrôleur WLED trouvé.',
    count: (total, reachable) => `${total} contrôleur(s), ${reachable} répondent :`,
    live: 'en direct',
    polled: 'interrogé',
    unreachable: 'injoignable',
    noMdns:
      'La découverte automatique (mDNS) par Gladys est indisponible : saisissez les adresses IP.',
    ignored: (list) => `Adresses ignorées : ${list}.`,
  },
  de: {
    none: 'Kein WLED-Controller gefunden.',
    count: (total, reachable) => `${total} Controller, davon ${reachable} erreichbar:`,
    live: 'live',
    polled: 'abgefragt',
    unreachable: 'nicht erreichbar',
    noMdns:
      'Die automatische Erkennung (mDNS) über Gladys ist nicht verfügbar: Gib die IP-Adressen ein.',
    ignored: (list) => `Ignorierte Adressen: ${list}.`,
  },
  es: {
    none: 'No se ha encontrado ningún controlador WLED.',
    count: (total, reachable) => `${total} controlador(es), ${reachable} responden:`,
    live: 'en directo',
    polled: 'consultado',
    unreachable: 'inaccesible',
    noMdns:
      'El descubrimiento automático (mDNS) a través de Gladys no está disponible: introduzca las direcciones IP.',
    ignored: (list) => `Direcciones ignoradas: ${list}.`,
  },
};

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
      await gladys.setConnectionStatus(false, INIT_FAILED).catch(() => {});
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

/** The report shown under the "Search" button, in every language. */
export function searchMessage(summary) {
  return Object.fromEntries(
    Object.entries(SEARCH_TEXT).map(([language, text]) => [language, searchReport(summary, text)]),
  );
}

function searchReport({ controllers, mdns, invalidHosts }, text) {
  const lines = [];
  if (controllers.length === 0) {
    lines.push(text.none);
  } else {
    const reachable = controllers.filter((controller) => controller.reachable).length;
    lines.push(text.count(controllers.length, reachable));
    const list = controllers.map(
      ({ name, host, version, reachable: up, live }) =>
        `${name} (${host}, ${version}, ${up ? (live ? text.live : text.polled) : text.unreachable})`,
    );
    lines.push(`${list.join(', ')}.`);
  }
  if (mdns === 'unavailable') {
    lines.push(text.noMdns);
  }
  if (invalidHosts.length > 0) {
    lines.push(text.ignored(invalidHosts.slice(0, 3).join(', ')));
  }
  return lines.join(' ');
}
