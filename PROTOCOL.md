# DJI Osmo BLE Protocol Reference

> **Verified on**: DJI Osmo Pocket 3 (model 3), firmware via BLE from macOS using `@stoprocent/noble`
> **Last updated**: February 2026

## Summary of Critical Findings

This document describes the DUML-over-BLE protocol used by DJI Osmo cameras, discovered through reverse engineering the DJI Mimo app's BLE traffic (via [xaionaro/reverse-engineering-dji](https://github.com/xaionaro/reverse-engineering-dji)) and extensive trial-and-error debugging.

### Key Breakthroughs

1. **BLE Write Characteristic**: DUML commands must be written to **fff5** (`writeWithoutResponse`), NOT fff3. This was the single most critical discovery — writing to fff3 causes the device to silently ignore all commands.
2. **ByteBuf Node.js Buffer Pool Bug**: Node.js Buffers share a pooled 8KB ArrayBuffer. Three separate bugs in `ByteBuf` caused all DUML message parsing to fail.
3. **Message ID Byte Order**: Message IDs are Big Endian on the wire, not Little Endian.
4. **manufacturerData Not Required**: The Osmo Pocket 3 does not include `manufacturerData` in its BLE advertisement — the discovery filter must not require it.

---

## BLE Characteristic Map

| UUID | Name | Properties | Purpose |
|------|------|-----------|---------|
| **fff3** | — | read, write, notify, indicate | Unknown/unused for DUML (do NOT write DUML here) |
| **fff4** | PairingRequestor | read, write, notify, indicate | Write `[0x01, 0x00]` to trigger pairing; receives DUML notifications |
| **fff5** | Sender | read, writeWithoutResponse, notify, indicate | **Write DUML commands here** (writeWithoutResponse); also receives notifications |

> **CRITICAL**: On the Osmo Pocket 3, ALL DUML telemetry and response messages arrive on **fff4** notifications. fff5 receives no notification data despite being subscribed. This may differ on other DJI devices.

---

## DUML Message Wire Format

```
[0x55] [len_lo] [ver<<2 | len_hi] [crc8] [target:2B LE] [id:2B BE] [type:3B] [payload:N] [crc16:2B LE]
```

| Field | Bytes | Encoding | Description |
|-------|-------|----------|-------------|
| Magic | 1 | — | Always `0x55` |
| Length | 2 | 10-bit LE | `byte[1] | ((byte[2] & 0x03) << 8)`. Total message length including CRC16 = 13 + payload_length |
| Version | — | `byte[2] >> 2` | Typically `1` (raw byte = `0x04` when length < 256) |
| CRC8 | 1 | — | CRC8 of bytes [0..2]. Poly=0x31, Init=0xEE, RefIn=true, RefOut=true |
| Target | 2 | Little Endian | `sender | (receiver << 8)`. E.g., App(0x02)→WiFi(0x07) = 0x0702 → wire `02 07` |
| Message ID | 2 | **Big Endian** | Sequence counter. Device echoes same ID in response |
| Type | 3 | Wire order: `[flags, cmdSet, cmdId]` | flags=byte[8], cmdSet=byte[9], cmdId=byte[10] |
| Payload | N | — | Command-specific data |
| CRC16 | 2 | Little Endian | CRC16 of bytes [0..end-2]. Poly=0x1021, Init=0x496C, RefIn=true, RefOut=true |

### Type Field Encoding

The 3-byte type field is read as a 24-bit LE integer in code, but stored on the wire as `[flags, cmdSet, cmdId]`:

| Constant (LE uint24) | Wire bytes | Flags | CmdSet | CmdId |
|----------------------|-----------|-------|--------|-------|
| 0x450740 | `40 07 45` | 0x40 (request) | 0x07 | 0x45 |
| 0xC00745 | `C0 07 45` | 0xC0 (response) | 0x07 | 0x45 |

- **Flags 0x40**: Request/command from app
- **Flags 0xC0**: Response from device (or acknowledgment from app)
- **Flags 0x00**: Unsolicited telemetry/notification

### Response Matching

Responses have the same `cmdSet` and `cmdId` as the request, with the response flag (0x80) set:
- Request flags=0x40 → Response flags=0xC0

---

## Complete Pairing + Streaming Flow (Verified)

### Step 1: BLE Discovery & Connection
```
1. Scan for BLE device (localName contains "Osmo")
2. Connect to peripheral
3. Discover services → find service fff0
4. Discover characteristics fff3, fff4, fff5
5. Subscribe to fff5 notifications (data channel)
6. Subscribe to fff4 notifications (pairing + telemetry)
7. Wait for first DUML message on fff4 (device is ready)
```

