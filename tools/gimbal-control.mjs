#!/usr/bin/env node
// ============================================================================
// DJI Osmo Pocket 3 — Gimbal Control over BLE (DUML)
// STATUS: WIP — Commands send correctly but gimbal does not move. BLE alone
// may be insufficient; WiFi streaming connection may be required.
// ============================================================================
// Usage: node tools/gimbal-control.mjs <device-id>
//
// Connects to the Osmo via BLE, pairs (re-uses existing pairing), then
// provides interactive gimbal control via keyboard:
//
//   Arrow keys : pan (yaw) / tilt (pitch)
//   W/S        : tilt up / down
//   A/D        : pan left / right
//   R          : recenter gimbal
//   +/-        : increase/decrease speed
//   Q / Ctrl-C : quit
//
// Protocol reference:
//   CmdSet 0x04 (Gimbal) commands from dji-firmware-tools dissector.
//   Target: App(0x02) → Gimbal(0x04) = wire bytes [0x02, 0x04]
// ============================================================================

import noble from '@stoprocent/noble';
import { CRC } from 'crc-full';
import readline from 'readline';

// ─── Config ──────────────────────────────────────────────────────────────────
const deviceId = process.argv[2];
if (!deviceId) {
  console.error('Usage: node tools/gimbal-control.mjs <device-id>');
  console.error('Run scan-device.mjs first to find your device ID.');
  process.exit(1);
}

const PIN = process.argv[3] || 'love';
const IDENTIFIER = '001749319286102';

// ─── CRC helpers ─────────────────────────────────────────────────────────────
const crc8Calc = new CRC('CRC8', 8, 0x31, 0xEE, 0x00, true, true);
const crc16Calc = new CRC('CRC16', 16, 0x1021, 0x496C, 0x0000, true, true);

// ─── DUML addressing ─────────────────────────────────────────────────────────
// Source/Dest IDs:
//   0=Invalid, 1=Camera, 2=App, 3=FC, 4=Gimbal, 5=CenterBoard,
//   6=RC, 7=WiFi, 8=DM36x
const ADDR_APP    = 0x02;
const ADDR_GIMBAL = 0x04;
const ADDR_WIFI   = 0x07;

// Target = sender | (receiver << 8)  — written as 2 bytes LE on wire
const TARGET_APP_TO_GIMBAL = ADDR_APP | (ADDR_GIMBAL << 8); // 0x0402
const TARGET_APP_TO_WIFI   = ADDR_APP | (ADDR_WIFI << 8);   // 0x0702

// Flags
const FLAG_REQUEST  = 0x40;
const FLAG_RESPONSE = 0xC0;

// ─── DUML message builder ────────────────────────────────────────────────────
let msgSeq = 0x0100;

function buildDumlMessage(target, flags, cmdSet, cmdId, payload) {
  const payloadLen = payload ? payload.length : 0;
  const totalLen = 13 + payloadLen; // header(11) + payload + crc16(2)

  const buf = Buffer.alloc(totalLen);
  let off = 0;

  // Magic
  buf[off++] = 0x55;

  // Length (10-bit LE) + Version (6-bit)
  const version = 1;
  buf[off++] = totalLen & 0xFF;
  buf[off++] = ((totalLen >> 8) & 0x03) | (version << 2);

  // CRC8 of first 3 bytes
  buf[off++] = crc8Calc.compute(buf.slice(0, 3));

  // Target (2 bytes LE)
  buf.writeUInt16LE(target, off);
  off += 2;

  // Message ID (2 bytes BE)
  buf.writeUInt16BE(msgSeq++, off);
  off += 2;

  // Type: [flags, cmdSet, cmdId]
  buf[off++] = flags;
  buf[off++] = cmdSet;
  buf[off++] = cmdId;

  // Payload
  if (payload && payloadLen > 0) {
    payload.copy(buf, off);
    off += payloadLen;
  }

  // CRC16 of everything before crc16
  const crc16 = crc16Calc.compute(buf.slice(0, off));
  buf.writeUInt16LE(crc16, off);

  return buf;
}

function packString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  const out = Buffer.alloc(1 + strBuf.length);
  out[0] = strBuf.length;
  strBuf.copy(out, 1);
  return out;
}

