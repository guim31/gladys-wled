// -----------------------------------------------------------------------------
// From a WLED controller to Gladys devices, and back: discovery payloads, state
// values, and the WLED state change of each command.
//
// One device per controller. It drives the segments selected in WLED, exactly
// like the WLED interface: on a single-segment strip, the whole strip. With the
// `segment_devices` option, every segment also gets its own device (the
// Gladys light panel binds one brightness per device, so a segment cannot be a
// second set of features on the controller device).
//
// Feature keys are part of the external ids: permanent.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import {
  KELVIN_MAX,
  KELVIN_MIN,
  activePresetId,
  activeSegments,
  cctToKelvin,
  findSegment,
  fromPercent,
  intToRgb,
  kelvinToCct,
  mainSegmentId,
  primaryColor,
  rgbToInt,
  segmentCapabilities,
  targetSegmentIds,
  toPercent,
} from './wled/model.js';

export const DEVICE_TYPES = { CONTROLLER: 'controller', SEGMENT: 'segment' };

export const FEATURE_KEYS = {
  POWER: 'power',
  BRIGHTNESS: 'brightness',
  COLOR: 'color',
  COLOR_TEMPERATURE: 'color-temperature',
  WHITE: 'white',
  EFFECT: 'effect',
  PALETTE: 'palette',
  EFFECT_SPEED: 'effect-speed',
  EFFECT_INTENSITY: 'effect-intensity',
  PRESET: 'preset',
  NIGHTLIGHT: 'nightlight',
  SYNC: 'sync',
};

// Value of the preset select when no preset is active (the state was changed
// by hand): Gladys ignores an empty text state.
export const NO_PRESET = 'none';

// Feature names are frozen when the user creates the device: written in the
// language chosen in the configuration at that moment.
export const NAMES = {
  en: {
    power: 'Light',
    brightness: 'Brightness',
    color: 'Color',
    'color-temperature': 'Color temperature',
    white: 'White channel',
    effect: 'Effect',
    palette: 'Palette',
    'effect-speed': 'Effect speed',
    'effect-intensity': 'Effect intensity',
    preset: 'Preset',
    nightlight: 'Nightlight',
    sync: 'UDP sync',
    noPreset: 'None',
    segment: 'Segment',
  },
  fr: {
    power: 'Éclairage',
    brightness: 'Luminosité',
    color: 'Couleur',
    'color-temperature': 'Température de couleur',
    white: 'Canal blanc',
    effect: 'Effet',
    palette: 'Palette',
    'effect-speed': "Vitesse de l'effet",
    'effect-intensity': "Intensité de l'effet",
    preset: 'Préréglage',
    nightlight: 'Veilleuse',
    sync: 'Synchro UDP',
    noPreset: 'Aucun',
    segment: 'Segment',
  },
  de: {
    power: 'Licht',
    brightness: 'Helligkeit',
    color: 'Farbe',
    'color-temperature': 'Farbtemperatur',
    white: 'Weißkanal',
    effect: 'Effekt',
    palette: 'Palette',
    'effect-speed': 'Effektgeschwindigkeit',
    'effect-intensity': 'Effektintensität',
    preset: 'Preset',
    nightlight: 'Nachtlicht',
    sync: 'UDP-Sync',
    noPreset: 'Keines',
    segment: 'Segment',
  },
  es: {
    power: 'Luz',
    brightness: 'Brillo',
    color: 'Color',
    'color-temperature': 'Temperatura de color',
    white: 'Canal blanco',
    effect: 'Efecto',
    palette: 'Paleta',
    'effect-speed': 'Velocidad del efecto',
    'effect-intensity': 'Intensidad del efecto',
    preset: 'Preajuste',
    nightlight: 'Luz nocturna',
    sync: 'Sincronización UDP',
    noPreset: 'Ninguno',
    segment: 'Segmento',
  },
};

export const namesFor = (language) => NAMES[language] ?? NAMES.en;

const binary = (key, names, category, type) => ({
  key,
  name: names[key],
  category,
  type,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: true,
});

// A 0-100 slider. `switch/dimmer` is the slider the Gladys dashboard can
// drive: `light/effect-speed` would only be displayed. No unit: the core lists
// none for the switch category.
const level = (key, names) => ({
  key,
  name: names[key],
  category: CATEGORIES.SWITCH,
  type: TYPES.SWITCH.DIMMER,
  min: 0,
  max: 100,
  read_only: false,
  has_feedback: true,
});

// A list read on the controller (effects, palettes, presets): a dynamic
// select, its options refreshed on every publication.
const select = (key, names, options) => ({
  key,
  name: names[key],
  category: CATEGORIES.TEXT,
  type: TYPES.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  supported_options: options.map((option, index) => ({ ...option, sort_order: index })),
});

