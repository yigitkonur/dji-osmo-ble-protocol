# Contributing

Contributions are welcome! This is a reverse engineering project, so any additional protocol findings, device compatibility reports, or bug fixes are especially valuable.

## How to Contribute

### Protocol Findings
If you've discovered new DUML commands, tested with a different DJI device, or captured Wireshark traces:

1. Fork this repo
2. Add your findings to the relevant document (PROTOCOL.md, analysis/, etc.)
3. Include raw evidence (hex dumps, Wireshark captures, log files)
4. Submit a PR with a clear description

### Device Compatibility
If you've tested with a device not listed in the compatibility table:

1. Run `tools/scan-device.mjs` and `tools/check-characteristics.mjs`
2. Note which characteristics exist and their properties
3. Test the pairing and streaming flow
4. Report results in a GitHub issue or PR

### Bug Fixes for node-osmo
If you find additional bugs in the node-osmo library:

1. Document the bug with a before/after hex dump
2. Add the fix to `patches/node-osmo-all-fixes.patch`
3. Update PROTOCOL.md if it affects protocol understanding

## Guidelines

- **Evidence over opinion**: Include hex dumps, log output, or Wireshark captures
- **Specify your device**: Always note the exact model and firmware version
- **One finding per PR**: Makes review easier
- **Update docs**: If your change affects the protocol understanding, update PROTOCOL.md
