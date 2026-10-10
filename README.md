# WLED for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com) that
controls [WLED](https://kno.wled.ge) LED controllers (ESP8266 / ESP32) over the
local network, through WLED's JSON API and its WebSocket. No cloud, no account.

> **Developed without the hardware: feedback welcome.** The integration is
> built and tested against real answers of WLED controllers (0.14 to 16.0,
> collected by the python-wled project), not against physical strips. Please
> report what works and what does not in the
> [issues](https://github.com/guim31/gladys-wled/issues).

## Features

- **Automatic discovery**: the controllers announce themselves in mDNS
  (`_wled._tcp`); the Gladys core browses for the integration (mediated network
  discovery). IP addresses can be entered by hand for the ones it does not see.
- **One device per controller**: on/off, brightness, color, white color
  temperature (RGB+CCT strips), white channel (RGBW strips), **effect**,
  **palette** and **preset** (lists read on the controller, kept up to date),
  effect speed and intensity, nightlight, UDP sync (send).
- **Segments**: the controller device drives the segments selected in WLED,
  like the WLED interface (the whole strip when there is only one). Optionally,
  one more device per segment, with its own light, effect and palette.
- **Real time**: every controller pushes its state over its WebSocket the
  moment it changes (WLED app, button, schedule, another controller in sync).
  When the WebSocket is down, or on a build without one, the controller is
  polled every 30 s while the integration reconnects.
- **Scene actions**: _Apply a WLED preset_ (or playlist) and _Start a WLED
  effect_ (with palette, speed and intensity), by name or number.
- **Scene trigger**: _WLED preset activated_, when a preset or playlist starts
  outside Gladys (WLED app, button, schedule, remote).
- **Dashboard widget** "WLED": the presets marked as favorites in WLED (a
  quick-load label) as one-tap buttons, the current effect, palette and preset,
  and an effect picker.
- A **transport badge** per device: local, or unreachable when the controller
  does not answer.

## Requirements

- Gladys Assistant **5.1.0** or later (widgets, scene triggers and actions,
  mediated mDNS discovery).
- A WLED controller on the same local network as Gladys. Tested formats: WLED
  0.14.0, 0.14.4, 0.15.0, 0.15.4, 0.99 (beta) and 16.0.1. Builds from 0.13 should
  work (the light capabilities are read with a fallback for older fields).

## Installation

1. In Gladys, open **Integrations**, find **WLED** in the catalog and install it.
   The install screen shows the mDNS discovery request (`_wled._tcp`).
2. Open the **Discovery** tab: the controllers found appear there. Add them.
3. A controller is missing? In **Configuration**, enter its IP address (shown in
   the WLED app, under _Config_ → _WiFi Setup_), save, and check **Discovery**
   again. Give it a fixed address in your router (DHCP reservation) if you can.

The user guide is in [`docs/en.md`](docs/en.md) (French:
[`docs/fr.md`](docs/fr.md)); Gladys links it from the Configuration screen.

## How it works

```
Gladys core ──mDNS (_wled._tcp)──▶ LAN          (the core browses, on the host network)
     ▲                                          (the integration only reads the results)
     │ SDK (WebSocket + host API)
Integration container ──HTTP /json/si, /json/eff, /json/pal, /presets.json──▶ controller
                      ◀──────────── WebSocket /ws: { state, info } on every change ─────
                      ──HTTP POST /json/state (commands, answered with the new state)──▶
```

- The controller is identified by its **MAC address**: a controller that
  changes IP address (DHCP) keeps its device; a new scan (every 15 minutes, or
  from the Discovery tab) finds its new address.
- Only the **changes** are published to Gladys (it allows 300 states a minute),
  and pushes closer than 300 ms are merged (a slider dragged in the WLED app).
- The effect and palette lists are read again when the firmware changes, the
  presets when one is saved (`info.fs.pmt`). New lists reach the devices
  already created without any action.
- What the integration knows (addresses, capabilities, lists) is kept in
  `/data/wled-state.json`, so the devices stay in the Discovery list while a
  controller is off.
- Memory: one WebSocket per controller (Node.js' built-in client) and no
  dependency beside the Gladys SDK, to stay well within the 256 MB sandbox.

## Limitations

- **Developed without the hardware**: see above. Field reports are what will
  turn this into a well-tested integration.
- Colors are RGB: the white channel of RGBW strips is a separate 0-100 slider,
  and WLED's secondary and tertiary colors are not exposed.
- The color temperature is shown from 2000 K to 6535 K, the range Home
  Assistant uses for WLED: WLED stores a 0-255 white balance and does not know
  the real kelvins of the LEDs.
- Gladys has no multiple choice in a device command: the effect, palette and
  preset are single-choice lists. Scene actions take names typed by hand (the
  scene editor cannot list what is on the controller).
- The nightlight is on/off: its duration, mode and target brightness are the
  ones set in WLED. UDP sync only exposes _send_.
- Segment devices follow the segments that exist; a segment deleted in WLED
  leaves its device in Gladys (delete it there).
- mDNS names (`wled-xxxx.local`) do not resolve inside the integration
  container: enter IP addresses.
- WLED accepts a limited number of WebSocket clients at once: the integration
  uses one per controller, next to the WLED app and Home Assistant if any.

## Development

Node.js 22+, ESM, no build step. The only runtime dependency is
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

```bash
npm install
npm test              # node --test: unit tests + simulated WLED network
npm run lint
npm run format:check
npx github:GladysAssistant/integration-store .   # store validator
```

```
index.js              SDK wiring (src/app.js registers the handlers)
src/hub.js            discovery, live links, states, commands, preset trigger
src/devices.js        WLED controller -> Gladys devices, states and commands
src/discovery.js      mDNS results, address probing
src/wled/client.js    HTTP client of the JSON API (one request at a time)
src/wled/socket.js    WebSocket link with reconnection and keepalive
src/wled/model.js     reading /json/info, /json/state and the lists, conversions
src/widgets.js        "WLED" dashboard widget
src/scenes.js         "Apply a preset" and "Start an effect" scene actions
test/                 node --test; fake Gladys, simulated WLED controllers
test/fixtures/wled/   real controller answers (python-wled), anonymized
```

`test/gladys-rules.test.js` checks every discovered device against the
category/type table extracted from the Gladys core.

To run it outside Gladys:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="wled" \
WLED_DATA_DIR=./data \
npm start
```

Releases are made by the **Release** workflow (Actions → Release); never edit
the versions by hand. A hand-pushed `vX.Y.Z` tag also builds the image and the
GitHub Release, but then `version` in `package.json` and in the manifest (with
the `docker_image` tag) must be bumped and committed before tagging. See
[`CLAUDE.md`](CLAUDE.md) for the project rules.

## Credits

- [python-wled](https://github.com/frenck/python-wled) by Franck Nijhof and
  contributors (MIT): the test fixtures in `test/fixtures/wled/` are real
  controller answers from its test suite (anonymized), and its client showed how
  to detect preset and list changes and handle a busy controller.
- Home Assistant's
  [`wled`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/wled)
  integration (Apache-2.0): one light per segment, the light capabilities, the
  color temperature range and the white handling.
- [WLED](https://github.com/wled/WLED) and its JSON API documentation.

## Disclaimer

This project is not affiliated with, endorsed or sponsored by the WLED project.
"WLED" is the name of its owners' project.

## License

Apache-2.0
