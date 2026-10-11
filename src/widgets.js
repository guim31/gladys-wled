// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `wled`.
//
// The Gladys device box already has the switch, the brightness, the colour and
// the effect, palette and preset lists. What the widget adds: the presets the
// user marked as favourites in WLED (a quick-load label) as one-tap buttons,
// what the strip is showing at a glance, and one-tap buttons for the effects
// chosen in the widget settings.
//
// No button opens a form: forms on widget buttons (GladysAssistant/Gladys#3168)
// are in no published Gladys yet (5.1.4 drops the fields and relays the tap
// without values). The former effect picker stays behind WIDGET_FORMS.
//
// Budget (8 components, 2 texts, 1 status, 4 buttons): a caption, the live
// brightness tile, one status list and up to four buttons. The active preset
// or effect is marked by its icon (`check-circle`), never by the button style:
// `primary` is invisible in dark mode.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import {
  FEATURE_KEYS,
  controllerName,
  controllerSpecs,
  deviceIds,
  segmentName,
  segmentSpecs,
} from './devices.js';
import { WIDGET_KEY, findByReference } from './hub.js';
import { activePresetId, findSegment, mainSegmentId } from './wled/model.js';

const ACTIVE_ICON = 'check-circle';
const MAX_BUTTONS = 4;
const MAX_PRESET_BUTTONS = 3;
const PRESET_ACTION_PREFIX = 'preset_';
const EFFECT_BUTTON_PREFIX = 'effect_';
// Published key of the former effect picker (a button opening a form).
const EFFECT_ACTION = 'effect';

// Forms on widget buttons need a Gladys newer than 5.1.4: off until one ships.
export const WIDGET_FORMS = false;

// Effects offered in the widget settings (a static list: the settings form
// cannot read the controller). Long-standing WLED effects, matched by name on
// each controller; one missing on an old build is simply not shown. The
// option values are stored in the dashboards: permanent.
export const EFFECT_CHOICES = [
  'Solid',
  'Rainbow',
  'Colorloop',
  'Breathe',
  'Candle',
  'Fire 2012',
  'Twinkle',
  'Aurora',
  'Fireworks',
  'Meteor',
  'Pacifica',
  'Lake',
];
// What a widget shows before its settings are touched: back to a plain
// colour, and the classic animation.
export const DEFAULT_WIDGET_EFFECTS = ['Solid', 'Rainbow'];

export const TEXT = {
  pick: {
    en: 'Choose a WLED device in the settings of this widget.',
    fr: 'Choisissez un appareil WLED dans les réglages de ce widget.',
    de: 'Wähle in den Einstellungen dieses Widgets ein WLED-Gerät aus.',
    es: 'Elija un dispositivo WLED en la configuración de este widget.',
  },
  unknown: {
    en: 'This WLED device is not known yet: run a search in the integration.',
    fr: 'Cet appareil WLED est inconnu : lancez une recherche dans l’intégration.',
    de: 'Dieses WLED-Gerät ist noch unbekannt: Starte eine Suche in der Integration.',
    es: 'Este dispositivo WLED aún no es conocido: inicie una búsqueda en la integración.',
  },
  brightness: { en: 'Brightness', fr: 'Luminosité', de: 'Helligkeit', es: 'Brillo' },
  effect: { en: 'Effect', fr: 'Effet', de: 'Effekt', es: 'Efecto' },
  palette: { en: 'Palette', fr: 'Palette', de: 'Palette', es: 'Paleta' },
  preset: { en: 'Preset', fr: 'Préréglage', de: 'Preset', es: 'Preajuste' },
  power: { en: 'Light', fr: 'Éclairage', de: 'Licht', es: 'Luz' },
  on: { en: 'On', fr: 'Allumé', de: 'Ein', es: 'Encendida' },
  off: { en: 'Off', fr: 'Éteint', de: 'Aus', es: 'Apagada' },
  none: { en: 'None', fr: 'Aucun', de: 'Keines', es: 'Ninguno' },
  unreachable: { en: 'unreachable', fr: 'injoignable', de: 'nicht erreichbar', es: 'inaccesible' },
  live: { en: 'live data', fr: 'flux en direct', de: 'Live-Daten', es: 'datos en directo' },
  leds: { en: 'LEDs', fr: 'LED', de: 'LEDs', es: 'LED' },
  presetApplied: {
    en: 'Preset applied: ',
    fr: 'Préréglage appliqué : ',
    de: 'Preset angewendet: ',
    es: 'Preajuste aplicado: ',
  },
  effectStarted: {
    en: 'Effect started: ',
    fr: 'Effet lancé : ',
    de: 'Effekt gestartet: ',
    es: 'Efecto iniciado: ',
  },
  updateGladys: {
    en: 'Update Gladys to pick an effect from the widget.',
    fr: 'Mettez Gladys à jour pour choisir un effet depuis le widget.',
    de: 'Aktualisiere Gladys, um einen Effekt im Widget auszuwählen.',
    es: 'Actualice Gladys para elegir un efecto desde el widget.',
  },
};

