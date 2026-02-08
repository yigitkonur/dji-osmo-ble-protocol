# The Reverse Engineering Journey

> How 7 independent bugs conspired to make a BLE protocol appear completely non-functional, and the systematic approach that uncovered each one.

## Background

The goal was simple: make a DJI Osmo Pocket 3 camera start an RTMP livestream, controlled entirely via Bluetooth Low Energy from a Mac, without the DJI Mimo app. The [node-osmo](https://github.com/datagutt/node-osmo) library existed as a starting point, but it didn't work with the Pocket 3.

What followed was a multi-day debugging odyssey that uncovered 7 independent bugs — each silently preventing the protocol from functioning, and each masking the others. At every stage, fixing one bug revealed the next, like peeling layers of an onion where each layer looks like the core.

## Timeline

### Phase 1: "Bad First Byte" — Everything Fails to Parse

**Symptom**: Every DUML message from the camera triggered "Bad first byte" errors. Messages started with `0x55` (correct magic byte) but parsing failed immediately.

**Investigation**: Added hex dumps of raw BLE notifications. Confirmed bytes started with `0x55`. Used `hexyl` to examine raw data. The ByteBuf reader was reading from completely wrong positions.

**Root Cause Discovery**: Node.js `Buffer.alloc()` and `Buffer.from()` use a shared 8KB memory pool. When you do:
```javascript
const buf = Buffer.from('55...', 'hex');
buf.buffer;       // → shared 8KB ArrayBuffer
buf.byteOffset;   // → e.g., 4096 (NOT 0!)
```

`ByteBuf` extended `DataView` and initialized its tracking offset to `super.byteOffset` (4096), then added that to every read position. A read at position 0 would actually read at position 4096 in the pool.

**Three separate bugs in ByteBuf**:
1. `#byteOffset` initialized to `super.byteOffset` instead of `0` → all reads at wrong positions
2. `ByteBuf.from()` didn't pass `source.byteLength` to DataView → DataView spanned 8KB pool
3. `getUint24()` used `new Uint8Array(this.buffer)` without adding `super.byteOffset` → type field always wrong

**Fix**: Three one-line changes in `src/bytebuf.ts`.

**Lesson**: When wrapping Node.js Buffers in DataView/TypedArray, ALWAYS account for `buffer.byteOffset` and `buffer.byteLength`. The Buffer pool is invisible until it breaks everything.

---

### Phase 2: "It Works!" — The False Positive (Experiment #4)

**Symptom**: After fixing ByteBuf, the state machine ran through all states: idle → discovering → connecting → pairing → streaming. 271 lines of clean output. Zero errors. 🎉

**But**: No actual RTMP stream appeared. `ffprobe` showed nothing on the RTMP server.

**Investigation**: Analyzed the message types being received. Expected to see WiFi responses (cmdSet=0x07), streaming responses (cmdSet=0x02/cmdId=0x8E), but found only telemetry:

```
cmdSet=0x04 cmdId=0x05: 578 messages  (gimbal status)
cmdSet=0x04 cmdId=0x27: 579 messages  (keepalive)
cmdSet=0x02 cmdId=0x80: 578 messages  (camera status)
```

Zero command responses. The state machine had been advancing on ANY incoming message because all response-checking code was commented out with `// return;`.

**Root Cause**: The `getUint24()` bug (ByteBuf bug #3) was still present. ALL message types decoded to `type=1794` (0x000702), making every message look like a pairing response. A gimbal telemetry message with payload `0x48` was interpreted as "pairing approved" (0x48 = 'H' in ASCII, but treated as a status byte).

**The Onion Effect**: Bug #1 and #2 were fixed, revealing that bug #3 made everything appear to work by making all messages look the same.

**Fix**: Fixed `getUint24()` to add `super.byteOffset`, added proper response type filtering to every state handler.

---

### Phase 3: "Why Won't It Respond?" — Message ID Byte Order

**Symptom**: With correct type parsing, it became clear the device received our SetPairingPIN command but never responded. Zero cmdSet=0x07 messages in any direction.

**Investigation**: Compared our TX bytes byte-by-byte with what the Go reference implementation (`djictl`) would produce:

```
Our TX:    55 22 04 ea 02 07 92 80 40 07 45 ...
djictl:    55 22 04 ea 02 07 80 92 40 07 45 ...
                              ^^^^^ swapped!
```

**Root Cause**: Message ID was encoded as Little Endian (`0x8092` → bytes `92 80`) but the protocol uses Big Endian (`0x8092` → bytes `80 92`).

**Fix**: One-line change each in `DjiMessage.encode()` and `DjiMessageWithData` parser.

**But**: This fix alone wasn't enough — the device still didn't respond. Three more bugs remained.

---

### Phase 4: "Device Not Found" — The Bluetooth Graveyard

**Symptom**: After the byte order fix, the device couldn't be discovered at all. BLE scans found 148 other devices but no Osmo.

**Investigation**: Even the user's phone couldn't find the camera. The camera's Bluetooth was completely dead.

**Root Cause**: Rapid reconnection attempts during debugging (connecting, crashing, reconnecting within seconds) pushed the camera's BLE stack into a bad state where it stopped advertising entirely.

**Fix**: 
1. Installed `blueutil` (`brew install blueutil`)
2. Reset Mac Bluetooth: `blueutil --power 0 && sleep 2 && blueutil --power 1`
3. Power-cycled the camera (hold power 5 seconds)

**Lesson**: DJI cameras need clean BLE disconnections. Always implement disconnect handlers and avoid rapid reconnection loops during development.

---

### Phase 5: "Invisible Device" — The manufacturerData Guard

**Symptom**: After Bluetooth recovery, noble found the device (confirmed by standalone scan), but the `onDiscover()` callback never proceeded.

**Investigation**: Added logging to discovery. The device was found with correct ID and name, but:
```javascript
const manufacturerData = peripheral.advertisement.manufacturerData;
// manufacturerData = null/undefined for Osmo Pocket 3!
if (!manufacturerData) return; // ← silently drops the device
```

**Root Cause**: The Osmo Pocket 3 doesn't include `manufacturerData` in its BLE advertisement. The guard was originally added for some other DJI device that does include it.

**Fix**: Removed the `manufacturerData` requirement from `onDiscover()`.

---

### Phase 6: "Write Succeeded but Nothing Happens" — Async Void

**Symptom**: Connection established, pairing request sent, DUML message logged as TX... but no "Write successful" log appeared after the TX, and no device response.

**Investigation**: 
```javascript
private writeMessage(message: DjiMessage): void {  // NOT async!
    const encoded = message.encode();
    console.debug(`dji-device: TX [${encoded.toString('hex')}]`);
    this.writeValue(encoded);  // Returns Promise but NOT awaited!
}
```

The state machine advanced to `checkingIfPaired` before the BLE write even completed.

**Fix**: Made `writeMessage` async, made all callers await it.

**Partial improvement**: After this fix, "Write successful" appeared in the log — but the device still didn't respond.

---

### Phase 7: "The Wrong Door" — fff5 vs fff3 ⭐

**Symptom**: Write confirmed successful at BLE level. CRC verified correct. Message structure byte-for-byte matches djictl. But the device ignores it completely. 2,200 messages received, zero are responses to our commands.

**This was the hardest bug to find.** Everything looked correct. The message format was right, the CRC was right, the write succeeded, but the device simply did not respond.

**The Breakthrough**: Deep-diving into xaionaro's Wireshark capture of the actual DJI Mimo app:

```
Bluetooth Attribute Protocol
    Opcode: Write Command (0x52)
    Handle: 0x0030 (Unknown: Car Connectivity Consortium, LLC)
        [Service UUID: Unknown (0xfff0)]
        [UUID: Car Connectivity Consortium, LLC (0xfff5)]    ← fff5!!!
    Value: 551104920208ffab40028e00011c003bc8
```

DJI Mimo writes DUML commands to **fff5**, not fff3.

**Verification**: Checked BLE characteristic properties:
```
fff3: ["read", "write", "notify", "indicate"]
fff4: ["read", "write", "notify", "indicate"]  
fff5: ["read", "writeWithoutResponse", "notify", "indicate"]
```

fff5 has `writeWithoutResponse` — matching the `Write Command (0x52)` opcode in the Wireshark capture (as opposed to `Write Request (0x12)` which is write-with-response).

**The naming confusion**: In the node-osmo codebase (and in djictl), fff3 was called "Sender" — implying it's where you SEND messages. But "Sender" in DJI's naming convention apparently means something else. The actual write target is fff5.

**Fix**: Changed `writeValue()` to write to `fff5Characteristic` with `writeWithoutResponse=true`.

**Result**: 🎉 First run after this fix — the device responded to SetPairingPIN. Full pairing flow completed. WiFi connected. RTMP streaming initiated. State machine reached state 11 (streaming).

---

## The Onion Model of Bugs

Each bug was necessary but not sufficient to prevent the system from working. They had to be fixed in roughly this order because each one masked the next:

```
Layer 7: fff5 characteristic ──────── Device ignores commands
Layer 6: Async write ─────────────── Write doesn't complete
Layer 5: manufacturerData guard ──── Device not discovered  
Layer 4: BLE stack crash ─────────── Camera disappears
Layer 3: Message ID byte order ──── Device rejects messages
Layer 2: getUint24 offset ────────── Wrong type decoding → false positives
Layer 1: ByteBuf pool offset ─────── All parsing fails
```

If you fixed layer 7 first but not layer 1, you'd still see parse failures. If you fixed layers 1-3 but not 5, you'd never find the device. The bugs had to be peeled away in sequence.

## Key Techniques Used

1. **Hex dump comparison**: Byte-for-byte comparison of our TX with djictl's expected output
2. **Message type census**: Counting all unique cmdSet/cmdId combinations to verify we see responses
3. **Wireshark capture analysis**: The DJI Mimo Wireshark captures from xaionaro were the ultimate source of truth
4. **Standalone verification scripts**: Tiny Node.js scripts to test BLE scanning, characteristic properties, CRC computation independently
5. **`blueutil`**: Essential for resetting macOS Bluetooth without rebooting
6. **Incremental logging**: Adding TX hex dumps, write confirmations, and response filtering logs at each stage

## What I'd Do Differently

1. **Start with Wireshark captures**: The fff5 discovery would have been immediate if I'd analyzed the Wireshark captures first
2. **Write characteristic property checks early**: A 5-line script showing fff3=write, fff5=writeWithoutResponse would have raised the flag immediately
3. **Don't trust naming conventions**: "Sender" doesn't mean "where you send to"
4. **Test each layer independently**: Instead of running the full state machine, test individual writes and verify the device echoes back
5. **Implement clean disconnect from day one**: Would have avoided the BLE stack crash

## Tools Created

- **BLE Scanner** (`tools/scan-device.mjs`): Finds DJI devices and shows their properties
- **Characteristic Inspector** (`tools/check-characteristics.mjs`): Dumps all service/characteristic properties
- **CRC Verifier** (`tools/verify-crc.mjs`): Validates CRC8 and CRC16 on hex message strings
