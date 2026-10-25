# Unraid provider — plan & status

**Phase D scaffold — 2026-07-05.** Compiling skeleton, NO live onboarding. The
client library EXISTS and is ready; this scaffold builds against a local contract
that mirrors it (one-file swap to go live — see "Library status").

## What this integration is

An Unraid server (reference HA instance: **"agent-a", ~216 entities**) exposes a
GraphQL API. CamStack adopts ONE **instance Container** per server; the array,
per-disk, per-docker-container and notification entities materialise as its
accessory children. `instanceMode: multiple` — many servers may be added; the
connection lives on the instance Hub device (standalone mode, the Reolink /
Velux / Ecowitt pattern).

Topology: **Hub** (connection) → adopts ONE **Container** (the instance) →
`getAccessoryChildren()` fans out one generic **entity child** per descriptor.
The `entities[]` identity list is derived by the Hub from each live snapshot and
re-persisted onto the Container via `applyDerivedSpec` (additive reconcile), so
new containers/disks appear and removed ones prune without re-adoption.

## Mapping (existing caps only — nothing new needed)

All entity children are a single generic class (`UnraidEntityDevice`) keyed by a
discriminated `kind`. A pure, unit-testable `unraid-mapping.ts` turns one
`UnraidSnapshot` into the descriptor list.

| Sub-kind | Entity | CamStack DeviceType | Cap | `kind` | Notes |
|---|---|---|---|---|---|
| **array** | array_state | `Sensor` | `enum-sensor` | enum | `ArrayState` literal (STARTED/STOPPED/…) |
| array | array_usage | `Sensor` | `numeric-sensor` | numeric | `%` (used/total). total/used/free also emitted as `array_total`/`array_used`/`array_free` in GiB |
| array | cpu_usage | `Sensor` | `numeric-sensor` | numeric | `%` (`systemMetricsCpu.percentTotal`) |
| array | cpu_temperature | `Sensor` | `temperature-sensor` | temperature | Celsius — emitted ONLY when the host reports it |
| array | cpu_power | `Sensor` | `numeric-sensor` (`W`) | numeric | role `PowerSensor` — emitted ONLY when reported |
| array | parity_check_progress | `Sensor` | `numeric-sensor` | numeric | `%` (0 when no check running) |
| array | active_notifications | `Sensor` | `numeric-sensor` | numeric | count of active warnings + alerts |
| array | array_started / config_valid / parity_valid / parity_check_running / disks_healthy | `Sensor` | `binary` | binary | derived from `ArrayState` + member-slot health |
| array | start_array / stop_array / start_parity_check / stop_parity_check | `Button` | `button` | button | `array.setState('START'\|'STOP')`, `array.parity.start(false)` / `array.parity.cancel()` |
| **disks** (per disk) | disk_N_usage | `Sensor` | `numeric-sensor` | numeric | `%` from array member `fsUsed/fsSize` (see "partial") |
| disks | disk_N_health | `Sensor` | `binary` | binary | **problem** semantics — `on` = UNhealthy |
| **docker** (per container) | container_N | `Switch` | `switch` | switch | `setState({on})` → `docker.start`/`docker.stop(id)` |
| docker | container_N_cpu / container_N_memory | `Sensor` | `numeric-sensor` | numeric | `%` from the `dockerContainerStats` subscription |
| docker | restart_container_N | `Button` | `button` | button | no atomic restart in the API → `stop` then `start` |
| **notifications** | tower_notifications | `EventEmitter` | `event-emitter` | event | fires `EventCategory.EventEmitted` (`notification_created`) on a new latest notification; count is also on `active_notifications` |

`DeviceRole` is stamped where it clarifies the icon (`NumericSensor`,
`TemperatureSensor`, `PowerSensor`, `EnumSensor`, `BinarySensor`).

**No new cap required.** Every entity maps onto an existing cap. Package.json
declares only `{ "name": "device-provider" }` (device-native caps are registered
at runtime via `ctx.registerNativeCap`).

### VM layer — DISABLED by default (not built)

The task calls for VM `switch` + lifecycle buttons but DISABLED by default. The
scaffold does **not** build the VM layer. The real lib has a `vms` domain
(`VmsDomain` / `VmDomain`); a future `vm_N` entity would be a `switch` (start/stop)
plus lifecycle buttons (pause/resume/forceStop), fanned out identically to docker.
Left out to keep the scaffold minimal and honest.

