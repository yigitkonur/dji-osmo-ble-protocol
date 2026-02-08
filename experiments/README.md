# Experiment Logs

Debug output from test runs of the node-osmo library against a DJI Osmo Pocket 3. Logs are gitignored (1.3MB of raw debug output). Regenerate by running the tool with `DEBUG=*`.

## Log Index (historical)

### `01-initial-bytebuf-fix.log`
**What**: First run after fixing ByteBuf bugs #1 and #2 (pool offset + byteLength)
**Result**: Messages parse successfully for the first time. State reaches `waitingForDevice`. But ByteBuf bug #3 (getUint24) still present — all types decode to 1794.
**Key lines**: Look for "State change" and "Received message"

### `04-false-positive-all-telemetry.log`
**What**: Run where state machine appeared to complete all stages
**Result**: FALSE POSITIVE — all 271 lines clean, but no actual streaming. State machine advanced on telemetry because response checks were disabled and all types decoded to same value.
**Key lines**: Notice only type=328704 everywhere, and no cmdSet=0x07 responses
**See**: [analysis/false-positive-analysis.md](../analysis/false-positive-analysis.md)

### `07-restructured-pairing.log`
**What**: After fixing getUint24 bug, restructuring pairing flow, adding response filtering
**Result**: Reaches state 4 (checkingIfPaired) but device doesn't respond. Zero cmdSet=0x07 messages. Message ID byte order was still wrong.
**Key lines**: "State change 3 -> 4", then no more state changes

### `12-manufacturer-data-fix.log`
**What**: After removing manufacturerData guard
**Result**: Device discovered and connected for first time with all fixes. Pairing request sent and write succeeds. But writeMessage wasn't async — DUML write to fff3 may not have completed. Still zero cmdSet=0x07 responses.
**Key lines**: "Write successful" appears after [0x01,0x00] but NOT after TX of DUML message

### `13-async-write-fix.log`
**What**: After making writeMessage async + await
**Result**: Write to fff3 confirmed successful. But device still ignores our command. 2,245 messages received, zero command responses.
**Key lines**: "Write successful" now appears after BOTH the pairing request AND the DUML TX

### `14-success-full-streaming.log` ⭐
**What**: After switching DUML writes from fff3 to fff5
**Result**: FULL SUCCESS. Device responds to SetPairingPIN, pairing completes, WiFi connects, streaming starts.
**States**: 0→1→2→3→4→5→6→7→8→10→11 (streaming!)
**Key lines**: 
- `Pairing response: flags=0xc0 payload=0002` — first ever cmdSet=0x07 response!
- `Pairing approved notification: payload=01`
- `WiFi setup response: payload=0000`
- `State change 10 -> 11` — streaming!

## How to Analyze

### Count message types
```bash
python3 -c "
import re
from collections import Counter
types = Counter()
with open('logs/14-success-full-streaming.log') as f:
    for line in f:
        m = re.search(r'type=(\d+)', line)
        if m:
            t = int(m.group(1))
            cmdSet = (t >> 8) & 0xff
            cmdId = (t >> 16) & 0xff
            flags = t & 0xff
            types[f'cmdSet=0x{cmdSet:02x} cmdId=0x{cmdId:02x} flags=0x{flags:02x}'] += 1
for k, v in types.most_common():
    print(f'{k}: {v}')
"
```

### Extract state transitions
```bash
grep "State change" logs/14-success-full-streaming.log
```

### Find command responses
```bash
grep -E "Pairing|WiFi|Stream|PrepareToLive" logs/14-success-full-streaming.log
```
