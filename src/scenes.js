// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// On, brightness and colour are already Gladys scene actions on the light
// features. These two reach what only WLED knows: its presets and playlists,
// and its effects with their palette and settings. Names are typed in the
// scene (the scene editor offers no list read from the controller): a number
// works too.
//
// The preset trigger (`preset_activated`) is fired by the hub (src/hub.js),
// never as a consequence of these actions: a scene bound to it would loop.
// -----------------------------------------------------------------------------

export const SCENE_ACTIONS = {
  async apply_preset(hub, { fields }) {
    const preset = await hub.applyPreset(fields.device, fields.preset);
    return { preset_id: preset.id, preset_name: preset.name };
  },

  async start_effect(hub, { fields }) {
    const effect = await hub.startEffect(fields.device, {
      effect: fields.effect,
      palette: fields.palette,
      speed: fields.speed,
      intensity: fields.intensity,
    });
    return { effect_id: effect.id, effect_name: effect.name };
  },
};
