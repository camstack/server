---
id: D1079
title: A vehicle is one device with its lock and its climate as accessory children
status: accepted
date: 2026-11-22
supersedes:
applies-to:
  - packages/types/src/capabilities/vehicle.cap.ts
  - packages/types/src/device/device-type.ts
  - packages/types/src/device/container-primary-child.ts
  - packages/types/src/capabilities/accessories.cap.ts
---

## Context

A connected car reports an odometer, a range, openings, tyre warnings and a 12 V battery, can be locked and can pre-condition its cabin. Capabilities are gated by device type ([D1033](adr-1033-a-type-is-a-set-of-controls-same-controls-is-a-role.md)), so a lock and a climate cannot live on a type that is neither `Lock` nor `Climate`, and a car is not a thermostat. The traction battery is the `battery` cap; the car's 12 V auxiliary battery is a different thing and must not read as it.

## Decision

A vehicle is one `DeviceType.Vehicle` device that carries `vehicle` (read-only readings), `location` and `consumables`. Its lock and its cabin climate are `Lock` and `Climate` accessory children, told apart from a house lock or air conditioner by the roles `lock-vehicle` and `climate-vehicle`. The vehicle stands for itself in a container (`self`), so a child never becomes its hero. The 12 V battery is two fields of `vehicle`, never the `battery` cap. Waking the car is the optional admin-only `vehicle.requestRefresh`, which answers with a typed refusal (budget, minimum gap, in progress, unreachable, account) instead of throwing; the scheduled re-read stays the core's state-refresh scheduler ([D1062](adr-1062-the-core-decides-when-a-device-is-re-read-the-provider-only-how.md)). `media-player-tv` is a plain D1033 role and needs no decision of its own.

## Consequences

Every reading is nullable: unknown is `null`, never 0 or false ([D393](adr-0393-a-measurement-that-failed-is-not-a-measurement-of-zero.md)). No window or sunroof series is recorded. A per-door or per-tyre state trigger cannot be expressed (a vocabulary trigger names a top-level field), so those booleans are recorded but not offered as triggers. The vehicle card and the first provider are separate pieces of work.

## Enforcement

`packages/types/src/capabilities/__tests__/vehicle.cap.spec.ts`, `accessories-vehicle.spec.ts`, the container-primary-child spec and `server/backend/src/__tests__/cap-routers/vehicle.router.spec.ts` (the refresh is admin-tier). Guards: `check-hero-look-exhaustive`, `check-container-priority-in-sync`, `check-cap-vocabulary`, `check-cap-history-declared`, `check-method-tiers`.
