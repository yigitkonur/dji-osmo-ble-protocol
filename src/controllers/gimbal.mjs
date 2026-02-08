// ============================================================================
// Gimbal Controller — High-level gimbal API
// STATUS: WIP — Protocol is correct (verified against dissectors) but the
// Osmo Pocket 3 silently ignores all gimbal commands over BLE. 20+ command
// variations tested with zero ACKs. Gimbal control likely requires an active
// WiFi connection (streaming state) rather than BLE-only. Telemetry (0x05)
// streams fine over BLE.
// ============================================================================

import { EventEmitter } from 'events';
import { buildMessage } from '../protocol/duml.mjs';
import { TARGET, FLAG, CMD_SET, GIMBAL_CMD, GIMBAL_MODE } from '../protocol/constants.mjs';

export class GimbalController extends EventEmitter {
  // send: async (buffer) => void — callback to write a DUML message
  constructor(send) {
    super();
    this._send = send;
    this._state = { pitch: 0, roll: 0, yaw: 0, mode: null };
  }

  get state() {
    return { ...this._state };
  }

  // ─── Speed control (CmdId 0x0C) — angular velocity ────────────────────────
  async setSpeed(pitchSpeed = 0, yawSpeed = 0, rollSpeed = 0) {
    const payload = Buffer.alloc(7);
    payload.writeInt16LE(Math.round(pitchSpeed * 10), 0);
    payload.writeInt16LE(Math.round(rollSpeed * 10), 2);
    payload.writeInt16LE(Math.round(yawSpeed * 10), 4);
    payload[6] = 0x01; // enable
    const msg = buildMessage(TARGET.APP_TO_GIMBAL, FLAG.REQUEST, CMD_SET.GIMBAL, GIMBAL_CMD.SPEED_CTRL, payload);
    return this._send(msg);
  }

  // ─── Angle set (CmdId 0x0A) — absolute target angle ───────────────────────
  async setAngle(pitch, roll, yaw, speed = 30) {
    const payload = Buffer.alloc(10);
    payload.writeInt16LE(Math.round(pitch * 10), 0);
    payload.writeInt16LE(Math.round(roll * 10), 2);
    payload.writeInt16LE(Math.round(yaw * 10), 4);
    payload.writeInt16LE(Math.round(speed * 100), 6);
    payload[8] = 0x01; // flags
    payload[9] = Math.round(speed * 2000 / 100);
    const msg = buildMessage(TARGET.APP_TO_GIMBAL, FLAG.REQUEST, CMD_SET.GIMBAL, GIMBAL_CMD.ANGLE_SET, payload);
    return this._send(msg);
  }

  // ─── Absolute angle with timing (CmdId 0x14) ──────────────────────────────
  async setAbsAngle(pitch, roll, yaw, duration = 20) {
    const payload = Buffer.alloc(8);
    payload.writeInt16LE(Math.round(pitch * 10), 0);
    payload.writeInt16LE(Math.round(roll * 10), 2);
    payload.writeInt16LE(Math.round(yaw * 10), 4);
    payload[6] = 0x07; // enable all axes
    payload[7] = Math.min(255, Math.round(duration * 10));
    const msg = buildMessage(TARGET.APP_TO_GIMBAL, FLAG.REQUEST, CMD_SET.GIMBAL, GIMBAL_CMD.ABS_ANGLE, payload);
    return this._send(msg);
  }

  // ─── Incremental movement (CmdId 0x15) ────────────────────────────────────
  async move(pitchDelta, rollDelta = 0, yawDelta = 0) {
    const payload = Buffer.alloc(20);
    payload.writeInt8(Math.max(-127, Math.min(127, Math.round(pitchDelta))), 0);
    payload.writeInt8(Math.max(-127, Math.min(127, Math.round(rollDelta))), 1);
    payload.writeInt8(Math.max(-127, Math.min(127, Math.round(yawDelta))), 2);
    payload[6] = 50; // speed percent
    payload[7] = 50;
    const msg = buildMessage(TARGET.APP_TO_GIMBAL, FLAG.REQUEST, CMD_SET.GIMBAL, GIMBAL_CMD.MOVEMENT, payload);
    return this._send(msg);
  }

  // ─── PWM control (CmdId 0x01) — range 363..1685, center=1024 ──────────────
  async setPwm(pitch = 1024, roll = 1024, yaw = 1024) {
    const clamp = (v) => Math.max(363, Math.min(1685, Math.round(v)));
    const payload = Buffer.alloc(6);
    payload.writeUInt16LE(clamp(pitch), 0);
    payload.writeUInt16LE(clamp(roll), 2);
    payload.writeUInt16LE(clamp(yaw), 4);
    const msg = buildMessage(TARGET.APP_TO_GIMBAL, FLAG.REQUEST, CMD_SET.GIMBAL, GIMBAL_CMD.CONTROL_PWM, payload);
    return this._send(msg);
  }

  // ─── Recenter to 0,0,0 ────────────────────────────────────────────────────
  async recenter() {
    return this.setAbsAngle(0, 0, 0, 30);
  }

  // ─── Stop (zero velocity) ─────────────────────────────────────────────────
  async stop() {
    return this.setSpeed(0, 0, 0);
  }

  // ─── Set mode: 'follow', 'lock', 'fpv' (CmdId 0x4C) ──────────────────────
  async setMode(mode) {
    const modeMap = { lock: GIMBAL_MODE.LOCK, follow: GIMBAL_MODE.FOLLOW, fpv: GIMBAL_MODE.FPV };
    const modeVal = typeof mode === 'string' ? modeMap[mode] : mode;
    if (modeVal === undefined) throw new Error(`Unknown gimbal mode: ${mode}`);

    const payload = Buffer.alloc(2);
    payload[0] = modeVal;
    payload[1] = 0;
    const msg = buildMessage(TARGET.APP_TO_GIMBAL, FLAG.REQUEST, CMD_SET.GIMBAL, GIMBAL_CMD.SET_MODE, payload);
    return this._send(msg);
  }

  // ─── Handle incoming DUML message (call from transport layer) ──────────────
  handleMessage(msg) {
    if (!msg || msg.cmdSet !== CMD_SET.GIMBAL) return;

    // Gimbal position telemetry (cmdId=0x05, ~20Hz push)
    if (msg.cmdId === GIMBAL_CMD.PARAMS_GET && msg.payload.length >= 6) {
      this._state.pitch = msg.payload.readInt16LE(0) / 10.0;
      this._state.roll = msg.payload.readInt16LE(2) / 10.0;
      this._state.yaw = msg.payload.readInt16LE(4) / 10.0;
      if (msg.payload.length >= 7) {
        this._state.mode = msg.payload[6];
      }
      this.emit('state', this.state);
    }
  }
}
