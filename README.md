# DJI Osmo Pocket 3 — BLE Reverse Engineering & RTMP Streaming

> **Successfully achieved**: Full BLE pairing → WiFi configuration → RTMP livestream initiation on a DJI Osmo Pocket 3, entirely from the command line on macOS, without the DJI Mimo app.

## What This Is

A complete documentation of reverse engineering the DJI Osmo Pocket 3's Bluetooth Low Energy (BLE) protocol to enable programmatic control — specifically, triggering RTMP livestreaming from a Node.js application. This repository contains:

- **[PROTOCOL.md](PROTOCOL.md)** — Complete DUML-over-BLE protocol specification
- **[JOURNEY.md](JOURNEY.md)** — The full reverse engineering narrative with every wrong turn and breakthrough
- **[patches/](patches/)** — Working patches for the [node-osmo](https://github.com/datagutt/node-osmo) library
- **[experiments/](experiments/)** — Annotated debug logs from 14 iterative experiments
- **[analysis/](analysis/)** — Deep-dive analysis of each bug discovered
- **[reference/](reference/)** — Wireshark dissector and protocol notes from [xaionaro's research](https://github.com/xaionaro/reverse-engineering-dji)

## The Result

```
State change 0 -> 1    idle → discovering
State change 1 -> 2    → connecting
State change 2 -> 3    → waitingForDevice
State change 3 -> 4    → checkingIfPaired (sent PIN)
  ← Pairing response: payload=0002 (pairing required)
State change 4 -> 5    → pairing
  ← Pairing approved: payload=01
State change 5 -> 6    → preparingStream (Stage 1 OK)
State change 6 -> 7    → preparingStream2 (Stage 2 OK)
State change 7 -> 8    → settingUpWifi (WiFi connected)
State change 8 -> 10   → startingStream
State change 10 -> 11  → streaming ✅
```

The camera connects to a local WiFi network and pushes an RTMP stream to a specified server — all triggered over BLE from a single command:

```bash
node examples/connect-to-device.js <deviceId> 3 <ssid> <password> 'rtmp://server:port/live/key'
```

## Quick Start

```bash
# Clone and patch node-osmo
git clone https://github.com/datagutt/node-osmo
cd node-osmo
git apply ../dji-osmo-ble-protocol/patches/node-osmo-all-fixes.patch
pnpm install
npx tsc

# Scan for your device
node --input-type=module -e "
import noble from '@stoprocent/noble';
noble.on('stateChange', s => { if (s === 'poweredOn') noble.startScanningAsync([], true); });
noble.on('discover', p => {
  if (p.advertisement?.localName?.includes('Osmo'))
    console.log(p.advertisement.localName, p.id);
});
"

# Connect and stream
node examples/connect-to-device.js <device-id> 3 <wifi-ssid> <wifi-pass> 'rtmp://your-server/live/key'
```

## The 7 Bugs That Prevented Everything

The journey to a working connection required finding and fixing **7 independent bugs**, any one of which silently prevented the protocol from working:

### Bug #1: ByteBuf Pool Offset (Root Cause of All Parse Failures)
Node.js `Buffer.alloc()` uses a shared 8KB memory pool. `ByteBuf` initialized its internal `#byteOffset` to `super.byteOffset` (e.g., 4096) instead of `0`, causing every single byte read to happen at the wrong position.

### Bug #2: ByteBuf DataView Length
`ByteBuf.from()` created a `DataView` without passing the source's `byteLength`, so it spanned the entire 8KB pool instead of just the message bytes.

### Bug #3: ByteBuf getUint24() Raw Array Access
`getUint24()` accessed the raw `Uint8Array(this.buffer)` without adding `super.byteOffset`, reading bytes from the pool start instead of the message.

### Bug #4: Message ID Byte Order
Message IDs were encoded as Little Endian but the wire format is **Big Endian** (confirmed by Wireshark captures from the DJI Mimo app).

### Bug #5: Wrong BLE Characteristic for Writes ⭐
**The single most critical discovery.** DUML commands were being written to characteristic **fff3** (which has `write` property). But the DJI Mimo app writes to **fff5** (which has `writeWithoutResponse`). The device silently ignores DUML commands on fff3.

### Bug #6: Fire-and-Forget BLE Writes
`writeMessage()` was synchronous and didn't `await` the async BLE write. Writes appeared to send (TX logged) but the BLE stack may not have delivered them.

### Bug #7: manufacturerData Discovery Guard
`onDiscover()` required `manufacturerData` in the BLE advertisement, but the Osmo Pocket 3 doesn't include it. The device was found by noble but silently filtered out.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    macOS / Node.js                        │
│                                                          │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────┐  │
│  │ noble (BLE)  │───▶│  node-osmo   │───▶│  DUML Msg  │  │
│  │ @stoprocent  │    │  device.ts   │    │  message.ts│  │
│  └──────┬───────┘    └──────────────┘    └────────────┘  │
│         │                                                │
│    ┌────▼────────────────────────────────────────┐       │
│    │           BLE GATT Service fff0             │       │
│    │                                             │       │
│    │  fff3: read/write (NOT used for DUML)       │       │
│    │  fff4: read/write/notify                    │       │
│    │    ├─ Write [0x01,0x00] → trigger pairing   │       │
│    │    └─ Receives ALL DUML notifications       │       │
│    │  fff5: writeWithoutResponse/notify           │       │
│    │    └─ Write DUML commands HERE ⭐            │       │
│    └────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────┘
                          │ BLE
                          ▼
┌──────────────────────────────────────────────────────────┐
│              DJI Osmo Pocket 3                           │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │  WiFi    │  │ Streaming│  │  Gimbal   │              │
│  │ cmdSet07 │  │ cmdSet02 │  │ cmdSet04  │              │
│  └────┬─────┘  └────┬─────┘  └──────────┘              │
│       │              │                                   │
│       │    ┌─────────▼──────────┐                       │
│       └───▶│   RTMP Encoder     │                       │
│            └─────────┬──────────┘                       │
│                      │ WiFi                              │
└──────────────────────┼──────────────────────────────────┘
                       ▼
              ┌────────────────┐
              │  RTMP Server   │
              │  (your server) │
              └────────────────┘
```

## DUML Message Format

```
[0x55] [len_lo] [ver<<2|len_hi] [crc8] [target:2B LE] [id:2B BE] [type:3B] [payload] [crc16:2B LE]
```

See [PROTOCOL.md](PROTOCOL.md) for the complete specification.

## Project Structure

```
dji-osmo-ble-protocol/
├── README.md                          # This file
├── PROTOCOL.md                        # Complete protocol specification
├── JOURNEY.md                         # Reverse engineering narrative
├── patches/
│   ├── node-osmo-all-fixes.patch      # All 7 bug fixes for node-osmo
│   └── README.md                      # Patch application instructions
├── experiments/
│   ├── README.md                      # Experiment index
│   └── logs/
│       ├── 01-initial-bytebuf-fix.log
│       ├── 04-false-positive-all-telemetry.log
│       ├── 07-restructured-pairing.log
│       ├── 12-manufacturer-data-fix.log
│       ├── 13-async-write-fix.log
│       └── 14-success-full-streaming.log
├── analysis/
│   ├── bytebuf-node-buffer-pool.md    # Deep dive: Node.js Buffer pool vs DataView
│   ├── ble-characteristic-mapping.md  # Which char does what
│   ├── message-endianness.md          # BE vs LE analysis
│   ├── false-positive-analysis.md     # Why run #4 appeared to work but didn't
│   └── pairing-flow-comparison.md     # node-osmo vs djictl vs DJI Mimo
├── reference/
│   ├── xaionaro-message-types.md      # From xaionaro/reverse-engineering-dji
│   └── dji-ble-message.c             # Wireshark dissector source
└── tools/
    ├── scan-device.mjs                # BLE scanner for DJI devices
    ├── check-characteristics.mjs      # Dump BLE service/char properties
    └── verify-crc.mjs                 # CRC8/CRC16 verification tool
```

## Device Compatibility

| Device | Model ID | Status |
|--------|----------|--------|
| DJI Osmo Pocket 3 | 3 | ✅ Verified — full pairing + streaming |
| DJI Osmo Mobile | — | Untested (likely compatible) |
| DJI Osmo Action | — | Untested |

## Requirements

- **macOS** with Bluetooth (tested on Apple Silicon / Sequoia)
- **Node.js** v18+ (tested on v25.5.0)
- **pnpm** package manager
- `@stoprocent/noble` (NOT `@abandonware/noble`)
- `blueutil` (for Bluetooth reset: `brew install blueutil`)
- An RTMP server (e.g., [MediaMTX](https://github.com/bluenviron/mediamtx), nginx-rtmp)

## Known Issues

- **Rapid reconnections can crash camera's BLE stack** — the camera stops advertising and needs a power cycle. Always disconnect cleanly.
- **macOS CoreBluetooth state** — if the camera disappears from scans, run `blueutil --power 0 && sleep 2 && blueutil --power 1`
- **PIN code** — the default is `5160` but may vary. Check the camera's screen during pairing.

## Acknowledgments

- [xaionaro/reverse-engineering-dji](https://github.com/xaionaro/reverse-engineering-dji) — Wireshark captures and dissector that provided the critical clue about fff5 being the write characteristic
- [datagutt/node-osmo](https://github.com/datagutt/node-osmo) — Original Node.js library that provided the foundation
- [djictl](https://github.com/xaionaro/djictl) — Go reference implementation of the DUML protocol

## License

This research is published for educational purposes. The protocol documentation is original reverse engineering work. See individual files for their respective licenses.
