// ============================================================================
// DJI DUML Protocol Constants
// ============================================================================

// ─── Device Addresses ────────────────────────────────────────────────────────
export const ADDR = {
  INVALID:      0x00,
  CAMERA:       0x01,
  APP:          0x02,
  FC:           0x03,
  GIMBAL:       0x04,
  CENTER_BOARD: 0x05,
  RC:           0x06,
  WIFI:         0x07,
  DM36X:        0x08,
};

// Target = sender | (receiver << 8), written as 2 bytes LE on wire
export const TARGET = {
  APP_TO_GIMBAL: ADDR.APP | (ADDR.GIMBAL << 8), // 0x0402
  APP_TO_WIFI:   ADDR.APP | (ADDR.WIFI << 8),   // 0x0702
  APP_TO_CAMERA: ADDR.APP | (ADDR.CAMERA << 8), // 0x0102
  APP_TO_FC:     ADDR.APP | (ADDR.FC << 8),      // 0x0302
};

// ─── Flags ───────────────────────────────────────────────────────────────────
export const FLAG = {
  REQUEST:  0x40,
  RESPONSE: 0xC0,
  NOTIFY:   0x00,
};

// ─── Command Sets ────────────────────────────────────────────────────────────
export const CMD_SET = {
  GENERAL:  0x00,
  CAMERA:   0x01,
  FC:       0x03,
  GIMBAL:   0x04,
  BATTERY:  0x06,
  WIFI:     0x07,
};

// ─── Gimbal Command IDs (CmdSet 0x04) ────────────────────────────────────────
export const GIMBAL_CMD = {
  CONTROL_PWM:    0x01, // PWM-style (363..1685, center=1024)
  PARAMS_GET:     0x05, // Push position telemetry (~20Hz)
  ANGLE_SET:      0x0A, // Absolute target angle
  SPEED_CTRL:     0x0C, // Angular velocity control
  ABS_ANGLE:      0x14, // Absolute angle with duration
  MOVEMENT:       0x15, // Incremental steps
  SET_MODE:       0x4C, // Reset and set mode
};

// ─── WiFi / Pairing Command IDs (CmdSet 0x07) ───────────────────────────────
export const WIFI_CMD = {
  SET_PAIRING_PIN: 0x45,
  PAIRING_APPROVED: 0x46,
  WIFI_CONNECT:    0x47,
};

// ─── Gimbal Modes ────────────────────────────────────────────────────────────
export const GIMBAL_MODE = {
  LOCK:   0,
  FOLLOW: 1,
  FPV:    2,
};

// ─── BLE UUIDs ───────────────────────────────────────────────────────────────
export const BLE = {
  SERVICE_UUID: 'fff0',
  CHAR_FFF3: 'fff3',
  CHAR_FFF4: 'fff4', // Pairing trigger + DUML notifications
  CHAR_FFF5: 'fff5', // DUML command writes (writeWithoutResponse)
};

// ─── CRC Parameters ─────────────────────────────────────────────────────────
export const CRC_PARAMS = {
  CRC8:  { width: 8,  poly: 0x31,   init: 0xEE,   xorOut: 0x00, refIn: true, refOut: true },
  CRC16: { width: 16, poly: 0x1021, init: 0x496C, xorOut: 0x0000, refIn: true, refOut: true },
};

// ─── Defaults ────────────────────────────────────────────────────────────────
export const DEFAULTS = {
  PIN: 'love',
  IDENTIFIER: '001749319286102',
  SCAN_TIMEOUT: 15000,
};
