// ============================================================================
// OsmoConnection — Top-level facade for DJI Osmo BLE control
// ============================================================================

import { EventEmitter } from 'events';
import { BleTransport } from './transport/ble.mjs';
import { GimbalController } from './controllers/gimbal.mjs';
import { buildMessage, packString } from './protocol/duml.mjs';
import { TARGET, FLAG, CMD_SET, WIFI_CMD, DEFAULTS } from './protocol/constants.mjs';

export class OsmoConnection extends EventEmitter {
  constructor(options = {}) {
    super();
    this._deviceId = options.deviceId;
    this._pin = options.pin || DEFAULTS.PIN;
    this._identifier = options.identifier || DEFAULTS.IDENTIFIER;
    this._transport = new BleTransport();
    this._battery = null;
    this._paired = false;

    // Create gimbal controller wired to transport
    this.gimbal = new GimbalController((data) => this._transport.write(data));

    // Forward transport events
    this._transport.on('connected', (info) => this.emit('connected', info));
    this._transport.on('disconnected', () => this.emit('disconnected'));
    this._transport.on('found', (info) => this.emit('found', info));
    this._transport.on('error', (err) => this.emit('error', err));

    // Route incoming messages
    this._transport.on('message', (msg) => {
      this._handleMessage(msg);
    });

    // Forward gimbal state
    this.gimbal.on('state', (state) => this.emit('gimbalState', state));
  }

  get isConnected() {
    return this._transport.isConnected;
  }

  get isPaired() {
    return this._paired;
  }

  get battery() {
    return this._battery;
  }

  get transport() {
    return this._transport;
  }

  // ─── Connect and pair ──────────────────────────────────────────────────────
  async connect(timeout) {
    await this._transport.connect(this._deviceId, timeout);

    // Wait for device to be ready
    await new Promise((res) => setTimeout(res, 1000));

    // Initiate pairing
    await this._pair();
  }

  // ─── Disconnect ────────────────────────────────────────────────────────────
  async disconnect() {
    return this._transport.disconnect();
  }

  // ─── Scan for devices ──────────────────────────────────────────────────────
  async scan(filter, timeout) {
    return this._transport.scan(filter, timeout);
  }

  // ─── Pairing flow ─────────────────────────────────────────────────────────
  async _pair() {
    // Trigger pairing mode
    await this._transport.writeFff4(Buffer.from([0x01, 0x00]));
    await new Promise((res) => setTimeout(res, 200));

    // Send pairing PIN
    const payload = Buffer.concat([
      packString(this._identifier),
      packString(this._pin),
    ]);
    const msg = buildMessage(TARGET.APP_TO_WIFI, FLAG.REQUEST, CMD_SET.WIFI, WIFI_CMD.SET_PAIRING_PIN, payload);
    await this._transport.write(msg);

    this.emit('pairing');

    // Wait for pairing response (up to 15s)
    for (let i = 0; i < 30 && !this._paired; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!this._paired) {
      this.emit('pairingTimeout');
    }

    return this._paired;
  }

  // ─── Route incoming messages to sub-controllers ────────────────────────────
  _handleMessage(msg) {
    if (!msg) return;

    // Gimbal telemetry
    if (msg.cmdSet === CMD_SET.GIMBAL) {
      this.gimbal.handleMessage(msg);
      return;
    }

    // Pairing responses
    if (msg.cmdSet === CMD_SET.WIFI) {
      if (msg.cmdId === WIFI_CMD.SET_PAIRING_PIN && (msg.flags & 0x80)) {
        const status = msg.payload.length >= 2 ? msg.payload[1] : msg.payload[0];
        if (status === 0x01) {
          this._paired = true;
          this.emit('paired', { alreadyPaired: true });
        } else if (status === 0x02) {
          this.emit('pairingRequired');
        }
      } else if (msg.cmdId === WIFI_CMD.PAIRING_APPROVED && msg.payload[0] === 0x01) {
        this._paired = true;
        this.emit('paired', { alreadyPaired: false });
      }
      return;
    }

    // Battery telemetry
    if (msg.cmdSet === CMD_SET.BATTERY && msg.payload.length >= 1) {
      this._battery = msg.payload[0];
      this.emit('battery', this._battery);
      return;
    }

    // Unhandled
    this.emit('rawMessage', msg);
  }
}
