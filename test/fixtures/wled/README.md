# WLED test fixtures

Real answers of WLED controllers (`/json` with `state`, `info`, `effects`,
`palettes`, and `/presets.json`), taken from the test suite of
[python-wled](https://github.com/frenck/python-wled) by Franck Nijhof and
contributors, under the MIT license reproduced below.

Changes made: each controller got a distinct fake MAC address (`02c0ffee000N`)
and an IP address of the documentation range `192.0.2.0/24` (RFC 5737); the Wi-Fi
BSSID, device id, bootloader hash and usermod HTML were removed.

| File                           | Firmware  | LEDs                                      |
| ------------------------------ | --------- | ----------------------------------------- |
| `rgb-two-segments-0.14.4.json` | 0.14.4    | RGB, two segments, no WebSocket           |
| `rgbw-no-websocket-0.99.json`  | 0.99.0b1  | RGBW, presets and playlists, no WebSocket |
| `rgbw-cct-0.15.0-b3.json`      | 0.15.0-b3 | RGBW + CCT, preset active                 |
| `rgb-minimal-0.14.0.json`      | 0.14.0    | short lists, reserved effect, no mainseg  |
| `rgb-0.15.4.json`              | 0.15.4    | RGB                                       |
| `rgb-segment-lc-16.0.1.json`   | 16.0.1    | RGB, capabilities per segment             |
| `presets.json`                 | —         | a preset and a playlist                   |

## python-wled license

### MIT License

Copyright (c) 2019-2026 Franck Nijhof

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