// ─── Gimbal telemetry decoder (cmdSet=0x04, cmdId=0x05) ─────────────────────
// From dji-firmware-tools dissector:
//   offset 0: int16 LE — pitch (×0.1 deg, zero=forward, -900..470)
//   offset 2: int16 LE — roll  (×0.1 deg, zero=level, -410..410)
//   offset 4: int16 LE — yaw   (×0.1 deg, -1000=forward, -1460..-540)
//   offset 6: uint8    — mode/flags
//   ... more fields follow

function decodeGimbalParams(payload) {
  if (payload.length < 6) return null;
  return {
    pitch: payload.readInt16LE(0) / 10.0,
    roll:  payload.readInt16LE(2) / 10.0,
    yaw:   payload.readInt16LE(4) / 10.0,
  };
}

// ─── Gimbal control command builders ─────────────────────────────────────────

// CmdId 0x0C — Gimbal Ext Ctrl Accel / Speed Control
// Payload: 3× int16 LE (degrees × 10) + 1 uint8 flags = 7 bytes
// Sends angular speed for pitch, roll, yaw
function buildGimbalSpeedCmd(pitchSpeed, rollSpeed, yawSpeed) {
  const payload = Buffer.alloc(7);
  payload.writeInt16LE(Math.round(pitchSpeed * 10), 0); // degrees/s × 10
  payload.writeInt16LE(Math.round(rollSpeed * 10), 2);
  payload.writeInt16LE(Math.round(yawSpeed * 10), 4);
  payload[6] = 0x01; // flags: enable
  return buildDumlMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x0C, payload);
}

// CmdId 0x0A — Gimbal Ext Ctrl Degree / Angle Set
// Payload: 3× int16 LE (degrees × 10) + int16 LE (×100) + uint8 flags + uint8 speed = 10 bytes
function buildGimbalAngleCmd(pitch, roll, yaw, speed) {
  const payload = Buffer.alloc(10);
  payload.writeInt16LE(Math.round(pitch * 10), 0);
  payload.writeInt16LE(Math.round(roll * 10), 2);
  payload.writeInt16LE(Math.round(yaw * 10), 4);
  payload.writeInt16LE(Math.round((speed || 30) * 100), 6); // speed × 100
  payload[8] = 0x01; // flags
  payload[9] = Math.round((speed || 30) * 2000 / 100); // speed / 2000
  return buildDumlMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x0A, payload);
}

// CmdId 0x14 — Gimbal Abs Angle Control
// Payload: 3× int16 LE (degrees × 10) + uint8 flags + uint8 = 8 bytes
function buildGimbalAbsAngleCmd(pitch, roll, yaw, duration) {
  const payload = Buffer.alloc(8);
  payload.writeInt16LE(Math.round(pitch * 10), 0);
  payload.writeInt16LE(Math.round(roll * 10), 2);
  payload.writeInt16LE(Math.round(yaw * 10), 4);
  payload[6] = 0x07; // flags: enable all axes (bit0=pitch, bit1=roll, bit2=yaw)
  payload[7] = Math.min(255, Math.round((duration || 20) * 10)); // duration
  return buildDumlMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x14, payload);
}

// CmdId 0x01 — Gimbal Control (PWM-style, range 363..1685, center=1024)
function buildGimbalPwmCmd(pitch, roll, yaw) {
  const clamp = (v) => Math.max(363, Math.min(1685, Math.round(v)));
  const payload = Buffer.alloc(6);
  payload.writeUInt16LE(clamp(pitch), 0);
  payload.writeUInt16LE(clamp(roll), 2);
  payload.writeUInt16LE(clamp(yaw), 4);
  return buildDumlMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x01, payload);
}

