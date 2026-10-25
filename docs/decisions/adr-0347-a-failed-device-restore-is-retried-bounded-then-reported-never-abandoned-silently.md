---
id: D347
title: A failed device restore is retried bounded, then reported — never abandoned silently
status: accepted
date: 2026-09-04
supersedes:
applies-to:
  - packages/types/src/device/device-restore-retry.ts
  - packages/types/src/device/base-device-provider.ts
---

## Context

On 2026-09-04, a `migrateDevice` restarted `provider-hikvision` and
`provider-reolink` while the migration still held hub-main's device-manager.
Every per-device restore dial the fresh runners issued was concurrent, and
whole batches timed out together at the UDS transport's 60 s default — all
failures landing in the same second, which is the signature of a busy hub, not
of dead cameras. The restore path's answer was one WARN (without a `deviceId`
tag) and nothing else, ever: the device's native caps never entered the worker
map, `updateCaps` never announced them, and every route answered "binding not
yet in LocalChildRegistry" for the life of the process. 27 healthy cameras
were off the air for ~20 minutes; recovery was manual `addons.restartAddon`,
twice, and the second attempt still left 12 bindings missing until a third.

The alternative that was already tried and rejected elsewhere in this path: a
lane cap on the INITIAL restore fan-out. D167 measured it — 4 lanes cost the
last camera 6.5 minutes on a healthy boot. Narrowing the first pass punishes
every boot to protect against a condition that exists only on some boots. The
other rejected alternative is retrying forever: this repo's discipline for
respawns is D6's — bounded, then terminally failed and visible.

## Decision

A device restore that fails is handed to a bounded background retry, never
abandoned after one attempt and never retried forever. The rules:

- The **initial pass stays full-width** (D167). Only retries run through a
  capped lane pool (`DEVICE_RESTORE_RETRY_CONCURRENCY = 4`): the entries being
  retried already failed *together*, which is evidence of hub congestion, and
  re-stampeding them recreates the collision. A large fleet's happy-path boot
  is unchanged.
- Retries follow `DEVICE_RESTORE_RETRY_DELAYS_MS` (10 s, 30 s, 90 s) — the
  round count IS the bound. Parents retry before hub-adopted children within a
  round; a child deferred by a failed parent rides the same rounds instead of
  being dropped.
- Boot never waits for retries: the runner's post-init handshake goes out with
  the devices that restored, and a late success announces its caps through the
  existing `native-cap-change` → `updateCaps` path.
- "Not yet" and "never" are distinct outcomes. Only exhaustion of the bound
  makes a failure permanent, and a permanent failure is REPORTED: an ERROR log
  with `tags: { deviceId }` carrying attempts and last error, and a standing
  entry in the provider's `getStatus().error` so an operator sees it without
  reading logs. Shutdown cancellation marks nothing failed — the next boot
  restores from the persisted rows.

## Consequences

- A device that genuinely cannot restore consumes up to 4 attempts (each
  bounded by the transport timeout) before going terminal — worst case a few
  minutes of background dialing, on capped lanes.
- The permanent-failure set lives for the runner's lifetime; the only reset is
  a provider restart, and `getStatus().error` says so.
- Providers that override `onRestoreDevices` (today: ONVIF) do not get the
  retry — the machinery is in the default implementation. An override can
  return a `DeviceRestoreReport` and reuse `DeviceRestoreRetryScheduler`, but
  nothing forces it to.
- `@camstack/types` is a framework external even for "self-contained" addons,
  so this is live only via a new `@camstack/server` closure — not via
  `camstack deploy` of a provider.

## Enforcement

`packages/types/src/device/__tests__/device-restore-retry.spec.ts` and
`base-device-provider-restore-retry.spec.ts` (proven RED against the reverted
fix: with retry scheduling disabled, 4 of 5 provider tests fail). The initial
full-width invariant stays guarded by
`base-device-provider-restore.spec.ts` (D167).
