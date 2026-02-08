// ============================================================================
// DJI DUML Protocol — Message Builder / Parser / CRC
// ============================================================================

import { CRC } from 'crc-full';
import { CRC_PARAMS } from './constants.mjs';

// ─── CRC calculators ─────────────────────────────────────────────────────────
const crc8Calc = new CRC(
  'CRC8', CRC_PARAMS.CRC8.width, CRC_PARAMS.CRC8.poly,
  CRC_PARAMS.CRC8.init, CRC_PARAMS.CRC8.xorOut,
  CRC_PARAMS.CRC8.refIn, CRC_PARAMS.CRC8.refOut
);
const crc16Calc = new CRC(
  'CRC16', CRC_PARAMS.CRC16.width, CRC_PARAMS.CRC16.poly,
  CRC_PARAMS.CRC16.init, CRC_PARAMS.CRC16.xorOut,
  CRC_PARAMS.CRC16.refIn, CRC_PARAMS.CRC16.refOut
);

export function computeCrc8(data) {
  return crc8Calc.compute(data);
}

export function computeCrc16(data) {
  return crc16Calc.compute(data);
}

// ─── Sequence counter ────────────────────────────────────────────────────────
let msgSeq = 0x0100;

export function resetSequence(val = 0x0100) {
  msgSeq = val;
}

// ─── Build a DUML message ────────────────────────────────────────────────────
// target: uint16 (sender | receiver<<8)
// flags:  0x40=request, 0xC0=response, 0x00=notify
// cmdSet: uint8
// cmdId:  uint8
// payload: Buffer (optional)
export function buildMessage(target, flags, cmdSet, cmdId, payload) {
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
  buf[off++] = computeCrc8(buf.slice(0, 3));

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
  const crc16 = computeCrc16(buf.slice(0, off));
  buf.writeUInt16LE(crc16, off);

  return buf;
}

// ─── Parse a single DUML message from a buffer ──────────────────────────────
export function parseMessage(data) {
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

// ─── Parse a stream buffer, yielding all complete messages ──────────────────
// Returns { messages: [...], remaining: Buffer }
export function parseStream(buffer) {
  const messages = [];

  while (buffer.length >= 13) {
    const magicIdx = buffer.indexOf(0x55);
    if (magicIdx === -1) {
      buffer = Buffer.alloc(0);
      break;
    }
    if (magicIdx > 0) {
      buffer = buffer.slice(magicIdx);
    }
    if (buffer.length < 4) break;

    const msgLen = buffer[1] | ((buffer[2] & 0x03) << 8);
    if (msgLen < 13 || msgLen > 1024) {
      buffer = buffer.slice(1);
      continue;
    }
    if (buffer.length < msgLen) break;

    const msgData = buffer.slice(0, msgLen);
    buffer = buffer.slice(msgLen);
    const msg = parseMessage(msgData);
    if (msg) messages.push(msg);
  }

  return { messages, remaining: buffer };
}

// ─── PackString helpers ──────────────────────────────────────────────────────
export function packString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  const out = Buffer.alloc(1 + strBuf.length);
  out[0] = strBuf.length;
  strBuf.copy(out, 1);
  return out;
}

export function unpackString(buf, offset = 0) {
  if (offset >= buf.length) return { value: '', bytesRead: 0 };
  const len = buf[offset];
  const value = buf.slice(offset + 1, offset + 1 + len).toString('utf8');
  return { value, bytesRead: 1 + len };
}