const t = (text, language) => text[language] ?? text.en;
const prefixed = (text, suffix) =>
  Object.fromEntries(
    Object.entries(text).map(([language, start]) => [language, `${start}${suffix}`]),
  );

/**
 * The presets offered as buttons: those with a quick-load label in WLED
 * (the user's favourites), else the first ones.
 */
export function favoritePresets(controller) {
  const presets = controller.presets ?? [];
  const favorites = presets.filter((preset) => preset.quickLabel);
  return (favorites.length > 0 ? favorites : presets).slice(0, MAX_PRESET_BUTTONS);
}

/**
 * The effects chosen in the widget settings that the controller has, in
 * order. Settings never saved get the defaults; an empty choice means none.
 */
export function favoriteEffects(controller, settings) {
  const raw = settings?.effects;
  const names = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : DEFAULT_WIDGET_EFFECTS;
  const effects = [];
  for (const name of names) {
    const effect = findByReference(controller.effects ?? [], name);
    if (effect && !effects.includes(effect)) {
      effects.push(effect);
    }
  }
  return effects;
}

/**
 * Share the four buttons: presets first, effects after. Effects keep at least
 * two places when there are presets, and take all four when there are none.
 */
export function splitButtons(presetCount, effectCount) {
  const effects = Math.min(effectCount, presetCount >= 2 ? 2 : MAX_BUTTONS - presetCount);
  return { presets: Math.min(presetCount, MAX_BUTTONS - effects), effects };
}

const nameOf = (list, id) => list.find((entry) => entry.id === id)?.name;

// The core cuts a status value past 40 characters and a button label past 24:
// cut long names cleanly here instead, with an ellipsis.
const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
export const fitStatus = (text) => fit(text, 40);
export const fitButton = (text) => fit(text, 24);

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

