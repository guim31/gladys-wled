// -----------------------------------------------------------------------------
// Reading the WLED JSON API (/json/info, /json/state, /json/eff, /json/pal,
// /presets.json) the same way across firmware versions (0.13 to 16.x).
//
// Every field is read defensively: forks and old builds leave some out, and a
// controller restarting mid-request can send a partial document.
// -----------------------------------------------------------------------------

// Light capability bits of `info.leds.lc`, `info.leds.seglc[]` and, since 16.0,
// `state.seg[].lc` (WLED const.h, SEG_CAPABILITY_*).
const CAPABILITY = { RGB: 1, WHITE: 2, CCT: 4 };

// Colour temperature range shown in Gladys. WLED stores the white balance as
// 0 (warm) to 255 (cold) and does not know the kelvins of the LEDs: this is the
// range Home Assistant uses for WLED, so both show the same values.
export const KELVIN_MIN = 2000;
export const KELVIN_MAX = 6535;

// WLED accepts a `cct` written in kelvins from this value on.
const CCT_KELVIN_THRESHOLD = 1900;

// Placeholder names of the effect slots WLED keeps for removed effects.
const RESERVED_EFFECT_NAMES = new Set(['RSVD', '-', '']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInteger = (value) => Number.isInteger(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Light capabilities of an `lc` bit field. */
export function capabilitiesOf(lc) {
  const bits = isInteger(lc) ? lc : 0;
  return {
    rgb: Boolean(bits & CAPABILITY.RGB),
    white: Boolean(bits & CAPABILITY.WHITE),
    cct: Boolean(bits & CAPABILITY.CCT),
  };
}

/**
 * Light capabilities of the whole controller. Builds older than 0.13 report
 * no `lc`: they only know RGB, with an optional white channel.
 */
export function controllerCapabilities(info) {
  const leds = isObject(info?.leds) ? info.leds : {};
  if (isInteger(leds.lc)) {
    return capabilitiesOf(leds.lc);
  }
  return {
    rgb: true,
    white: Boolean(leds.rgbw) && Boolean(leds.wv ?? true),
    cct: Boolean(leds.cct),
  };
}

/**
 * Light capabilities of the segment at `index` in `state.seg`: its own `lc`
 * (16.0+), else `info.leds.seglc` (same order as `state.seg`), else the
 * controller's.
 */
export function segmentCapabilities(info, segment, index) {
  if (isInteger(segment?.lc)) {
    return capabilitiesOf(segment.lc);
  }
  const seglc = info?.leds?.seglc;
  if (Array.isArray(seglc) && isInteger(seglc[index])) {
    return capabilitiesOf(seglc[index]);
  }
  return controllerCapabilities(info);
}

/** MAC address of the controller, lower case without separators, or null. */
export function macOf(info) {
  const mac = typeof info?.mac === 'string' ? info.mac.toLowerCase().replace(/[^0-9a-f]/g, '') : '';
  return /^[0-9a-f]{12}$/.test(mac) && mac !== '000000000000' ? mac : null;
}

/** The segments that exist (WLED lists unused slots as `{ stop: 0 }`). */
export function activeSegments(state) {
  const segments = Array.isArray(state?.seg) ? state.seg : [];
  return segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => isObject(segment) && isInteger(segment.id) && segment.stop !== 0);
}

/**
 * The segment the WLED interface shows: `mainseg` when it exists, else the
 * first selected one, else the first one.
 */
export function mainSegmentId(state) {
  const segments = activeSegments(state);
  if (segments.some(({ segment }) => segment.id === state.mainseg)) {
    return state.mainseg;
  }
  const selected = segments.find(({ segment }) => segment.sel === true);
  return (selected ?? segments[0])?.segment.id ?? 0;
}

/**
 * The segments a command of the controller device goes to: the selected ones,
 * like the WLED interface, or the main one when none is selected.
 */
export function targetSegmentIds(state) {
  const selected = activeSegments(state)
    .filter(({ segment }) => segment.sel === true)
    .map(({ segment }) => segment.id);
  return selected.length > 0 ? selected : [mainSegmentId(state)];
}

export function findSegment(state, id) {
  return activeSegments(state).find(({ segment }) => segment.id === id) ?? null;
}

/**
 * The preset shown as active: the running playlist, else the last preset
 * applied; -1 once the state was changed by hand.
 */
export function activePresetId(state) {
  if (isInteger(state?.pl) && state.pl > 0) {
    return state.pl;
  }
  return isInteger(state?.ps) && state.ps > 0 ? state.ps : -1;
}

/** Effect list of /json/eff, without the reserved slots: `[{ id, name }]`. */
export function parseEffects(effects) {
  if (!Array.isArray(effects)) {
    return [];
  }
  return effects
    .map((name, id) => ({ id, name: typeof name === 'string' ? name.trim() : '' }))
    .filter(({ name }) => !RESERVED_EFFECT_NAMES.has(name));
}

/** Palette list of /json/pal (null on builds without palettes): `[{ id, name }]`. */
export function parsePalettes(palettes) {
  if (!Array.isArray(palettes)) {
    return [];
  }
  return palettes
    .map((name, id) => ({ id, name: typeof name === 'string' ? name.trim() : '' }))
    .filter(({ name }) => name !== '');
}

/**
 * Presets and playlists of /presets.json, by id: `[{ id, name, playlist,
 * quickLabel }]`. Slot 0 is reserved and empty slots are skipped.
 */
export function parsePresets(presets) {
  if (!isObject(presets)) {
    return [];
  }
  return Object.entries(presets)
    .map(([key, preset]) => ({ id: Number(key), preset }))
    .filter(
      ({ id, preset }) =>
        isInteger(id) && id > 0 && id < 251 && isObject(preset) && Object.keys(preset).length > 0,
    )
    .map(({ id, preset }) => ({
      id,
      name: typeof preset.n === 'string' && preset.n.trim() ? preset.n.trim() : `Preset ${id}`,
      playlist: isObject(preset.playlist),
      quickLabel: typeof preset.ql === 'string' && preset.ql.trim() ? preset.ql.trim() : null,
    }))
    .sort((a, b) => a.id - b.id);
}

/**
 * Primary colour of a segment as [r, g, b, w], from an array or a hex string
 * (older builds and hand-written presets), or null.
 */
export function primaryColor(segment) {
  const color = Array.isArray(segment?.col) ? segment.col[0] : undefined;
  if (Array.isArray(color) && color.length > 0 && color.every(isInteger)) {
    const [r = 0, g = 0, b = 0, w = 0] = color;
    return [r, g, b, w].map((channel) => clamp(channel, 0, 255));
  }
  if (typeof color === 'string' && /^#?([0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) {
    const hex = color.replace('#', '');
    const channels = hex.match(/../g).map((pair) => parseInt(pair, 16));
    return [channels[0], channels[1], channels[2], channels[3] ?? 0];
  }
  return null;
}

/** [r, g, b] to the 0xRRGGBB integer Gladys uses for colours. */
export const rgbToInt = ([r, g, b]) => (r << 16) | (g << 8) | b;

/** 0xRRGGBB to [r, g, b]. */
export function intToRgb(value) {
  const color = clamp(Math.round(Number(value)) || 0, 0, 0xffffff);
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

/**
 * WLED 0-255 level to a 0-100 percentage. A lit level never reads 0 %, which
 * Gladys shows as off.
 */
export function toPercent(level) {
  const value = clamp(Math.round(Number(level)) || 0, 0, 255);
  return value === 0 ? 0 : Math.max(1, Math.round((value * 100) / 255));
}

/** 0-100 percentage to a WLED 0-255 level. */
export const fromPercent = (percent) =>
  Math.round((clamp(Number(percent) || 0, 0, 100) * 255) / 100);

/** WLED white balance (0-255, or kelvins from 1900 on) to kelvins. */
export function cctToKelvin(cct) {
  const value = Number(cct);
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value >= CCT_KELVIN_THRESHOLD) {
    return Math.round(clamp(value, KELVIN_MIN, KELVIN_MAX));
  }
  return Math.round(KELVIN_MIN + (clamp(value, 0, 255) / 255) * (KELVIN_MAX - KELVIN_MIN));
}

/** Kelvins to the WLED white balance (0-255). */
export function kelvinToCct(kelvin) {
  const value = clamp(Number(kelvin) || KELVIN_MIN, KELVIN_MIN, KELVIN_MAX);
  return Math.round(((value - KELVIN_MIN) / (KELVIN_MAX - KELVIN_MIN)) * 255);
}

/**
 * What the integration keeps of /json/info: identity, capabilities and the
 * markers telling when the effect, palette and preset lists must be read again.
 */
export function parseInfo(info) {
  const leds = isObject(info?.leds) ? info.leds : {};
  return {
    mac: macOf(info),
    name: typeof info?.name === 'string' && info.name.trim() ? info.name.trim() : 'WLED',
    version: typeof info?.ver === 'string' ? info.ver : 'unknown',
    ledCount: isInteger(leds.count) ? leds.count : 0,
    // -1 (or nothing) when the build has no WebSocket support.
    websocket: isInteger(info?.ws) && info.ws >= 0,
    live: info?.live === true,
    uptime: Number.isFinite(info?.uptime) ? info.uptime : null,
    catalogVersion: `${info?.ver}|${info?.fxcount}|${info?.palcount}`,
    presetsVersion: Number.isFinite(info?.fs?.pmt) ? info.fs.pmt : null,
    capabilities: controllerCapabilities(info),
  };
}
