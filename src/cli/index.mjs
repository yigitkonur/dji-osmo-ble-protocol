#!/usr/bin/env node
// ============================================================================
// DJI Osmo CLI — Entry Point
// ============================================================================

import { runGimbal } from './cmd-gimbal.mjs';

const [,, command, ...args] = process.argv;

const COMMANDS = {
  gimbal: { fn: runGimbal, desc: 'Control gimbal (interactive or one-shot)' },
};

function printUsage() {
  console.log(`
  dji-osmo — DJI Osmo Pocket 3 BLE Control CLI

  Usage: dji-osmo <command> [options]

  Commands:
    gimbal <device-id>   Interactive gimbal control
      --pin <pin>          Pairing PIN (default: love)
      --angle <p> <y>      Set angle and exit
      --recenter           Recenter gimbal and exit
      --mode <mode>        Set mode (follow|lock|fpv) and exit

    scan [timeout]       Scan for DJI BLE devices

  Examples:
    dji-osmo gimbal abc123                        Interactive control
    dji-osmo gimbal abc123 --angle -30 90         Point pitch=-30° yaw=90°
    dji-osmo gimbal abc123 --recenter             Reset to center
    dji-osmo gimbal abc123 --mode lock            Lock mode
`);
}

async function main() {
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  const cmd = COMMANDS[command];
  if (!cmd) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  try {
    await cmd.fn(args);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

main();