async function get(hub, { settings, language = 'en' }) {
  const resolved = settings?.device ? hub.resolveDevice(settings.device) : null;
  if (!resolved?.controller.state) {
    return message(settings?.device ? TEXT.unknown : TEXT.pick, language);
  }
  const { controller, segmentId } = resolved;
  const { state, info } = controller;
  const onController = segmentId === null;
  const segment = findSegment(state, onController ? mainSegmentId(state) : segmentId)?.segment;
  const specs = onController
    ? controllerSpecs(controller, language)
    : segmentSpecs(controller, segmentId, language);
  const has = (key) => specs.some((spec) => spec.key === key);
  const ids = deviceIds(hub.gladys, controller, segmentId);

  const caption = [
    onController ? controllerName(controller) : segmentName(controller, segmentId, language),
    `WLED ${info.version}`,
  ];
  if (info.ledCount > 0) {
    caption.push(`${info.ledCount} ${t(TEXT.leds, language)}`);
  }
  if (!controller.reachable) {
    caption.push(t(TEXT.unreachable, language));
  } else if (info.live) {
    caption.push(t(TEXT.live, language));
  }

  const lit = state.on === true && (onController || segment?.on !== false);
  const items = [
    {
      label: t(TEXT.power, language),
      icon: 'power',
      value: t(lit ? TEXT.on : TEXT.off, language),
      color: lit ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
    },
  ];
  if (segment && Number.isInteger(segment.fx)) {
    items.push({
      label: t(TEXT.effect, language),
      icon: 'play',
      value: fitStatus(nameOf(controller.effects, segment.fx) ?? String(segment.fx)),
      color: WIDGET_COLORS.INFO,
    });
  }
  if (segment && Number.isInteger(segment.pal) && has(FEATURE_KEYS.PALETTE)) {
    items.push({
      label: t(TEXT.palette, language),
      icon: 'droplet',
      value: fitStatus(nameOf(controller.palettes, segment.pal) ?? String(segment.pal)),
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  const active = activePresetId(state);
  if (onController) {
    items.push({
      label: t(TEXT.preset, language),
      icon: 'bookmark',
      value:
        active > 0
          ? fitStatus(nameOf(controller.presets, active) ?? String(active))
          : t(TEXT.none, language),
      color: active > 0 ? WIDGET_COLORS.PRIMARY : WIDGET_COLORS.NEUTRAL,
    });
  }

  const components = [
    { type: 'text', variant: 'caption', text: caption.join(' · ') },
    {
      type: 'value',
      device_feature: ids.feature(FEATURE_KEYS.BRIGHTNESS),
      label: t(TEXT.brightness, language),
      icon: 'sun',
    },
    { type: 'status', items },
  ];

  const presets = onController ? favoritePresets(controller) : [];
  const effects = favoriteEffects(controller, settings);
  const share = splitButtons(presets.length, effects.length);
  const buttons = [];
  presets.slice(0, share.presets).forEach((preset, index) => {
    buttons.push({
      type: 'button',
      label: fitButton(preset.name),
      icon: preset.id === active ? ACTIVE_ICON : 'bookmark',
      style: 'secondary',
      // Numbered keys: the core drops a button whose action key is taken.
      action: { key: `${PRESET_ACTION_PREFIX}${index + 1}`, params: { preset: preset.id } },
    });
  });
  effects.slice(0, share.effects).forEach((effect, index) => {
    buttons.push({
      type: 'button',
      label: fitButton(effect.name),
      icon: lit && segment?.fx === effect.id ? ACTIVE_ICON : 'play',
      style: 'secondary',
      action: { key: `${EFFECT_BUTTON_PREFIX}${index + 1}`, params: { effect: effect.id } },
    });
  });
  if (WIDGET_FORMS && controller.effects.length > 0) {
    buttons.push(effectPicker(controller, segment, language));
  }
  return { ttl_seconds: 60, components: [...components, ...buttons.slice(0, MAX_BUTTONS)] };
}

/** The former effect picker: a button opening a form (Gladys#3168). */
export function effectPicker(controller, segment, language) {
  const current = segment && Number.isInteger(segment.fx) ? String(segment.fx) : undefined;
  const options = controller.effects.map(({ id, name }) => ({
    value: String(id),
    label: { en: name },
  }));
  return {
    type: 'button',
    label: t(TEXT.effect, language),
    icon: 'play',
    style: 'secondary',
    action: {
      key: EFFECT_ACTION,
      fields: [
        {
          key: 'effect',
          type: 'select',
          required: true,
          label: TEXT.effect,
          options,
          ...(options.some((option) => option.value === current) ? { default: current } : {}),
        },
      ],
    },
  };
}

async function action(hub, { actionKey, params = {}, settings, values }) {
  const device = settings?.device;
  if (!device) {
    throw new Error(TEXT.pick.en);
  }
  if (actionKey.startsWith(PRESET_ACTION_PREFIX)) {
    const preset = await hub.applyPreset(device, params.preset);
    return { message: prefixed(TEXT.presetApplied, preset.name) };
  }
  if (actionKey.startsWith(EFFECT_BUTTON_PREFIX)) {
    const effect = await hub.startEffect(device, { effect: params.effect });
    return { message: prefixed(TEXT.effectStarted, effect.name) };
  }
  if (actionKey === EFFECT_ACTION) {
    if (!values || values.effect === undefined) {
      // A core without action fields runs the action without the form.
      throw new Error(TEXT.updateGladys.en);
    }
    const effect = await hub.startEffect(device, { effect: values.effect });
    return { message: prefixed(TEXT.effectStarted, effect.name) };
  }
  throw new Error(`Unknown action ${actionKey}`);
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
