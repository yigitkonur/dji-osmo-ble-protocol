# Patches for node-osmo

## `node-osmo-all-fixes.patch`

This patch contains all 7 bug fixes required to make [node-osmo](https://github.com/datagutt/node-osmo) work with the DJI Osmo Pocket 3.

### What's Fixed

| # | File | Bug | Fix |
|---|------|-----|-----|
| 1 | `src/bytebuf.ts` | `#byteOffset` initialized to `super.byteOffset` | Initialize to `0` |
| 2 | `src/bytebuf.ts` | `ByteBuf.from()` missing `byteLength` | Pass `source.byteLength` to DataView |
| 3 | `src/bytebuf.ts` | `getUint24()` wrong offset | Add `super.byteOffset` to raw array index |
| 4 | `src/message.ts` | Message ID encoded as LE | Changed to Big Endian |
| 5 | `src/device.ts` | DUML writes to fff3 | Write to fff5 with `writeWithoutResponse` |
| 6 | `src/device.ts` | `writeMessage()` not async | Made async, all callers await |
| 7 | `src/device.ts` | `manufacturerData` required for discovery | Removed guard |

Plus structural improvements:
- Added `waitingForDevice` state to pairing flow
- Added response type filtering to all state handlers
- Added TX hex dump logging
- Restructured pairing sequence to match DJI Mimo's actual flow

### How to Apply

```bash
# Clone and enter node-osmo
git clone https://github.com/datagutt/node-osmo
cd node-osmo

# Apply the patch
git apply path/to/node-osmo-all-fixes.patch

# Install dependencies and build
pnpm install
npx tsc

# Test
node examples/connect-to-device.js <device-id> 3 <wifi-ssid> <wifi-password> '<rtmp-url>'
```

### Files Changed

```
 examples/connect-to-device.js |   2 +-   (minor)
 package.json                  |   2 +-   (minor)
 src/bytebuf.ts                |  21 ++-- (3 critical bug fixes)
 src/device.ts                 | 459 +++   (major restructuring)
 src/message.ts                |  15 +-  (2 endianness fixes)
 5 files changed, 339 insertions(+), 160 deletions(-)
```

### Verified On

- **Device**: DJI Osmo Pocket 3 (model 3)
- **macOS**: Apple Silicon, Sequoia
- **Node.js**: v25.5.0
- **Noble**: `@stoprocent/noble` v1.18.2