### Step 2: Pairing
```
1. Write [0x01, 0x00] to fff4 (triggers pairing mode on device)
2. Wait 200ms
3. Send SetPairingPIN via DUML on fff5:
   - Type: 0x450740 (flags=0x40, cmdSet=0x07, cmdId=0x45)
   - Target: 0x0702 (App → WiFi subsystem)
   - Payload: PackString(identifier) + PackString(PIN)
     - identifier: "001749319286102" (15-char device identifier)
     - PIN: "5160" (default, or read from device screen)
4. Receive pairing_status response (0xC00745):
   - payload[1] == 0x01: Already paired → skip to Step 3
   - payload[1] == 0x02: Pairing required → wait for approval
5. Receive pairing_pin_approved (0x400746): payload=0x01
6. Proceed to streaming setup
```

### Step 3: Prepare to Livestream (Stage 1)
```
Send DUML on fff5:
- Type: 0xE10240 (flags=0x40, cmdSet=0x02, cmdId=0xE1)
- Target: 0x0802 (App → Streaming subsystem)
- Payload: [0x1A]
Wait for response (0xC002E1): payload=0x00 means OK
```

### Step 4: Prepare to Livestream (Stage 2)
```
Send DUML on fff5:
- Type: 0x8E0240 (flags=0x40, cmdSet=0x02, cmdId=0x8E)
- Target: 0x0802
- Payload: [0x00, 0x01, 0x1C, 0x00]
Wait for response (0xC0028E)
```

### Step 5: Connect to WiFi
```
Send DUML on fff5:
- Type: 0x470740 (flags=0x40, cmdSet=0x07, cmdId=0x47)
- Target: 0x0702
- Payload: PackString(SSID) + PackString(password)
Wait for response (0xC00747): payload=0x0000 means connected OK
```

### Step 6: Configure Livestream
```
Send DUML on fff5:
- Type: 0x780840 (flags=0x40, cmdSet=0x08, cmdId=0x78)
- Target: 0x0802
- Payload: [resolution, fps, bitrate config] + PackString(RTMP URL)
```

### Step 7: Start Livestream
```
Send DUML on fff5:
- Type: 0x8E0240 (flags=0x40, cmdSet=0x02, cmdId=0x8E)
- Target: 0x0802
- Payload: [0x01, 0x01, 0x1A, 0x00, 0x01, 0x01]
```

---

## Verified State Machine

```
idle(0) → discovering(1) → connecting(2) → waitingForDevice(3) → 
checkingIfPaired(4) → pairing(5) → preparingStream(6) → 
preparingStream2(7) → settingUpWifi(8) → configuring(9) → 
startingStream(10) → streaming(11)
```

### Verified Log Output (Successful Run)
```
State change 0 -> 1    (idle → discovering)
State change 1 -> 2    (→ connecting)
State change 2 -> 3    (→ waitingForDevice)
State change 3 -> 4    (→ checkingIfPaired: sent [0x01,0x00] + SetPairingPIN)
Pairing response: flags=0xc0 payload=0002   ← "pairing required"
State change 4 -> 5    (→ pairing)
Pairing approved notification: payload=01   ← user approved on device
State change 5 -> 6    (→ preparingStream)
PrepareToLiveStream Stage1 response: payload=00   ← OK
State change 6 -> 7    (→ preparingStream2)
PrepareToLiveStream Stage2 response: payload=0000011c0009030900000000000020
State change 7 -> 8    (→ settingUpWifi)
WiFi setup response: payload=0000   ← connected to WiFi
State change 8 -> 10   (→ startingStream, skipped configuring)
State change 10 -> 11  (→ streaming ✅)
```

---

## Device Address Map (DUML Subsystem IDs)

| ID | Device | Description |
|----|--------|-------------|
| 0x00 | Invalid/Any | Broadcast |
| 0x01 | Camera | Ambarella SoC |
| 0x02 | App | Mobile app / BLE client |
| 0x03 | Flight Controller | FC |
| 0x04 | **Gimbal** | Gimbal MCU |
| 0x05 | Center Board | — |
| 0x06 | Remote Control | RC |
| 0x07 | Wi-Fi | Wi-Fi subsystem |
| 0x08 | DM36x | Transcoder |

---

## Gimbal Control (CmdSet 0x04)

The gimbal is addressed as device `0x04`. To send commands from the App, use target `0x0402` (App→Gimbal, wire bytes `02 04`).

### Gimbal Command IDs

