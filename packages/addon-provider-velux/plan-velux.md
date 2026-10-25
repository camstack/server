# Velux (KLF-200) provider — plan & status

**Phase D scaffold — 2026-07-05.** Compiling skeleton, NO live onboarding, NO
client library wired yet.

## What this integration is

A Velux **KLF-200** gateway (@ `192.168.x.x` on the reference HA instance) is a
local bridge to io-homecontrol windows / roller shutters. The reference site has
**1 window + 1 shutter**:

- `finestra…` → HA `cover`, **device_class window**, position 100, supported_features 15
  (OPEN | CLOSE | SET_POSITION | STOP).
- `tapparella…` → HA `cover`, **device_class shutter**, position 0.
- 3 buttons: per-node identify ×2 + `klf_200_gateway_riavvia` (gateway reboot).

Positional only — **no tilt, no climate**. Identical cover shape to Rademacher.

## Mapping (existing caps only — nothing new needed)

| Source | CamStack DeviceType | Cap | Notes |
|---|---|---|---|
| KLF-200 gateway | `Hub` (`VeluxGatewayDevice`) | `device-discovery` | connection lives on the device (standalone mode) |
| window / shutter node | `Cover` (`VeluxCoverDevice`) | `cover` | `open`/`close`/`stop`/`setPosition`; `position` 0..100; `DeviceFeature.CoverPositionable`; no tilt |

`coverClass` (`window` \| `shutter`) is persisted on the cover config and carried
in the discovery candidate's `metadata.model`. It drives the `device_class` /
icon — the `cover` cap itself is class-agnostic.

**No new cap required.** The `cover` cap covers the full surface.

## Library status — CHOSEN: `klf-200-api` (existing, well-maintained)

**Chosen library: [`klf-200-api`](https://www.npmjs.com/package/klf-200-api)
v6.0.1** — MIT, TypeScript-native (ships `dist/types`), actively maintained
(last publish Sep 2025), dual ESM/CJS. It is the established KLF-200 client and
exposes `Connection` / `Gateway` / `Products` / `Product` / `Groups` / `Scenes`.
Declared in `package.json`. NOT installed/wired in this scaffold (Phase D is
scaffold-only and does not touch the monorepo lockfile); the device layer is
built against the local seam `src/velux-client-contract.ts` →
`VeluxGatewayClient` / `VeluxNode`, which is modelled on this library's API.

Wiring is the single remaining code step to go live:

1. `npm install` records `klf-200-api` (a later, deliberate install — not done
   here to avoid a concurrent lockfile edit).
2. Implement `VeluxGatewayClient` over `klf-200-api`: `Connection` for
   connect/auth, `Products`/`Product` for listNodes/getNode + open/close/stop/
   setPosition (`Product.setTargetPositionAsync` / `stopAsync`), `Gateway` for
   `reboot`. Map `Product.TypeID`/subtype → `coverClass` (`window` vs `shutter`);
   map the library's normalized position (0..1) → HA orientation (0 closed ..
   100 open).
3. Replace `defaultVeluxClientFactory` (currently throws "not wired") in
   `velux-integration-manager.ts`, or pass a real `makeClient` from `addon.ts`.
   **Nothing else changes** — the manager, resolver, discovery, and cover device
   are complete and type-checked.

## Remaining for a full build

- Wire the KLF-200 client library (above).
- Optional: expose the **gateway reboot** button (HA `klf_200_gateway_riavvia`).
  The contract already has `reboot()`; register the `reboot` cap (or a `button`
  accessory child with `DeviceRole`) on `VeluxGatewayDevice`. Left out of the
  scaffold to keep the surface minimal.
- The KLF-200 caps a small number of concurrent connections — the manager already
  holds ONE long-lived client per gateway (poll loop), which is the right shape;
  confirm the wrapper honours the single-session constraint.

## Remaining for Phase-C live onboard

- Deploy + create a gateway device with host `192.168.x.x` + web password.
- Verify discovery enumerates the window + shutter nodes; adopt both.
- Verify `open`/`close`/`setPosition` drive the real actuators and the polled
  `position` tracks live.