// CmdId 0x15 — Gimbal Movement (incremental, int8 values)
function buildGimbalMoveCmd(pitch, roll, yaw) {
  const payload = Buffer.alloc(20);
  payload.writeInt8(Math.max(-127, Math.min(127, Math.round(pitch))), 0); // 0.04 deg steps
  payload.writeInt8(Math.max(-127, Math.min(127, Math.round(roll))), 1);
  payload.writeInt8(Math.max(-127, Math.min(127, Math.round(yaw))), 2);
  payload.writeInt8(0, 3); // 0.1 deg pitch
  payload.writeInt8(0, 4); // 0.1 deg roll
  payload.writeInt8(0, 5); // 0.1 deg yaw
  payload[6] = 50; // speed percent
  payload[7] = 50; // speed percent
  payload[8] = 0;  // roll adjust
  // bytes 9-19 = reserved (zero)
  return buildDumlMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x15, payload);
}

// CmdId 0x4C — Gimbal Reset And Set Mode
// Mode: 0=lock, 1=follow, 2=FPV
function buildGimbalSetModeCmd(mode, cmd) {
  const payload = Buffer.alloc(2);
  payload[0] = mode;
  payload[1] = cmd || 0;
  return buildDumlMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x4C, payload);
}

// ─── DUML message parser ─────────────────────────────────────────────────────
function parseDumlMessage(data) {
  if (data.length < 13 || data[0] !== 0x55) return null;
  const len = data[1] | ((data[2] & 0x03) << 8);
  if (data.length < len) return null;

  return {
    length: len,
    sender: data[4],
    receiver: data[5],
    msgId: data.readUInt16BE(6),
    flags: data[8],
    cmdSet: data[9],
    cmdId: data[10],
    payload: data.slice(11, len - 2),
    raw: data.slice(0, len),
  };
}

// ─── BLE connection & control ────────────────────────────────────────────────
let peripheral, fff4, fff5;
let gimbalState = { pitch: 0, roll: 0, yaw: 0 };
let speed = 30; // degrees per command
let connected = false;
let paired = false;
let receiveBuffer = Buffer.alloc(0);

async function writeToFff5(data) {
  if (!fff5) return;
  try {
    await new Promise((resolve, reject) => {
      fff5.write(data, true, (err) => err ? reject(err) : resolve());
    });
  } catch (e) {
    console.error(`Write error: ${e.message}`);
  }
}

function handleMessage(msg) {
  if (!msg) return;

  // Gimbal telemetry — cmdSet=0x04
  if (msg.cmdSet === 0x04) {
    // cmdId=0x05: Gimbal Params / Push Position (~20Hz)
    if (msg.cmdId === 0x05 && msg.payload.length >= 6) {
      const angles = decodeGimbalParams(msg.payload);
      if (angles) {
        gimbalState = angles;
      }
    }
    return;
  }

  // Pairing responses — cmdSet=0x07
  if (msg.cmdSet === 0x07) {
    if (msg.cmdId === 0x45 && (msg.flags & 0x80)) {
      // Pairing status response
      const status = msg.payload.length >= 2 ? msg.payload[1] : msg.payload[0];
      if (status === 0x01) {
        console.log('  ✅ Already paired');
        paired = true;
      } else if (status === 0x02) {
        console.log('  ⏳ Pairing required — approve on device screen');
      }
    } else if (msg.cmdId === 0x46 && msg.payload[0] === 0x01) {
      console.log('  ✅ Pairing approved!');
      paired = true;
    }
  }
}

function processIncomingData(data) {
  receiveBuffer = Buffer.concat([receiveBuffer, data]);

  while (receiveBuffer.length >= 13) {
    // Find magic byte
    const magicIdx = receiveBuffer.indexOf(0x55);
    if (magicIdx === -1) {
      receiveBuffer = Buffer.alloc(0);
      break;
    }
    if (magicIdx > 0) {
      receiveBuffer = receiveBuffer.slice(magicIdx);
    }
    if (receiveBuffer.length < 4) break;

    const msgLen = receiveBuffer[1] | ((receiveBuffer[2] & 0x03) << 8);
    if (msgLen < 13 || msgLen > 1024) {
      receiveBuffer = receiveBuffer.slice(1);
      continue;
    }
    if (receiveBuffer.length < msgLen) break;

    const msgData = receiveBuffer.slice(0, msgLen);
    receiveBuffer = receiveBuffer.slice(msgLen);
    const msg = parseDumlMessage(msgData);
    handleMessage(msg);
  }
}