// Solid (0) and Default (0) first, like the WLED interface, then by name.
function sortedOptions(entries) {
  const [first, ...others] = [...entries].sort((a, b) => a.id - b.id);
  const rest = others.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return (first ? [first, ...rest] : rest).map(({ id, name }) => ({
    value: String(id),
    label: name,
  }));
}

export const effectOptions = (controller) => sortedOptions(controller.effects ?? []);
export const paletteOptions = (controller) => sortedOptions(controller.palettes ?? []);

export function presetOptions(controller, language) {
  return [
    { value: NO_PRESET, label: namesFor(language).noPreset },
    ...(controller.presets ?? []).map(({ id, name }) => ({ value: String(id), label: name })),
  ];
}

/**
 * The light features shared by the controller and segment devices.
 * @param {{ rgb: boolean, white: boolean, cct: boolean }} capabilities
 */
function lightSpecs(controller, capabilities, names) {
  const specs = [
    binary(FEATURE_KEYS.POWER, names, CATEGORIES.LIGHT, TYPES.LIGHT.BINARY),
    {
      key: FEATURE_KEYS.BRIGHTNESS,
      name: names.brightness,
      category: CATEGORIES.LIGHT,
      type: TYPES.LIGHT.BRIGHTNESS,
      unit: UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: false,
      has_feedback: true,
    },
  ];
  if (capabilities.rgb) {
    specs.push({
      key: FEATURE_KEYS.COLOR,
      name: names.color,
      category: CATEGORIES.LIGHT,
      type: TYPES.LIGHT.COLOR,
      min: 0,
      max: 0xffffff,
      read_only: false,
      has_feedback: true,
    });
  }
  if (capabilities.cct) {
    // In kelvins: the Gladys slider reads the `kelvin` unit as a physical
    // scale (warm on the left).
    specs.push({
      key: FEATURE_KEYS.COLOR_TEMPERATURE,
      name: names['color-temperature'],
      category: CATEGORIES.LIGHT,
      type: TYPES.LIGHT.TEMPERATURE,
      unit: UNITS.KELVIN,
      min: KELVIN_MIN,
      max: KELVIN_MAX,
      read_only: false,
      has_feedback: true,
    });
  }
  if (capabilities.white) {
    specs.push(level(FEATURE_KEYS.WHITE, names));
  }
  specs.push(select(FEATURE_KEYS.EFFECT, names, effectOptions(controller)));
  if (capabilities.rgb) {
    specs.push(select(FEATURE_KEYS.PALETTE, names, paletteOptions(controller)));
  }
  specs.push(level(FEATURE_KEYS.EFFECT_SPEED, names), level(FEATURE_KEYS.EFFECT_INTENSITY, names));
  return specs;
}

/** Feature specs of the controller device. */
export function controllerSpecs(controller, language) {
  const names = namesFor(language);
  return [
    ...lightSpecs(controller, controller.info.capabilities, names),
    select(FEATURE_KEYS.PRESET, names, presetOptions(controller, language)),
    binary(FEATURE_KEYS.NIGHTLIGHT, names, CATEGORIES.SWITCH, TYPES.SWITCH.BINARY),
    binary(FEATURE_KEYS.SYNC, names, CATEGORIES.SWITCH, TYPES.SWITCH.BINARY),
  ];
}

/** Feature specs of a segment device. */
export function segmentSpecs(controller, segmentId, language) {
  const found = findSegment(controller.state, segmentId);
  const capabilities = found
    ? segmentCapabilities(controller.rawInfo, found.segment, found.index)
    : controller.info.capabilities;
  return lightSpecs(controller, capabilities, namesFor(language));
}

/** Default device name: the one set in WLED, made unique when left at "WLED". */
export function controllerName(controller) {
  const name = controller.info.name;
  return name === 'WLED' ? `WLED ${controller.mac.slice(-6).toUpperCase()}` : name;
}

export function segmentName(controller, segmentId, language) {
  const found = findSegment(controller.state, segmentId);
  const label =
    typeof found?.segment.n === 'string' && found.segment.n.trim()
      ? found.segment.n.trim()
      : `${namesFor(language).segment} ${segmentId}`;
  return `${controllerName(controller)} – ${label}`;
}

const toFeature = (ids) => (spec) => {
  const feature = {
    name: spec.name,
    external_id: ids.feature(spec.key),
    category: spec.category,
    type: spec.type,
    min: spec.min,
    max: spec.max,
    read_only: spec.read_only,
    has_feedback: spec.has_feedback,
    // Lists and levels have no useful history; on, brightness and colours do.
    keep_history: spec.category === CATEGORIES.LIGHT,
  };
  if (spec.unit) {
    feature.unit = spec.unit;
  }
  if (spec.supported_options) {
    feature.supported_options = spec.supported_options;
  }
  return feature;
};

