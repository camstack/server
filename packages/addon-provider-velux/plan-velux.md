# Velux (KLF-200) provider — status

**Live-capable since 2026-10-29.** The scaffold (2026-07-05) is complete: the client library is wired,
state is pushed, the session reconnects. The operator-facing description (pairing, the connection limit,
the certificate, the cover mapping) is in [README.md](./README.md).

## Shape

| Piece | File |
| --- | --- |
| Wire semantics (position 0..0xC800, 0 = open; actuator classes; rain; identity) | `src/velux-protocol.ts` |
| Gateway client over `klf-200-api` 8.x (one socket, house status monitor, keepalive, session watch) | `src/klf-gateway-client.ts` |
| Contract the manager and devices build against (specs substitute a fake) | `src/velux-client-contract.ts` |
| Connection lifecycle: bounded-backoff reconnect, offline-on-drop, push fan-out | `src/velux-integration-manager.ts` |
| Manager/snapshot sharing between the gateway and its children | `src/velux-node-resolver.ts` |
| Discovery candidates, native ids (serial-keyed) | `src/velux-discovery.ts` |
| Gateway (`DeviceType.Gateway`), window `Container`, `Cover` and rain `Sensor` devices | `src/devices/*` |
| Scripted TLS gateway used by the specs | `src/__tests__/fake-klf-gateway.ts` |

Existing caps only: `device-provider` + `device-adoption` + `connection-test` (integration), `reboot` + `device-admin-link` (gateway), `cover` (actuators), `flood` (rain sensor, role leak sensor).

## Library decision

`klf-200-api` (MiSchroe, MIT, TypeScript, three small runtime dependencies) at **8.x**, not 6.x: 6.0.1 pins the
VELUX certificate but requires the chain to be `authorized`, and the shared VELUX certificate expired on
2026-07-12, so 6.0.1 can no longer connect. 8.0.0 accepts exactly "expired AND fingerprint equals the pinned
certificate". The `disposablestack/auto` polyfill it imports is stubbed out in `vite.config.ts` (Node 24 has the
globals natively).

## Open

- The rain sensor subtype (window opener, subtype 1) follows the reference library's convention but was not
  verified against a real unit; a window whose rain sensor is not found needs its `TypeID` / `SubType` read from
  the gateway (`GW_GET_NODE_INFORMATION_NTF`).
- A dual roller shutter is one cover (two entities in Home Assistant).
- No live check against a real gateway has been made (the password is the operator's to enter).
