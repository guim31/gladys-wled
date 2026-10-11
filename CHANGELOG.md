# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- German and Spanish: the configuration, the "Search" action, the scene trigger
  and actions, the widget and the integration messages now follow a Gladys in
  German or Spanish. Feature names can also be given in German or Spanish
  (Configuration → Language of the feature names). Effect and palette names
  read on the controller stay as WLED gives them.

## [1.0.2] - 2026-10-10

### Fixed

- The "Effect" button of the WLED widget did nothing on a real Gladys: buttons
  opening a form need a Gladys newer than 5.1.4. The widget now shows one-tap
  buttons for the effects chosen in its settings (Solid and Rainbow by default),
  next to the favorite presets.

## [1.0.1] - 2026-10-10

### Added

- WLED controllers over the local network, found automatically through the
  Gladys core (mDNS `_wled._tcp`), or by IP address entered in the
  configuration. A controller is recognized by its MAC address and keeps its
  device when its IP address changes.
- One device per controller: on/off, brightness, color, color temperature
  (strips with CCT whites), white channel (RGBW strips), effect, palette and
  preset lists read on the controller, effect speed and intensity, nightlight,
  UDP sync. It drives the segments selected in WLED, like the WLED interface.
- Option: one more device per segment, for controllers with several segments.
- Real-time states over each controller's WebSocket, with reconnection and a
  30-second poll while the WebSocket is down or missing. Only the changes are
  published, and every state is sent again when a device is added in Gladys.
- New presets saved in WLED, and new effects or palettes after a firmware
  update, reach the lists of the devices already created.
- Scene actions "Apply a WLED preset" and "Start a WLED effect", and the scene
  trigger "WLED preset activated" (a preset started outside Gladys).
- "WLED" dashboard widget: favorite presets as buttons, the current effect,
  palette and preset, and an effect picker.
- Local / unreachable badge on every device.
- "Search for controllers" action in the configuration screen.
- User documentation in English and French.

[Unreleased]: https://github.com/guim31/gladys-wled/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/guim31/gladys-wled/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/guim31/gladys-wled/releases/tag/v1.0.1