/** External ids of a controller or segment device. */
export function deviceIds(gladys, controller, segmentId = null) {
  return segmentId === null
    ? gladys.externalIds(DEVICE_TYPES.CONTROLLER, controller.mac)
    : gladys.externalIds(DEVICE_TYPES.SEGMENT, `${controller.mac}-${segmentId}`);
}

function params(controller) {
  return [
    { name: 'IP_ADDRESS', value: controller.host },
    { name: 'WLED_MAC', value: controller.mac },
  ];
}

/** Discovery payload of the controller device. */
export function buildControllerDevice(gladys, controller, language) {
  const ids = deviceIds(gladys, controller);
  return {
    name: controllerName(controller),
    external_id: ids.device,
    model: 'WLED',
    // States are pushed over the controller's WebSocket (with a fallback poll
    // run by the integration itself): Gladys does not poll these devices.
    should_poll: false,
    params: params(controller),
    features: controllerSpecs(controller, language).map(toFeature(ids)),
  };
}

/** Discovery payload of a segment device. */
export function buildSegmentDevice(gladys, controller, segmentId, language) {
  const ids = deviceIds(gladys, controller, segmentId);
  return {
    name: segmentName(controller, segmentId, language),
    external_id: ids.device,
    model: 'WLED segment',
    should_poll: false,
    params: [...params(controller), { name: 'WLED_SEGMENT', value: String(segmentId) }],
    features: segmentSpecs(controller, segmentId, language).map(toFeature(ids)),
  };
}

/**
 * The segments published as their own device: all of them when the option
 * asks and the controller has several (a single segment is the controller
 * device itself).
 */
export function segmentDeviceIds(controller, segmentDevices) {
  const segments = activeSegments(controller.state);
  return segmentDevices === 'all' && segments.length > 1
    ? segments.map(({ segment }) => segment.id)
    : [];
}

/** Every device of a controller, segments included when the option asks. */
export function buildDevices(gladys, controller, { language, segmentDevices }) {
  return [
    buildControllerDevice(gladys, controller, language),
    ...segmentDeviceIds(controller, segmentDevices).map((id) =>
      buildSegmentDevice(gladys, controller, id, language),
    ),
  ];
}

function lightValues(state, segment, power, brightness) {
  const values = {
    [FEATURE_KEYS.POWER]: power ? 1 : 0,
  };
  if (Number.isFinite(brightness)) {
    values[FEATURE_KEYS.BRIGHTNESS] = toPercent(brightness);
  }
  if (!segment) {
    return values;
  }
  const color = primaryColor(segment);
  if (color) {
    // Pure white on the white channel ([0, 0, 0, W]) is white, not black.
    const whiteOnly = color[0] === 0 && color[1] === 0 && color[2] === 0 && color[3] > 0;
    values[FEATURE_KEYS.COLOR] = whiteOnly ? 0xffffff : rgbToInt(color);
    values[FEATURE_KEYS.WHITE] = toPercent(color[3]);
  }
  const kelvin = cctToKelvin(segment.cct);
  if (kelvin !== null) {
    values[FEATURE_KEYS.COLOR_TEMPERATURE] = kelvin;
  }
  if (Number.isInteger(segment.fx)) {
    values[FEATURE_KEYS.EFFECT] = { text: String(segment.fx) };
  }
  if (Number.isInteger(segment.pal)) {
    values[FEATURE_KEYS.PALETTE] = { text: String(segment.pal) };
  }
  if (Number.isFinite(segment.sx)) {
    values[FEATURE_KEYS.EFFECT_SPEED] = toPercent(segment.sx);
  }
  if (Number.isFinite(segment.ix)) {
    values[FEATURE_KEYS.EFFECT_INTENSITY] = toPercent(segment.ix);
  }
  return values;
}

/** Feature values of the controller device, by feature key. */
export function controllerValues(controller) {
  const { state } = controller;
  const segment = findSegment(state, mainSegmentId(state))?.segment ?? null;
  const values = lightValues(state, segment, state.on === true, state.bri);
  const preset = activePresetId(state);
  values[FEATURE_KEYS.PRESET] = { text: preset > 0 ? String(preset) : NO_PRESET };
  if (state.nl && typeof state.nl === 'object') {
    values[FEATURE_KEYS.NIGHTLIGHT] = state.nl.on ? 1 : 0;
  }
  if (state.udpn && typeof state.udpn === 'object') {
    values[FEATURE_KEYS.SYNC] = state.udpn.send ? 1 : 0;
  }
  return values;
}

/**
 * Feature values of a segment device. Its light shows only when both the
 * segment and the controller are on.
 */
