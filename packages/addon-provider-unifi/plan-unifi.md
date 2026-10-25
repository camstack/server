# UniFi Network (controller) provider — plan & status

**Phase D scaffold — 2026-07-05.** Compiling skeleton, NO live onboarding, NO
client library wired yet. **LOCAL controller API only — no cameras.**
Camera streams are out of scope and never touched by this addon.

## What this integration is

A UniFi **Network controller** (UDM / UDM-Pro / UDM-SE / USX-Max / Cloud Key /
self-hosted Network app) is a local controller for a fleet of infra devices and
their associated network clients. The reference HA surface (network-only, cameras
absent) is **262 entities** across two families:

- **infra devices** — UDM/USX-Max gateway, U6-Pro APs, USW Lite-8-PoE switch,
  Flex-Mini switch, … Each exposes: sensors `cpu_utilization` (%),
  `cpu_temperature` (°C), `clients` (count), `state` (enum), `uptime`; a per-port
  PoE `switch` (`*_port_N_poe`); a `*_restart` button + per-port
  `*_port_N_power_cycle` buttons; a `*_led` on/off `light`/switch.
- **network clients** — `device_tracker.*` ×102, `state` `home` / `not_home`.

## The "switch as container" model (USER DIRECTIVE)

The controller is the **Hub**; **each infra device is a `Container`** that
EXPOSES its features as typed accessory children. Concretely:

- **controller** → `DeviceType.Hub` (`UnifiControllerDevice`), holds the
  connection (host / port / apiKey-or-username+password / site / poll interval);
  registers `device-discovery`.
- adopting an **infra device** → spawns a `DeviceType.Container`
  (`UnifiInfraDevice`) whose `getAccessoryChildren()` fans out — driven by a
  persisted `features[]` descriptor list on the Container config (mirrors
  ecowitt's `sensors[]` → children, additively reconciled on every poll via
  `applyDerivedSpec`):
  - per-PoE-port **PoE Switch** children (`switch` cap),
  - a device **LED Switch** child (`switch` cap),
  - a **restart Button** child + per-PoE-port **power-cycle Button** children
    (`button` cap),
  - **cpu / temp / clients / state / uptime Sensor** children (typed sensor caps).
- adopting a **network client** → spawns a `DeviceType.Presence` device
  (`presence` cap), a direct child of the controller Hub.

A **single generic child class** (`UnifiFeatureDevice`) services all four child
kinds via a discriminated config `kind` (`switch` | `button` | `sensor` |
`presence`); the discriminant selects the ONE cap it registers. This keeps the
fan-out compact and compiling while honouring the container model.

## Mapping (existing caps only — nothing new needed)

| Source | CamStack DeviceType | Cap | Notes |
|---|---|---|---|
| UniFi controller | `Hub` (`UnifiControllerDevice`) | `device-discovery` | connection lives on the device (standalone mode); enumerates infra + client candidates |
| infra device (switch/AP/gateway) | `Container` (`UnifiInfraDevice`) | — (fans out children) | `features[]` descriptor list → accessory children; `DeviceFeature.Resyncable` |
| per-port PoE | `Switch` (`UnifiFeatureDevice` kind `switch`, `poe`) | `switch` | `setState` → `setPortPoe(deviceId, portIdx, on)` |
| device LED | `Switch` (kind `switch`, `led`) | `switch` | `setState` → `setLed(deviceId, on)` |
| restart | `Button` (kind `button`, `restart`) | `button` | `press` → `restartDevice(deviceId)` |
| per-port power-cycle | `Button` (kind `button`, `power-cycle`) | `button` | `press` → `powerCyclePort(deviceId, portIdx)` |
| cpu_utilization (%) | `Sensor` (kind `sensor`, `cpu_utilization`) | `numeric-sensor` | `unit: '%'` |
| cpu_temperature (°C) | `Sensor` (kind `sensor`, `cpu_temperature`) | `temperature-sensor` | Celsius |
| clients (count) | `Sensor` (kind `sensor`, `clients`) | `numeric-sensor` | unitless |
| state (enum) | `Sensor` (kind `sensor`, `state`) | `enum-sensor` | online/offline/pending/… |
| uptime (s) | `Sensor` (kind `sensor`, `uptime`) | `numeric-sensor` | `unit: 's'` |
| network client (`device_tracker`) | `Presence` (`UnifiFeatureDevice` kind `presence`) | `presence` | `state` `home`/`not_home`, `location` = last IP |

