---
title: Bosch Home Connect — how the local protocol is modelled
covers:
  - packages/addon-provider-bosch/src/home-connect/**
---

# Bosch Home Connect — how the local protocol is modelled

The appliance is spoken to over its own local socket (TLS-PSK WebSocket, JSON frames). The account
token only lists appliances, fetches their pairing keys and their **IDDF**. Everything else is local.

## The description is the authority

The IDDF (a zip of `*_DeviceDescription.xml` + `*_FeatureMapping.xml` from the cloud) is read by a real
XML reader into a compact JSON stored on the appliance row (`HomeConnectCompactDescription`, `version: 2`):
every status / setting / option / event / command with its **kind, access, availability, min / max /
step, default, handling, level**, and every program with the options it lists.
`HomeConnectDescriptionStore` holds it live — `/ro/descriptionChange` and
`/ro/allDescriptionChanges` overlay constraints and availability — and is the only place a uid becomes a
feature name.

- **uids differ per model.** Nothing in the addon names a uid. The old shared "common entity" fallback is
  gone: an appliance whose IDDF cannot be fetched is published `description-missing` (the dishwasher
  `availability`), the fetch is retried with a backoff for the life of the integration, and values are
  never decoded with another model's map.
- An entity the feature mapping does not name is kept as `Unmapped.<hex uid>`, and exposed.
- The active / selected program entities are found by **kind**, not by a name (`Root.ActiveProgram` vs
  `Setting.Program.Active` was a real mismatch).

## The link

`HomeConnectSession` is one handshake plus the traffic after it. It notices the socket closing, probes
liveness (`GET /ci/services`) and reports the drop; `createProtocolHomeConnectClient` owns the lifecycle
(bounded backoff `1 s … 60 s`, until `close()`). **On a drop every value is cleared**: a value read before
the drop is not a value now, so devices publish *unknown*, not the last reading.

- A **write is not echoed.** `/ro/values` POST resolves when the appliance accepts it (a response `code`
  at or above 400 rejects); the feature changes only on the appliance's own `/ro/values` notification.
- Program select / start are POSTs to `/ro/selectedProgram` / `/ro/activeProgram` with the program's
  uid; commands (`PauseProgram`, …) are `/ro/values` writes of `true`. These shapes follow the local
  protocol as other open implementations document it and are **not yet confirmed on a live appliance** —
  check them on first deploy (`camstack-diagnose`).
- `/ci/info` and `/ni/info` scalar fields become features `HomeConnect.Info.*` / `HomeConnect.Network.*`
  (nothing the appliance sends is dropped); the container maps the known ones to device metadata.

Devices never hold a client. They `homeConnectConnections.watch(integrationId, haId, …)`, which follows
the integration across a client swap and attaches to a client that appears after the device started.

## Units and unknowns

- Durations (`RemainingProgramTime`, `StartInRelative`, …) are **seconds**, always; no magnitude
  heuristics. Percent entities (`EnergyForecast`, `WaterForecast`, `ProgramProgress`) are not energy
  sensors.
- A unit is the one the description declares, else the few the interface fixes, else **none**. The
  cumulative energy counter becomes a `power-meter` `kwhTotal` only when its declared unit is an energy
  unit (conversion follows that unit); otherwise it is published raw and unitless. The per-cycle
  `Option.EnergyConsumption` is a separate gauge — the two never share a key.
- `DishwasherStatus` carries `null` for everything the appliance has not reported. The generic sensor
  caps cannot (`value: number`), so a sensor with no value is **offline with no slice**; `getStatus`
  answers the cap's `lastFetchedAt: 0` "never fetched" marker and that placeholder is never written to
  the runtime state.

## Children

The container's children are derived from the description (`deriveChildBindings`): one sensor child per
status / setting / option, one `binary` per event, one enum/numeric child per `/ci` / `/ni` field, plus the
dishwasher device and an events emitter. The bindings are persisted on the container (`entities`) and kept
current by `HomeConnectChildReconciler` through `applyDerivedSpec` — outside the container, which cannot
rebuild itself. Identity is the feature key (`stableIdSuffix`), never a uid. A dropped link never removes a
child; only the appliance dropping the entity does.

## Secrets

The pairing keys (`psk`, `iv64`) are **not on the `appliances` rows.** They live in one keychain secret,
the `applianceSecrets` password field (JSON of `haId -> { psk, iv64? }`). A row saved before the move is
adopted once at reconcile (`planLegacyApplianceSecretAdopt`: this boot connects with the keys it read, the write is fired last and not awaited because the hub restarts the addon after any settings write); while the stored secret is locked nothing is
written. Every write of these settings names `HOME_CONNECT_SECRET_KEYS`.