| CmdId | Name | Direction | Payload | Description |
|-------|------|-----------|---------|-------------|
| 0x01 | Gimbal Control | App→Gimbal | 3× uint16 LE (range 363..1685) | PWM-style control, center=1024 |
| 0x02 | Get Position | App→Gimbal | (empty) | Request current position |
| 0x05 | **Params/Push Position** | Gimbal→App | ≥12B | **Telemetry**: pitch/roll/yaw + mode + flags (~20Hz) |
| 0x0A | **Ext Ctrl Degree (Angle Set)** | App→Gimbal | 10B | Set absolute angle target |
| 0x0B | Ext Ctrl Status | App→Gimbal | (empty) | Query control status |
| 0x0C | **Ext Ctrl Accel (Speed)** | App→Gimbal | 7B | Set angular velocity |
| 0x0D | Suspend/Resume | App→Gimbal | uint16 LE | 0x2AB5=Resume, 0x7EF2=Suspend |
| 0x14 | **Abs Angle Control** | App→Gimbal | 8B | Absolute angle with duration |
| 0x15 | **Movement** | App→Gimbal | 20B | Incremental movement (int8 steps) |
| 0x1C | Type Get | App→Gimbal | — | Query gimbal type |
| 0x39 | Lock | App→Gimbal | — | Lock gimbal position |
| 0x3A | Rotate Camera X Axis | App→Gimbal | — | Rotate 90°/180° |
| 0x4C | **Reset And Set Mode** | App→Gimbal | 2B | Mode: 0=lock, 1=follow, 2=FPV |

### Gimbal Telemetry Payload (0x05 — Push Position)

```
Offset  Type     Field              Unit          Range
0       int16 LE Pitch              ×0.1 degree   -900..470 (zero=forward)
2       int16 LE Roll               ×0.1 degree   -410..410 (zero=level)
4       int16 LE Yaw                ×0.1 degree   -1460..-540 (-1000=forward)
6       uint8    Mode/Flags         —             bit5=sub_mode, bit6-7=mode
7       int8     Roll Adjust        —             —
8       uint16   Yaw Angle/Joystick —             bit0-1=ver_dir, bit2-3=hor_dir
10      uint8    Limit Flags        —             bit0=pitch, bit1=roll, bit2=yaw
11      uint8    Version/Click      —             bit5=double, bit6=triple, bit7=single
```

### Gimbal Speed Control Payload (0x0C)

```
[int16 LE: pitch_speed] [int16 LE: roll_speed] [int16 LE: yaw_speed] [uint8: flags]
```
All speed values in degrees × 10, range -1800..1800. Flags bit0 = enable.

### Gimbal Angle Set Payload (0x0A)

```
[int16 LE: pitch] [int16 LE: roll] [int16 LE: yaw] [int16 LE: speed×100] [uint8: flags] [uint8: speed/2000]
```
Angles in degrees × 10, range -1800..1800.

### Gimbal Abs Angle Control Payload (0x14)

```
[int16 LE: pitch] [int16 LE: roll] [int16 LE: yaw] [uint8: flags] [uint8: duration]
```
Angles in degrees × 10. Flags: bit0=pitch, bit1=roll, bit2=yaw (which axes to control). Duration unit TBD.

---

## Message Type Reference

### Control Messages (App → Device)

| Name | Type (LE) | Wire bytes | CmdSet | CmdId | Target | Payload |
|------|-----------|-----------|--------|-------|--------|---------|
| SetPairingPIN | 0x450740 | `40 07 45` | 0x07 | 0x45 | 0x0702 | PackString(id) + PackString(pin) |
| ConnectToWiFi | 0x470740 | `40 07 47` | 0x07 | 0x47 | 0x0702 | PackString(ssid) + PackString(pass) |
| PrepareToLiveStream | 0xE10240 | `40 02 E1` | 0x02 | 0xE1 | 0x0802 | `[0x1A]` |
| StartStopStreaming | 0x8E0240 | `40 02 8E` | 0x02 | 0x8E | 0x0802 | varies |
| ConfigureLiveStream | 0x780840 | `40 08 78` | 0x08 | 0x78 | 0x0802 | config + URL |
| ScanWiFi | 0xAB0740 | `40 07 AB` | 0x07 | 0xAB | 0x0702 | (empty) |

### Response/Notification Messages (Device → App)

| Name | Type (LE) | CmdSet | CmdId | Flags | Meaning |
|------|-----------|--------|-------|-------|---------|
| PairingStatus | 0xC00745 | 0x07 | 0x45 | 0xC0 | payload[1]: 0x01=paired, 0x02=pairing required |
| PairingPINApproved | 0x400746 | 0x07 | 0x46 | 0x40 | payload=0x01: PIN approved by user |
| WiFiConnectResult | 0xC00747 | 0x07 | 0x47 | 0xC0 | payload=0x0000: success |
| PrepareStreamResult | 0xC002E1 | 0x02 | 0xE1 | 0xC0 | payload=0x00: OK |
| StreamResult | 0xC0028E | 0x02 | 0x8E | 0xC0 | varies |

### Telemetry Messages (Unsolicited)