async function connect() {
  console.log(`\n🔍 Scanning for device ${deviceId}...\n`);

  return new Promise((resolve, reject) => {
    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') noble.startScanningAsync([], false);
    });

    noble.on('discover', async (p) => {
      if (p.id !== deviceId) return;
      noble.stopScanning();
      peripheral = p;

      console.log(`📱 Found: ${p.advertisement?.localName || 'DJI Device'}`);
      console.log(`   RSSI: ${p.rssi} dBm\n`);

      try {
        await p.connectAsync();
        console.log('🔗 Connected');

        const services = await new Promise((res) =>
          p.discoverServices(['fff0'], (err, s) => res(s || []))
        );
        const svc = services[0];
        if (!svc) throw new Error('Service fff0 not found');

        const chars = await new Promise((res) =>
          svc.discoverCharacteristics([], (err, c) => res(c || []))
        );

        for (const c of chars) {
          if (c.uuid === 'fff4') fff4 = c;
          if (c.uuid === 'fff5') fff5 = c;
        }
        if (!fff4 || !fff5) throw new Error('Required characteristics not found');

        // Subscribe to notifications
        await new Promise((res) => fff5.subscribe((err) => res()));
        await new Promise((res) => fff4.subscribe((err) => res()));

        fff4.on('data', (data) => processIncomingData(data));
        fff5.on('data', (data) => processIncomingData(data));

        console.log('📡 Subscribed to notifications');
        connected = true;

        // Wait for first message from device
        await new Promise((res) => setTimeout(res, 1000));

        // Send pairing
        console.log('\n🔐 Pairing...');
        await new Promise((res) => fff4.write(Buffer.from([0x01, 0x00]), false, () => res()));
        await new Promise((res) => setTimeout(res, 200));

        const pairPayload = Buffer.concat([packString(IDENTIFIER), packString(PIN)]);
        const pairMsg = buildDumlMessage(TARGET_APP_TO_WIFI, FLAG_REQUEST, 0x07, 0x45, pairPayload);
        await writeToFff5(pairMsg);
        console.log('   Sent pairing request');

        // Wait for pairing to complete
        for (let i = 0; i < 30 && !paired; i++) {
          await new Promise((r) => setTimeout(r, 500));
        }

        if (!paired) {
          console.log('⚠️  Pairing timeout — continuing anyway (may already be paired)');
        }

        resolve();
      } catch (err) {
        reject(err);
      }
    });

    setTimeout(() => {
      if (!connected) reject(new Error('Device not found within 15s'));
    }, 15000);
  });
}

// ─── Interactive control ─────────────────────────────────────────────────────
let commandMethod = 'speed'; // 'speed', 'angle', 'abs', 'pwm', 'move'
let sentCount = 0;
let lastCommandTime = 0;

function printStatus() {
  const methodNames = {
    speed: 'Speed (0x0C)',
    angle: 'Angle (0x0A)',
    abs: 'AbsAngle (0x14)',
    pwm: 'PWM (0x01)',
    move: 'Movement (0x15)',
  };
  process.stdout.write(
    `\r  Gimbal: pitch=${gimbalState.pitch.toFixed(1)}° roll=${gimbalState.roll.toFixed(1)}° yaw=${gimbalState.yaw.toFixed(1)}°` +
    `  |  Speed: ${speed}  |  Method: ${methodNames[commandMethod]}  |  Sent: ${sentCount}   `
  );
}

async function sendGimbalCommand(pitchDelta, rollDelta, yawDelta) {
  let msg;
  switch (commandMethod) {
    case 'speed':
      msg = buildGimbalSpeedCmd(pitchDelta * speed, rollDelta * speed, yawDelta * speed);
      break;
    case 'angle':
      msg = buildGimbalAngleCmd(
        gimbalState.pitch + pitchDelta * speed,
        gimbalState.roll + rollDelta * speed,
        gimbalState.yaw + yawDelta * speed,
        speed
      );
      break;
    case 'abs':
      msg = buildGimbalAbsAngleCmd(
        gimbalState.pitch + pitchDelta * speed,
        gimbalState.roll + rollDelta * speed,
        gimbalState.yaw + yawDelta * speed,
        20
      );
      break;
    case 'pwm': {
      const center = 1024;
      const delta = speed * 10;
      msg = buildGimbalPwmCmd(
        center + pitchDelta * delta,
        center + rollDelta * delta,
        center + yawDelta * delta
      );
      break;
    }
    case 'move':
      msg = buildGimbalMoveCmd(pitchDelta * speed, rollDelta * speed, yawDelta * speed);
      break;
  }

  sentCount++;
  lastCommandTime = Date.now();
  console.log(`\n  → TX [${commandMethod}]: pitch=${(pitchDelta*speed).toFixed(1)} roll=${(rollDelta*speed).toFixed(1)} yaw=${(yawDelta*speed).toFixed(1)}`);
  console.log(`    hex: ${msg.toString('hex')}`);
  await writeToFff5(msg);
  printStatus();
}

