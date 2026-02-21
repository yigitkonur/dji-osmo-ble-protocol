reverse-engineered BLE protocol for the DJI Osmo Pocket 3. full DUML message implementation, pairing flow, gimbal control, and live telemetry — all from Node.js over Bluetooth, no DJI Mimo app needed.

```bash
dji-osmo gimbal <device-id>
```

[![node](https://img.shields.io/badge/node.js-ESM-93450a.svg?style=flat-square)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-grey.svg?style=flat-square)](https://opensource.org/licenses/MIT)

---

## what it does

talks directly to the Osmo Pocket 3 over BLE using DJI's proprietary DUML binary protocol. built by capturing and decoding Wireshark traces of the DJI Mimo app.

- **full DUML protocol** — message builder, parser, stream reassembly, CRC8/CRC16 engine
- **BLE transport** — scan, connect, pair, subscribe to notifications on `fff0` service
- **gimbal control** — 5 command methods: velocity, absolute angle, timed angle, incremental move, raw PWM
- **live telemetry** — pitch/roll/yaw position at ~20 Hz via push notifications
- **interactive CLI** — keyboard-driven gimbal control with live status line
- **diagnostic tools** — BLE scanner, characteristic inspector, DUML message decoder/CRC verifier

> **note:** gimbal motor commands are sent and parsed correctly, but the Osmo Pocket 3 silently ignores them over BLE alone. likely requires active WiFi streaming first. gimbal telemetry works fine.

## install

```bash
git clone https://github.com/yigitkonur/lib-osmo-ble.git
cd lib-osmo-ble
npm install
```

two runtime deps: `@stoprocent/noble` (BLE) and `crc-full` (CRC). no build step.

for global CLI access:

```bash
npm link
```

## usage

### scan for devices

```bash
node tools/scan-device.mjs [timeout_seconds]
```

prints device name, peripheral ID, RSSI, manufacturer data, and service UUIDs for all DJI devices found.

### interactive gimbal control

```bash
dji-osmo gimbal <device-id>
```

| key | action |
|:---|:---|
| arrows / WASD | pitch and yaw |
| E / C | roll left / right |
| R | recenter (0,0,0) |
| +/- | adjust speed (1..180 deg/s) |
| 1-5 | switch command method (speed/angle/abs/PWM/move) |
| Q | disconnect and exit |

live status line updates every 500 ms with current gimbal position, speed, active method, and command count.

### one-shot commands

```bash
dji-osmo gimbal <device-id> --recenter
dji-osmo gimbal <device-id> --mode follow
dji-osmo gimbal <device-id> --angle -30 90    # pitch=-30, yaw=90
```

### diagnostic tools

```bash
# inspect BLE characteristics
node tools/check-characteristics.mjs <device-id>

# decode and CRC-verify a DUML hex message
node tools/verify-crc.mjs 552204ea020780924007450f30303137343933313932383631303204353136302e42
```

### as a library

```javascript
import { OsmoConnection } from 'lib-osmo-ble';

const conn = new OsmoConnection({ deviceId: '<id>', pin: 'love' });
await conn.connect();
await conn.pair();

conn.gimbal.on('state', ({ pitch, roll, yaw }) => {
  console.log(`pitch=${pitch} roll=${roll} yaw=${yaw}`);
});

conn.gimbal.setSpeed(10, 0, 0);  // pitch at 10 deg/s
```

modular exports available:

```javascript
import { buildMessage, parseMessage } from 'lib-osmo-ble/protocol';
import { BleTransport } from 'lib-osmo-ble/transport';
import { GimbalController } from 'lib-osmo-ble/gimbal';
```

## CLI flags

| flag | default | description |
|:---|:---|:---|
| `--pin <pin>` | `love` | BLE pairing PIN |
| `--angle <pitch> <yaw>` | — | set absolute angle, then disconnect |
| `--recenter` | — | recenter to 0,0,0, then disconnect |
| `--mode <mode>` | — | set mode (`follow`, `lock`, `fpv`), then disconnect |

## protocol overview

DUML (DJI Universal Markup Language) is a binary framing protocol:

```
[0x55] [length:10bit] [version:6bit] [CRC8] [target:16LE] [seq:16BE] [flags] [cmdSet] [cmdId] [payload...] [CRC16:LE]
```

- CRC8: poly=0x31, init=0xEE, reflected — over first 3 bytes
- CRC16: poly=0x1021, init=0x496C, reflected — over full frame minus trailer
- target field: `sender | (receiver << 8)` in little-endian
- message ID: big-endian (only BE field in the frame)

### BLE characteristics

| char | properties | role |
|:---|:---|:---|
| `fff4` | read, write, notify, indicate | pairing trigger + inbound DUML notifications |
| `fff5` | read, writeWithoutResponse, notify, indicate | outbound DUML commands |

critical discovery: `fff3` has `write` (with response) and accepts writes without error, but the firmware silently ignores the payload. only `fff5` (`writeWithoutResponse`) actually processes DUML. this created a silent failure mode in the existing `node-osmo` library.

### implemented commands

| cmd set | cmd ID | description |
|:---|:---|:---|
| 0x04 (gimbal) | 0x01 | raw PWM (363..1685, center=1024) |
| 0x04 | 0x05 | position telemetry (push, ~20 Hz) |
| 0x04 | 0x0A | absolute angle |
| 0x04 | 0x0C | velocity control |
| 0x04 | 0x14 | absolute angle with duration |
| 0x04 | 0x15 | incremental move (±127 steps) |
| 0x04 | 0x4C | set mode (lock/follow/FPV) |
| 0x07 (wifi) | 0x45 | set pairing PIN |
| 0x07 | 0x46 | pairing approved |
| 0x07 | 0x47 | WiFi connect |

full protocol spec in [PROTOCOL.md](PROTOCOL.md).

## node-osmo patch

includes a `git format-patch` fixing 7 bugs in the [datagutt/node-osmo](https://github.com/datagutt/node-osmo) library:

```bash
cd node-osmo
git am ../lib-osmo-ble/patches/node-osmo-all-fixes.patch
```

the biggest bug: `ByteBuf extends DataView` initialized `#byteOffset` to the Node.js Buffer pool offset (~4096) instead of 0, causing every byte read to hit the wrong position. all messages decoded to type `1794` (0x0702). details in `analysis/bytebuf-node-buffer-pool.md`.

## project structure

```
src/
  connection.mjs           — top-level facade (scan, connect, pair)
  transport/
    ble.mjs                — noble-based BLE layer
  protocol/
    constants.mjs          — addresses, UUIDs, CRCs, command IDs
    duml.mjs               — DUML builder, parser, stream reassembly
  controllers/
    gimbal.mjs             — gimbal API (5 command methods + telemetry)
  cli/
    index.mjs              — CLI entry point
    cmd-gimbal.mjs         — interactive keyboard mode
tools/
  scan-device.mjs          — BLE scanner
  check-characteristics.mjs — characteristic inspector
  verify-crc.mjs           — DUML message decoder + CRC verifier
analysis/                  — research notes (BLE mapping, endianness, bugs)
reference/                 — Wireshark dissector source, annotated captures
patches/                   — node-osmo bug fixes (git format-patch)
```

## license

MIT
