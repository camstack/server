# VeSync provider — plan & status

**Phase D scaffold — 2026-07-05.** Compiling skeleton, NO live onboarding, NO
real credentials, NO adapter wired yet.

## What this integration is

A VeSync **cloud account** integration. The reference HA instance has **1 air
purifier** — "Purificatore area studio". VeSync is account / cloud (not local): the
addon signs in to the VeSync API with an email / password / region, lists the
account's devices, and polls + drives each purifier over HTTPS. There is no local
push channel, so the account is POLLED.

HA surface for the reference purifier:

- `fan(1)`: `preset_modes ["sleep"]`, `percentage_step 33.33`, plus `preset_mode`,
  `mode`, `child_lock`, `night_light`, `display_status` attributes.
- `select(1)`: `night_light_level` → `["off","dim","on"]`.
- `sensor(2)`: air quality · filter life.
- `switch(2)`: child lock · display.
- `update(1)`: firmware.

Modelled as a manually-created **account Hub** that adopts its purifiers as
**Fan** devices, each fanning out typed accessory children.

## Mapping (existing caps only — nothing new needed)

| Source | CamStack DeviceType | Cap(s) | Notes |
|---|---|---|---|
| VeSync account | `Hub` (`VeSyncAccountDevice`) | `device-discovery` | credentials live on the device (standalone mode) |
| air purifier | `Fan` (`VeSyncPurifierDevice`) | `switch` + `fan-control` | on/off on `switch`; speed (`percentage`, `percentageStep 33.33`) + preset (`availablePresets ["sleep"]`) on `fan-control` |
| child_lock | `Switch` accessory child (`VeSyncToggleDevice`) | `switch` | separate device — a device registers `switch` only ONCE |
| display | `Switch` accessory child (`VeSyncToggleDevice`) | `switch` | separate device — same reason |
| air quality | `Sensor` accessory child (`VeSyncSensorDevice`) | `air-quality-sensor` | PM2.5 → `pm25`, unit `µg/m³`; role `AirQualitySensor` |
| filter life | `Sensor` accessory child (`VeSyncSensorDevice`) | `numeric-sensor` | value + unit `%`; role `NumericSensor` |

The Fan registers `switch` + `fan-control` on ITSELF and declares
`getAccessoryChildren()` → the four accessory children above (fixed set of 4).

**Firmware `update(1)`** is not surfaced (no update cap in scope) — deferred.

## ⚠️ `night_light_level` select → NEW-CAP FOLLOW-UP (not in scaffold)

The HA `select` entity `night_light_level` (`off` / `dim` / `on`) is a 3-option
**settable enum**. There is NO clean existing cap for it:

- `switch` is boolean-only (can't carry 3 states).
- `numeric-sensor` / `air-quality-sensor` are read-only.
- `fan-control.preset` is the fan speed preset (`sleep`), a different axis.

**Decision: scaffold WITHOUT `night_light_level`.** It is intentionally left out of
the device layer. Surfacing it needs a NEW device-scoped cap — a
`select-control` (or `enum-control`) cap: a settable closed-list enum
(`options: string[]`, `selected: string`, `setSelected(value)`), driven as a
`DeviceType.Switch`/dedicated accessory child with `DeviceRole.SelectControl`.
`tsvesync`'s `setNightLight(mode)` is the client method it would call. **Create
that cap first, then wire it here.** (`child_lock` + `display` map cleanly to
`switch` and ARE scaffolded.)

## Library status — CHOSEN: `tsvesync` (declared, adapter pending)

**Chosen lib = `tsvesync` v1.0.68** (TypeScript-native, MIT, published Feb 2025,
actively maintained; ships `dist/index.d.ts`). Its API matches this purifier
exactly: login → device list, and air-purifier control for mode, fan speed, child
lock, display, night light, plus air-quality + filter-life readings.

`tsvesync` is DECLARED as a dependency in `package.json`
(`"tsvesync": "^1.0.68"`) but the adapter is **not wired yet**. The device layer
is built against a local contract, `src/vesync-client-contract.ts` →
`VeSyncClient` / `VeSyncPurifierSnapshot`, whose method / field names are modelled
on the real `tsvesync` API so the future factory is a THIN adapter:

| `VeSyncClient` seam | `tsvesync` |
|---|---|
| `login()` | `VeSync.login()` |
| `listDevices()` / `getDevice(cid)` | `VeSync.getDevices()` → air-purifier (`fans`) list |
| `setPower(cid, on)` | device `turnOn()` / `turnOff()` |
| `setFanSpeed(cid, pct)` | device `changeFanSpeed(level)` |
| `setMode(cid, mode)` | device `setMode('sleep' | 'manual' | 'auto')` |
| `setChildLock(cid, on)` | device `setChildLock(on)` |
| `setDisplay(cid, on)` | device `setDisplay(on)` |
| (`setNightLight` — deferred) | device `setNightLight(mode)` — needs `select-control` cap |

Wiring is the single remaining step to go live:

1. `npm install` (the dependency is declared; the orchestrator handles the
   lockfile — this scaffold declares ONLY, does not install).
2. Implement `VeSyncClient` over `tsvesync` in the `makeClient` factory — a thin
   adapter mapping the seam methods above onto the `tsvesync` device objects, and
   projecting each device into a `VeSyncPurifierSnapshot`
   (power / speedPercent / preset / availablePresets / childLock / display /
   airQuality / filterLifePercent / online). Percent ↔ level conversion uses
   `percentage_step 33.33` (3 speeds).
3. Replace `defaultVeSyncClientFactory` (currently throws "not wired") in
   `vesync-integration-manager.ts`, or pass a real `makeClient` from `addon.ts`.
   **Nothing else changes** — the manager, resolver, discovery, purifier device,
   and accessory children are complete and type-checked.

## Remaining for a full build

- Implement the `tsvesync` adapter (above).
- Add the `select-control` cap + wire `night_light_level` (above).
- Optional: surface the firmware `update` entity once an update cap exists.
- The VeSync cloud rate-limits polling — the manager already holds ONE long-lived
  session per account (poll loop, `pollIntervalMs` default 30s), which is the
  right shape; confirm `tsvesync` token refresh is handled inside the adapter.

## Remaining for Phase-C live onboard

- Deploy + create an account device with a real VeSync email / password / region.
- Verify discovery enumerates the "Purificatore area studio" purifier; adopt it.
- Verify the Fan `switch` (power) + `fan-control` (speed / `sleep` preset) drive
  the real device and the polled state tracks live.
- Verify the four accessory children appear: child-lock + display Switches
  (toggle live), air-quality + filter-life Sensors (read live).

## Dehumidifier — PROSPECTIVE (do NOT build yet)

VeSync also sells dehumidifiers, and `tsvesync` supports them. A dehumidifier
would map to a similar shape (a `DeviceType.Dehumidifier`/`Fan`-adjacent device
with humidity-target + fan-speed + tank/child-lock accessories). **Not built** —
it needs the physical device to confirm the exact HA/`tsvesync` surface before
modelling. Left as a future addition once one is available to test against.