## Library status — EXISTS and ready: `@apocaliss92/node-unraid`

The client library is real and complete at `/Users/…/Git/node-unraid` (v1.0.0):
a typed `UnraidClient` over the Unraid GraphQL API with `.array` / `.docker` /
`.disks` / `.system` / `.notifications` domain namespaces (plus `vms` / `shares`
/ `ups` / `server`), HTTP reads + WebSocket subscriptions, constructed with
`{ host, port, https, apiKey }`. This scaffold's local contract
(`src/unraid-client-contract.ts` → `UnraidClientLike` + `UnraidSnapshot`) is
modelled directly on that API.

Three caveats / steps to go live:

1. **The lib exists and is ready** — no library research or authoring is needed.
2. **Name-scope caveat.** The local package's name is currently `node-unraid`
   (UNSCOPED), while `package.json` here declares the dependency as
   `@apocaliss92/node-unraid` (matching the sibling `@apocaliss92/nodewitt` /
   `@apocaliss92/nodedreame` scoping convention). Before wiring, EITHER publish
   the lib as `@apocaliss92/node-unraid`, OR adjust the dependency name here to
   `node-unraid`. It is declared in `devDependencies` (so a later `npm install`
   wires it) but is **not** imported in source — a hard
   `import … from '@apocaliss92/node-unraid'` would fail `tsc` with TS2307 today
   because it is not in this monorepo's node_modules and the lockfile must not be
   touched in this scaffold.
3. **Swapping the local contract for the real import is the only remaining code
   step.** Implement `UnraidClientLike` over the real `UnraidClient` (mostly a
   thin adapter — the domain shapes already line up; the addon composes one
   `UnraidSnapshot` per poll in `unraid-integration-manager.ts#fetchSnapshot`)
   and replace `defaultUnraidClientFactory` (currently throws "not wired") in
   `unraid-integration-manager.ts`, or pass a real `makeClient` from `addon.ts`.
   **Nothing else changes** — the manager, resolver, discovery, Container
   fan-out, entity children, and cap surface are complete and type-checked.

### Contract ↔ real-API notes for the wiring step

- `array.get()` → `UnraidArrayInfo` (state, `capacity.kilobytes`, `parityCheckStatus`,
  member `disks`/`caches`). Map member-slot `status`/`warning`/`critical` → `healthy`.
- `docker.list()` → containers; fold the `dockerContainerStats` subscription
  (`cpuPercent` / `memPercent`) into each container's live reading, and take the
  first of `names[]` (strip leading `/`) as the name.
- `system` → compose `UnraidCpuInfo`: `systemMetricsCpu.percentTotal` for `percent`;
  `tempC` / `powerW` have no first-class field in the read fragments used — leave
  `null` unless a sensor source is added (the mapping emits those entities only
  when non-null, so they simply won't appear).
- `notifications.warningsAndAlerts()` + `overview()` → `activeCount` + `latest`.

## Remaining for a full build

- **Wire the client library** (above) — the single remaining code step.
- **Complete the disks layer.** Per-disk usage/health is currently derived from
  the ARRAY member slots (`array.disks`, which carry `fsSize/fsUsed` + health).
  The lib also has a richer physical `disks` domain (SMART status, temperature,
  interface) — fold `disks.list()` in for `disk_N_temperature` + SMART-based
  health once live.
- **Build the VM layer** (disabled-by-default switch + lifecycle buttons) from
  the `vms` domain, fanned out like docker.
- Optional: use the GraphQL **subscriptions** (docker stats, cpu/memory metrics,
  notificationAdded) instead of the fixed poll for lower-latency updates — the
  manager already isolates the fetch path, so this is a localized change.

## Remaining for Phase-C live onboard

1. On the Unraid server, create an ADMIN-role API key:
   `unraid-api apikey --create` (name it, grant the array/docker/notifications
   read + control resources).
2. Deploy the addon; create an instance Hub device with the server host, port
   (443 https / 80 plain), HTTPS flag, and the API key.
3. Verify the Hub connects + polls; adopt the single instance Container.
4. Verify the entity children materialise: array metrics + binaries + buttons,
   per-docker switch/cpu/mem/restart, per-disk usage/health, and the
   notifications event emitter. Confirm switches drive real container start/stop
   and buttons drive array/parity actions.
