// ============================================================================
// BLE Transport Layer for DJI Osmo
// ============================================================================

import { EventEmitter } from 'events';
import noble from '@stoprocent/noble';
import { parseStream } from '../protocol/duml.mjs';
import { BLE, DEFAULTS } from '../protocol/constants.mjs';

export class BleTransport extends EventEmitter {
  constructor() {
    super();
    this._peripheral = null;
    this._fff4 = null;
    this._fff5 = null;
    this._receiveBuffer = Buffer.alloc(0);
    this._connected = false;
  }

  get isConnected() {
    return this._connected;
  }

  get peripheral() {
    return this._peripheral;
  }

  // ─── Scan for DJI devices ──────────────────────────────────────────────────
  async scan(filter, timeout = DEFAULTS.SCAN_TIMEOUT) {
    const found = new Map();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        noble.stopScanning();
        noble.removeAllListeners('discover');
        resolve([...found.values()]);
      }, timeout);

      noble.on('stateChange', (state) => {
        if (state === 'poweredOn') noble.startScanningAsync([], true);
      });

      noble.on('discover', (p) => {
        const name = p.advertisement?.localName || '';
        const match = filter
          ? filter(name, p)
          : (name.includes('Osmo') || name.includes('DJI') || name.includes('Pocket'));

        if (match && !found.has(p.id)) {
          found.set(p.id, {
            id: p.id,
            name,
            rssi: p.rssi,
            peripheral: p,
          });
          this.emit('discovered', found.get(p.id));
        }
      });

      if (noble.state === 'poweredOn') {
        noble.startScanningAsync([], true);
      }
    });
  }

  // ─── Connect to a specific device ─────────────────────────────────────────
  async connect(deviceId, timeout = DEFAULTS.SCAN_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        noble.stopScanning();
        noble.removeAllListeners('discover');
        reject(new Error(`Device ${deviceId} not found within ${timeout / 1000}s`));
      }, timeout);

      const onDiscover = async (p) => {
        if (p.id !== deviceId) return;
        clearTimeout(timer);
        noble.stopScanning();
        noble.removeListener('discover', onDiscover);

        try {
          this._peripheral = p;
          this.emit('found', { id: p.id, name: p.advertisement?.localName, rssi: p.rssi });

          await p.connectAsync();

          const services = await new Promise((res) =>
            p.discoverServices([BLE.SERVICE_UUID], (err, s) => res(s || []))
          );
          const svc = services[0];
          if (!svc) throw new Error(`Service ${BLE.SERVICE_UUID} not found`);

          const chars = await new Promise((res) =>
            svc.discoverCharacteristics([], (err, c) => res(c || []))
          );
          for (const c of chars) {
            if (c.uuid === BLE.CHAR_FFF4) this._fff4 = c;
            if (c.uuid === BLE.CHAR_FFF5) this._fff5 = c;
          }
          if (!this._fff4 || !this._fff5) {
            throw new Error('Required BLE characteristics (fff4/fff5) not found');
          }

          // Subscribe to notifications
          await new Promise((res) => this._fff5.subscribe((err) => res()));
          await new Promise((res) => this._fff4.subscribe((err) => res()));

          this._fff4.on('data', (data) => this._processIncoming(data));
          this._fff5.on('data', (data) => this._processIncoming(data));

          this._connected = true;

          p.once('disconnect', () => {
            this._connected = false;
            this.emit('disconnected');
          });

          this.emit('connected', { id: p.id, name: p.advertisement?.localName });
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      noble.on('discover', onDiscover);

      noble.on('stateChange', (state) => {
        if (state === 'poweredOn') noble.startScanningAsync([], false);
      });

      if (noble.state === 'poweredOn') {
        noble.startScanningAsync([], false);
      }
    });
  }

  // ─── Write raw data to fff5 ────────────────────────────────────────────────
  async write(data) {
    if (!this._fff5) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      this._fff5.write(data, true, (err) => err ? reject(err) : resolve());
    });
  }

  // ─── Write raw data to fff4 (for pairing trigger) ─────────────────────────
  async writeFff4(data) {
    if (!this._fff4) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      this._fff4.write(data, false, (err) => err ? reject(err) : resolve());
    });
  }

  // ─── Disconnect ────────────────────────────────────────────────────────────
  async disconnect() {
    if (this._peripheral) {
      try {
        await this._peripheral.disconnectAsync();
      } catch (e) { /* ignore */ }
    }
    this._connected = false;
  }

  // ─── Process incoming BLE data ─────────────────────────────────────────────
  _processIncoming(data) {
    this._receiveBuffer = Buffer.concat([this._receiveBuffer, data]);
    const { messages, remaining } = parseStream(this._receiveBuffer);
    this._receiveBuffer = remaining;

    for (const msg of messages) {
      this.emit('message', msg);
    }
  }
}
