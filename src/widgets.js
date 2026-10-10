// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `wled`.
//
// The Gladys device box already has the switch, the brightness, the colour and
// the effect, palette and preset lists. What the widget adds: the presets the
// user marked as favourites in WLED (a quick-load label) as one-tap buttons,
// what the strip is showing at a glance, and an effect picker behind a tap.
//
// Budget (8 components, 2 texts, 1 status, 4 buttons): a caption, the live
// brightness tile, one status list and up to four buttons. The active preset
// is marked by its icon (`check-circle`), never by the button style: `primary`
// is invisible in dark mode.
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
import { WIDGET_KEY } from './hub.js';
import { activePresetId, findSegment, mainSegmentId } from './wled/model.js';

const ACTIVE_ICON = 'check-circle';
const MAX_PRESET_BUTTONS = 3;
const PRESET_ACTION_PREFIX = 'preset_';
const EFFECT_ACTION = 'effect';

const TEXT = {
  pick: {
    en: 'Choose a WLED device in the settings of this widget.',
    fr: 'Choisissez un appareil WLED dans les réglages de ce widget.',
  },
  unknown: {
    en: 'This WLED device is not known yet: run a search in the integration.',
    fr: 'Cet appareil WLED est inconnu : lancez une recherche dans l’intégration.',
  },
  brightness: { en: 'Brightness', fr: 'Luminosité' },
  effect: { en: 'Effect', fr: 'Effet' },
  palette: { en: 'Palette', fr: 'Palette' },
  preset: { en: 'Preset', fr: 'Préréglage' },
  power: { en: 'Light', fr: 'Éclairage' },
  on: { en: 'On', fr: 'Allumé' },
  off: { en: 'Off', fr: 'Éteint' },
  none: { en: 'None', fr: 'Aucun' },
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  live: { en: 'live data', fr: 'flux en direct' },
  leds: { en: 'LEDs', fr: 'LED' },
  presetApplied: { en: 'Preset applied: ', fr: 'Préréglage appliqué : ' },
  effectStarted: { en: 'Effect started: ', fr: 'Effet lancé : ' },
  updateGladys: {
    en: 'Update Gladys to pick an effect from the widget.',
    fr: 'Mettez Gladys à jour pour choisir un effet depuis le widget.',
  },
};

const t = (text, language) => text[language] ?? text.en;
const prefixed = (text, suffix) => ({ en: `${text.en}${suffix}`, fr: `${text.fr}${suffix}` });

/**
 * The presets offered as buttons: those with a quick-load label in WLED
 * (the user's favourites), else the first ones.
 */
export function favoritePresets(controller) {
  const presets = controller.presets ?? [];
  const favorites = presets.filter((preset) => preset.quickLabel);
  return (favorites.length > 0 ? favorites : presets).slice(0, MAX_PRESET_BUTTONS);
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

  const buttons = [];
  if (onController) {
    favoritePresets(controller).forEach((preset, index) => {
      buttons.push({
        type: 'button',
        label: fitButton(preset.name),
        icon: preset.id === active ? ACTIVE_ICON : 'bookmark',
        style: 'secondary',
        // Numbered keys: the core drops a button whose action key is taken.
        action: { key: `${PRESET_ACTION_PREFIX}${index + 1}`, params: { preset: preset.id } },
      });
    });
  }
  if (controller.effects.length > 0) {
    const current = segment && Number.isInteger(segment.fx) ? String(segment.fx) : undefined;
    const options = controller.effects.map(({ id, name }) => ({
      value: String(id),
      label: { en: name },
    }));
    buttons.push({
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
    });
  }
  return { ttl_seconds: 60, components: [...components, ...buttons.slice(0, 4)] };
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