export function segmentValues(controller, segmentId) {
  const { state } = controller;
  const segment = findSegment(state, segmentId)?.segment;
  if (!segment) {
    return {};
  }
  return lightValues(state, segment, state.on === true && segment.on !== false, segment.bri);
}

const segmentsChange = (ids, fields) => ({ seg: ids.map((id) => ({ id, ...fields })) });

const toInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
};

/**
 * The WLED state change of a Gladys command, or null when there is nothing to
 * send (choosing "None" in the preset list).
 * @param {object} controller the controller record (state, lists, info)
 * @param {number|null} segmentId null for the controller device
 * @param {string} key feature key
 * @param {number|string} value
 */
export function commandFor(controller, segmentId, key, value) {
  const { state } = controller;
  const onController = segmentId === null;
  const ids = onController ? targetSegmentIds(state) : [segmentId];
  const number = Number(value);
  const capabilities = onController
    ? controller.info.capabilities
    : (() => {
        const found = findSegment(state, segmentId);
        return found
          ? segmentCapabilities(controller.rawInfo, found.segment, found.index)
          : controller.info.capabilities;
      })();

  switch (key) {
    case FEATURE_KEYS.POWER:
      if (onController) {
        return { on: number > 0 };
      }
      // A segment lights only when the controller is on too.
      return number > 0
        ? { on: true, ...segmentsChange(ids, { on: true }) }
        : segmentsChange(ids, { on: false });

    case FEATURE_KEYS.BRIGHTNESS: {
      if (!(number > 0)) {
        return onController ? { on: false } : segmentsChange(ids, { on: false });
      }
      const bri = Math.max(1, fromPercent(number));
      return onController
        ? { on: true, bri }
        : { on: true, ...segmentsChange(ids, { on: true, bri }) };
    }

    case FEATURE_KEYS.COLOR: {
      // WLED sets the channels left out to 0: on a strip with a white
      // channel, send each segment's current white along. Picking a colour
      // also lights a strip that is off, like the other Gladys lights.
      const [r, g, b] = intToRgb(number);
      const seg = ids.map((id) => {
        if (!capabilities.white) {
          return { id, col: [[r, g, b]] };
        }
        const w = primaryColor(findSegment(state, id)?.segment)?.[3] ?? 0;
        return { id, col: [[r, g, b, w]] };
      });
      return onController
        ? { on: true, seg }
        : { on: true, seg: seg.map((entry) => ({ ...entry, on: true })) };
    }

    case FEATURE_KEYS.COLOR_TEMPERATURE: {
      // Like Home Assistant: a colour temperature is shown as full white, on
      // the white channel when there is one.
      const fields = { cct: kelvinToCct(number) };
      if (capabilities.white) {
        fields.col = [[0, 0, 0, 255]];
      } else if (capabilities.rgb) {
        fields.col = [[255, 255, 255]];
      }
      return segmentsChange(ids, fields);
    }

    case FEATURE_KEYS.WHITE: {
      const segment = findSegment(state, onController ? mainSegmentId(state) : segmentId)?.segment;
      const [r, g, b] = primaryColor(segment) ?? [0, 0, 0];
      return segmentsChange(ids, { col: [[r, g, b, fromPercent(number)]] });
    }

    case FEATURE_KEYS.EFFECT: {
      const effect = toInteger(value);
      if (effect === null || !(controller.effects ?? []).some(({ id }) => id === effect)) {
        throw new Error(`Unknown effect "${value}"`);
      }
      return segmentsChange(ids, { fx: effect });
    }

    case FEATURE_KEYS.PALETTE: {
      const palette = toInteger(value);
      if (palette === null || !(controller.palettes ?? []).some(({ id }) => id === palette)) {
        throw new Error(`Unknown palette "${value}"`);
      }
      return segmentsChange(ids, { pal: palette });
    }

    case FEATURE_KEYS.EFFECT_SPEED:
      return segmentsChange(ids, { sx: fromPercent(number) });

    case FEATURE_KEYS.EFFECT_INTENSITY:
      return segmentsChange(ids, { ix: fromPercent(number) });

    case FEATURE_KEYS.PRESET: {
      if (value === NO_PRESET) {
        return null;
      }
      const preset = toInteger(value);
      if (preset === null || !(controller.presets ?? []).some(({ id }) => id === preset)) {
        throw new Error(`Unknown preset "${value}"`);
      }
      return { ps: preset };
    }

    case FEATURE_KEYS.NIGHTLIGHT:
      return { nl: { on: number > 0 } };

    case FEATURE_KEYS.SYNC:
      return { udpn: { send: number > 0 } };

    default:
      throw new Error(`Unknown feature "${key}"`);
  }
}
