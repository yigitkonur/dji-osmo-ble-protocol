#!/usr/bin/env node
// ============================================================================
// DJI Osmo CLI — Interactive Gimbal Control Command
// ============================================================================
// Usage:
//   dji-osmo gimbal <device-id> [options]
//
//   Options:
//     --pin <pin>           Pairing PIN (default: 'love')
//     --angle <pitch> <yaw> Set angle and exit
//     --recenter            Recenter gimbal and exit
//     --mode <mode>         Set mode (follow|lock|fpv) and exit
//
//   Interactive mode (no options): keyboard control with live telemetry

import { OsmoConnection } from '../connection.mjs';
import readline from 'readline';

export async function runGimbal(args) {
  const deviceId = args[0];
  if (!deviceId) {
    console.error('Usage: dji-osmo gimbal <device-id> [options]');
    console.error('  --pin <pin>           Pairing PIN (default: love)');
    console.error('  --angle <pitch> <yaw> Set absolute angle');
    console.error('  --recenter            Recenter gimbal');
    console.error('  --mode <mode>         Set mode: follow, lock, fpv');
    process.exit(1);
  }

  // Parse options
  const pin = getOption(args, '--pin') || 'love';
  const angleOpt = getOption(args, '--angle', 2);
  const recenterOpt = args.includes('--recenter');
  const modeOpt = getOption(args, '--mode');

  const osmo = new OsmoConnection({ deviceId, pin });

  // Event handlers
  osmo.on('found', (info) => console.log(`📱 Found: ${info.name || 'DJI Device'} (RSSI: ${info.rssi})`));
  osmo.on('connected', () => console.log('🔗 Connected'));
  osmo.on('pairing', () => console.log('🔐 Pairing...'));
  osmo.on('paired', (info) => console.log(`  ✅ ${info.alreadyPaired ? 'Already paired' : 'Paired!'}`));
  osmo.on('pairingRequired', () => console.log('  ⏳ Approve pairing on device screen'));
  osmo.on('pairingTimeout', () => console.log('  ⚠️  Pairing timeout — continuing'));
  osmo.on('error', (err) => console.error(`❌ ${err.message}`));

  try {
    console.log(`\n🔍 Scanning for device ${deviceId}...\n`);
    await osmo.connect();
    console.log('📡 Ready\n');
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  // ── One-shot commands ────────────────────────────────────────────────────
  if (recenterOpt) {
    console.log('↺ Recentering gimbal...');
    await osmo.gimbal.recenter();
    await delay(1000);
    await osmo.disconnect();
    return;
  }

  if (modeOpt) {
    console.log(`🔧 Setting mode: ${modeOpt}`);
    await osmo.gimbal.setMode(modeOpt);
    await delay(500);
    await osmo.disconnect();
    return;
  }

  if (angleOpt) {
    const [pitch, yaw] = angleOpt.map(Number);
    console.log(`🎯 Setting angle: pitch=${pitch}° yaw=${yaw}°`);
    await osmo.gimbal.setAngle(pitch, 0, yaw);
    await delay(2000);
    await osmo.disconnect();
    return;
  }

  // ── Interactive mode ─────────────────────────────────────────────────────
  let speed = 30;
  let commandMethod = 'speed';
  let sentCount = 0;

  const methodNames = {
    speed: 'Speed (0x0C)',
    angle: 'Angle (0x0A)',
    abs:   'AbsAngle (0x14)',
    pwm:   'PWM (0x01)',
    move:  'Movement (0x15)',
  };

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

  function printStatus() {
    const s = osmo.gimbal.state;
    process.stdout.write(
      `\r  Gimbal: pitch=${s.pitch.toFixed(1)}° roll=${s.roll.toFixed(1)}° yaw=${s.yaw.toFixed(1)}°` +
      `  |  Speed: ${speed}  |  Method: ${methodNames[commandMethod]}  |  Sent: ${sentCount}   `
    );
  }

  async function sendCmd(pitchD, rollD, yawD) {
    const s = osmo.gimbal.state;
    sentCount++;
    switch (commandMethod) {
      case 'speed':
        await osmo.gimbal.setSpeed(pitchD * speed, yawD * speed, rollD * speed);
        break;
      case 'angle':
        await osmo.gimbal.setAngle(s.pitch + pitchD * speed, s.roll + rollD * speed, s.yaw + yawD * speed, speed);
        break;
      case 'abs':
        await osmo.gimbal.setAbsAngle(s.pitch + pitchD * speed, s.roll + rollD * speed, s.yaw + yawD * speed, 20);
        break;
      case 'pwm': {
        const center = 1024;
        const d = speed * 10;
        await osmo.gimbal.setPwm(center + pitchD * d, center + rollD * d, center + yawD * d);
        break;
      }
      case 'move':
        await osmo.gimbal.move(pitchD * speed, rollD * speed, yawD * speed);
        break;
    }
    printStatus();
  }

  printHelp();

  const statusInterval = setInterval(printStatus, 500);

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on('keypress', async (str, key) => {
    if (!key) return;

    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      clearInterval(statusInterval);
      console.log('\n\n👋 Disconnecting...');
      await osmo.disconnect();
      process.exit(0);
    }

    if (key.name === 'up' || key.name === 'w') await sendCmd(1, 0, 0);
    else if (key.name === 'down' || key.name === 's') await sendCmd(-1, 0, 0);
    else if (key.name === 'left' || key.name === 'a') await sendCmd(0, 0, -1);
    else if (key.name === 'right' || key.name === 'd') await sendCmd(0, 0, 1);
    else if (str === 'e') await sendCmd(0, 1, 0);
    else if (str === 'c') await sendCmd(0, -1, 0);
    else if (str === 'r') { console.log('\n  → Recentering...'); await osmo.gimbal.recenter(); printStatus(); }
    else if (str === '+' || str === '=') { speed = Math.min(180, speed + 5); printStatus(); }
    else if (str === '-') { speed = Math.max(1, speed - 5); printStatus(); }
    else if (str === '1') { commandMethod = 'speed'; printStatus(); }
    else if (str === '2') { commandMethod = 'angle'; printStatus(); }
    else if (str === '3') { commandMethod = 'abs';   printStatus(); }
    else if (str === '4') { commandMethod = 'pwm';   printStatus(); }
    else if (str === '5') { commandMethod = 'move';  printStatus(); }
    else if (str === 'h') printHelp();
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getOption(args, flag, count = 1) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  if (count === 1) return args[idx + 1];
  return args.slice(idx + 1, idx + 1 + count);
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