async function recenterGimbal() {
  console.log('\n  → Recentering gimbal...');
  let msg;
  switch (commandMethod) {
    case 'abs':
      msg = buildGimbalAbsAngleCmd(0, 0, 0, 30);
      break;
    case 'angle':
      msg = buildGimbalAngleCmd(0, 0, 0, 30);
      break;
    default:
      msg = buildGimbalAbsAngleCmd(0, 0, 0, 30);
      break;
  }
  sentCount++;
  console.log(`    hex: ${msg.toString('hex')}`);
  await writeToFff5(msg);
}

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              DJI Osmo Pocket 3 — Gimbal Control             ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Arrow keys / WASD : Tilt (pitch) and Pan (yaw)             ║
║  E/C               : Roll left / right                       ║
║  R                 : Recenter gimbal to 0,0,0                ║
║  +/-               : Increase/decrease speed (current: ${String(speed).padStart(3)})   ║
║  1-5               : Switch command method                   ║
║     1 = Speed Control (0x0C) — angular velocity              ║
║     2 = Angle Set (0x0A) — absolute target angle             ║
║     3 = Abs Angle (0x14) — absolute with duration            ║
║     4 = PWM (0x01) — raw PWM 363..1685                       ║
║     5 = Movement (0x15) — incremental steps                  ║
║  H                 : Show this help                          ║
║  Q / Ctrl-C        : Quit                                    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
}

async function main() {
  try {
    await connect();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  printHelp();

  // Start gimbal status display
  const statusInterval = setInterval(printStatus, 500);

  // Set up raw mode for keyboard input
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on('keypress', async (str, key) => {
    if (!key) return;

    // Quit
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      clearInterval(statusInterval);
      console.log('\n\n👋 Disconnecting...');
      try {
        if (peripheral) await peripheral.disconnectAsync();
      } catch (e) { /* ignore */ }
      process.exit(0);
    }

    // Movement controls
    if (key.name === 'up' || key.name === 'w') {
      await sendGimbalCommand(1, 0, 0); // pitch up
    } else if (key.name === 'down' || key.name === 's') {
      await sendGimbalCommand(-1, 0, 0); // pitch down
    } else if (key.name === 'left' || key.name === 'a') {
      await sendGimbalCommand(0, 0, -1); // yaw left
    } else if (key.name === 'right' || key.name === 'd') {
      await sendGimbalCommand(0, 0, 1); // yaw right
    } else if (str === 'e') {
      await sendGimbalCommand(0, 1, 0); // roll left
    } else if (str === 'c') {
      await sendGimbalCommand(0, -1, 0); // roll right
    }

    // Recenter
    else if (str === 'r') {
      await recenterGimbal();
    }

    // Speed adjust
    else if (str === '+' || str === '=') {
      speed = Math.min(180, speed + 5);
      printStatus();
    } else if (str === '-') {
      speed = Math.max(1, speed - 5);
      printStatus();
    }

    // Method switch
    else if (str === '1') { commandMethod = 'speed'; printStatus(); }
    else if (str === '2') { commandMethod = 'angle'; printStatus(); }
    else if (str === '3') { commandMethod = 'abs';   printStatus(); }
    else if (str === '4') { commandMethod = 'pwm';   printStatus(); }
    else if (str === '5') { commandMethod = 'move';  printStatus(); }

    // Help
    else if (str === 'h') { printHelp(); }
  });
}

main().catch(console.error);
