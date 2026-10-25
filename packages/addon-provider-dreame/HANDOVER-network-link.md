# Handover — `network-link` cap (device's own link + wifi signal) — for the Dreame agent

Branch: `main` (commit lands 2026-09-06 morning; publish follows). Record: `docs/decisions/adr-0369.md`.

## What exists
- `packages/types/src/capabilities/network-link.cap.ts` — cap `network-link` (NOT `connectivity`, which is
  the HA binary_sensor cap). Device-scoped, `deviceNative`, singleton, `status.kind: 'push'`, runtimeState
  restored, event `onStatusChanged`. Slice:
  `{ type: 'wifi'|'ethernet'|'cellular'|'unknown', signalPercent: number|null, rssiDbm?, ssid?, lastUpdated }`.
  `unknown` = not read yet (never a default wire); `signalPercent: null` = not known / not applicable (wire).
  Normalisers exported from `@camstack/types`: `signalPercentFromRssi(dBm)` (-100..-50 → 0..100),
  `signalPercentFromBars(bars, maxBars)`. Seed with `NETWORK_LINK_UNKNOWN`.
- Consumers already wired off the slice: HA export (`link` + `signal` diagnostic sensors), ui-library
  `useDeviceNetworkLink` + `NetworkLinkBadge` (device list pill, DeviceDetail header), viewer badge (card
  footer + detail toolbar, via the badge aggregate).
- Reference provider: Reolink — `packages/addon-provider-reolink/src/network-link-mapping.ts` (pure mapping +
  spec) and `registerNetworkLink` / `refreshNetworkLinkFromApi` in `reolink-camera.ts`.

## What Dreame needs to do (both the vacuum and the new camera device)
1. `this.ctx.registerNativeCap(networkLinkCapability, { getStatus: async ({deviceId}) => this.state.networkLink })`
   and seed `setCapSlice(networkLinkCapability, NETWORK_LINK_UNKNOWN)` when the slice is null.
2. On every property refresh that already runs (never a new poll): read the MIoT wifi RSSI / network
   property (the entity catalog lists `WIFI_SET` piid 9 — verify the siid and whether it carries rssi or ssid),
   map with `signalPercentFromRssi`, and `setCapSlice(networkLinkCapability, { type: 'wifi', signalPercent,
   rssiDbm, ssid?, lastUpdated: Date.now() })`. A robot is always wifi; still say `unknown` until the first read.
3. A pure `dreame-network-link-mapping.ts` with a spec (raw property → slice), mirroring the Reolink one.
4. No manifest change: device-native caps are registered per device, not declared in package.json.
5. Do NOT rename or extend `connectivity`.

Contact: this note was written by the session working on `main` from a worktree; the shared checkout is yours.