**No new cap required.** `switch` / `button` / `numeric-sensor` /
`temperature-sensor` / `enum-sensor` / `presence` / `device-discovery` cover the
entire surface.

## Library status — NEEDS BUILDING (chosen lib identified)

**No client is wired yet**, but the library is chosen. The device layer here is
built against a local contract, `src/unifi-client-contract.ts` →
`UnifiControllerClient` / `UnifiInfraSnapshot` / `UnifiClientSnapshot`, whose
method + field shapes are modelled on the real API of the chosen lib so the
future factory is a THIN adapter.

- **Chosen lib = `node-unifi` v2.5.1** (MIT, Jens Maus / `jens-maus/node-unifi`,
  compatible with UniFi Controller **4.x–8.x**). Declared in this addon's
  `package.json` devDependencies (declared only — not installed here, root
  lockfile untouched). It has the most complete LOCAL controller API surface for
  this model: `login`, `getAccessDevices` (infra switches / APs / gateways),
  `getClientDevices` (device_tracker clients), PoE **port-override / port-conf**,
  `restartDevice`, and a `listen()` WebSocket event stream.
  - **CAVEAT: `node-unifi` ships NO bundled TypeScript types.** Wiring it will
    require either a small local **ambient `.d.ts`** for the surface used, OR the
    adapter narrowing at the boundary (validate the untyped JSON responses
    through zod before returning the typed snapshot). The local contract seam
    means `tsc --noEmit` stays 100% clean **today** (lib not installed).
  - **Typed alternative (fallback): `unifi-client`** — TS-native, so no ambient
    `.d.ts` needed; consider if `node-unifi`'s untyped surface proves painful.

### Wiring steps (the single remaining step to go live)

1. Install `node-unifi` and add a local ambient `.d.ts` (or narrow-at-boundary)
   for the used surface.
2. Implement `UnifiControllerClient` over it — map:
   - `getAccessDevices()` → `UnifiInfraSnapshot[]` (cpu / temp / clients / state /
     uptime / ports[{idx, poeOn, poeCapable}] / ledOn / online). PoE per-port
     state comes from the device's `port_table` / `port_overrides`.
   - `getClientDevices()` → `UnifiClientSnapshot[]` (mac / hostname / ip /
     connected / online).
   - `setPortPoe` / `powerCyclePort` → PoE port-override mutation on the parent
     switch's `port_overrides`.
   - `restartDevice` → `restartDevice(mac)`; `setLed` → device `led_override`.
3. Replace `defaultUnifiClientFactory` (currently throws "not wired") in
   `unifi-integration-manager.ts`, or pass a real `makeClient` from `addon.ts`.
   **Nothing else changes** — the manager, resolver, discovery, container fan-out,
   and feature device are complete.

## Remaining for a full build

- Wire the `node-unifi` client (above) + the ambient `.d.ts` (or `unifi-client`
  fallback).
- Optional: switch the poll loop to `node-unifi`'s `listen()` WebSocket event
  stream for lower-latency state (the manager currently POLLS on
  `pollIntervalMs`, which is the safe default). The resolver fan-out bus is
  already the right shape for a 100+-client push feed (no per-child listener).
- Optional: gateway WAN / uplink sensors, per-SSID client counts, firmware-update
  entities — out of the reference 262-entity scope for now.

## Remaining for Phase-C live onboard

- Deploy + create a controller device with host + port + API key (or username +
  password) + site.
- Verify discovery enumerates infra devices + ~102 clients; adopt a switch/AP as
  a Container and confirm its PoE / restart / LED / sensor children materialise.
- Verify `setState` toggles real PoE, `press` restarts / power-cycles, and the
  polled cpu/temp/clients/state/uptime track live.
- Adopt a client and verify `presence` flips `home` / `not_home`.
- **Confirm cameras stay untouched** — this addon only calls the
  Network controller API.
