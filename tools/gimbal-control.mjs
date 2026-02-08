#!/usr/bin/env node
// ============================================================================
// DJI Osmo Pocket 3 — Gimbal Control (standalone tool)
// STATUS: WIP — Commands send correctly but gimbal does not move over BLE.
//         WiFi streaming connection may be required for motor control.
// ============================================================================
// Usage: node tools/gimbal-control.mjs <device-id>
//
// This is a thin wrapper around src/cli/cmd-gimbal.mjs.
// See src/ for the modular protocol implementation.

import { runGimbal } from '../src/cli/cmd-gimbal.mjs';

const deviceId = process.argv[2];
if (!deviceId) {
  console.error('Usage: node tools/gimbal-control.mjs <device-id>');
  console.error('\nRun `node tools/scan-device.mjs` to find your device ID.');
  process.exit(1);
}

runGimbal(process.argv.slice(2)).catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