| Name | Type (LE) | CmdSet | CmdId | Freq | Payload |
|------|-----------|--------|-------|------|---------|
| GimbalStatus | 0x050400 | 0x04 | 0x05 | ~20Hz | ~52B gyro/accel floats |
| Keepalive | 0x270400 | 0x04 | 0x27 | ~10Hz | 5B |
| CameraStatus | 0x800200 | 0x02 | 0x80 | ~10Hz | ~60B device state |
| CameraVariant | 0xDC0200 | 0x02 | 0xDC | ~2Hz | ~22B |
| GimbalAngle | 0x1C0400 | 0x04 | 0x1C | ~2Hz | 1B |
| GeneralStatus | 0xF10000 | 0x00 | 0xF1 | ~1Hz | 4B |
| GimbalSync | 0x380400 | 0x04 | 0x38 | ~1Hz | varies |
| DeviceInfo | 0x810040 | 0x00 | 0x81 | ~1Hz | varies |
| Battery | 0x020D00 | 0x0D | 0x02 | ~1Hz | varies |
| DeviceVersion | 0x740040 | 0x00 | 0x74 | rare | varies |

---

## PackString Encoding

Used for string fields (SSID, password, PIN, identifier):
```
[1B: string_length] [NB: string_bytes_utf8]
```

---

## Bugs Fixed in node-osmo

### 1. ByteBuf #byteOffset Initialization (CRITICAL)
**File**: `src/bytebuf.ts:70`
**Bug**: `#byteOffset` was initialized to `super.byteOffset` instead of `0`
**Impact**: ALL reads at wrong positions due to Node.js Buffer pool offset
**Fix**: Initialize to `0`

### 2. ByteBuf.from() byteLength Propagation (CRITICAL)
**File**: `src/bytebuf.ts:58-64`
**Bug**: DataView constructor didn't receive `source.byteLength` for Buffer views
**Impact**: DataView spanned entire 8KB Node.js Buffer pool instead of actual data
**Fix**: Pass `source.byteLength` to DataView constructor

### 3. ByteBuf getUint24() Offset (CRITICAL)
**File**: `src/bytebuf.ts:325-334`
**Bug**: `getUint24()` used `new Uint8Array(this.buffer)` without adding `super.byteOffset`
**Impact**: ALL message types decoded incorrectly (type=1794 for everything)
**Fix**: Add `super.byteOffset` when indexing into raw Uint8Array

### 4. Message ID Byte Order
**File**: `src/message.ts:55,97`
**Bug**: Message ID encoded/decoded as Little Endian
**Fix**: Changed to Big Endian (matching Wireshark captures and djictl)

### 5. Write Characteristic (CRITICAL)
**File**: `src/device.ts` — `writeValue()`
**Bug**: DUML messages written to **fff3** characteristic
**Fix**: Write to **fff5** using `writeWithoutResponse` (matching DJI Mimo app's actual behavior)

### 6. writeMessage Not Awaited
**File**: `src/device.ts:762`
**Bug**: `writeMessage()` was not async, didn't await the BLE write
**Fix**: Made async, all callers now await

### 7. manufacturerData Guard
**File**: `src/device.ts:235-238`
**Bug**: `onDiscover()` required `manufacturerData` in BLE advertisement
**Fix**: Removed guard — Osmo Pocket 3 doesn't include manufacturer data

---

## Tools

### Build & Run
```bash
npx tsc                    # Build TypeScript
node examples/connect-to-device.js <deviceId> <model> <ssid> <password> <rtmpUrl>
```

### BLE Utilities
```bash
# Reset macOS Bluetooth (if device stops advertising)
blueutil --power 0 && sleep 2 && blueutil --power 1

# Scan for DJI devices
node --input-type=module -e "
import noble from '@stoprocent/noble';
noble.on('stateChange', (s) => { if (s === 'poweredOn') noble.startScanningAsync([], true); });
noble.on('discover', (p) => {
  if (p.advertisement?.localName?.includes('Osmo'))
    console.log(p.advertisement.localName, p.id, 'RSSI:', p.rssi);
});
"
```

### Message Sniffer
```bash
npx tsx tools/message-sniffer.ts <device-id> <model>
```

### Gimbal Control (Interactive)
```bash
node tools/gimbal-control.mjs <device-id> [pin]
# Arrow keys / WASD = tilt/pan, R = recenter, 1-5 = switch method, +/- = speed
```

---

## References

- [xaionaro/reverse-engineering-dji](https://github.com/xaionaro/reverse-engineering-dji) — Wireshark captures and dissector for DJI Mimo BLE protocol
- Wireshark dissector: `dji-ble-message.c` in above repo — defines message type constants
- djictl (Go implementation) — reference for pairing flow and message construction
