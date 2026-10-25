---
id: D776
title: Alexa state changes are reported proactively from DeviceStateChanged, an offline device is refused with ENDPOINT_UNREACHABLE, and the Event Gateway is retried the way Amazon says
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-export-alexa/src/state-reports/**
  - packages/addon-export-alexa/src/lwa-event-gateway.ts
  - packages/addon-export-alexa/src/directive-router.ts
  - packages/addon-export-alexa/src/endpoint-signature.ts
---

## Context

Only camera motion and doorbell presses were pushed to Alexa. The alarm
panel, the privacy and autotrack switches and the accessories (siren,
floodlight, spotlight) declared `proactivelyReported: false`, so an alarm that
went off or a light switched at the wall stayed stale in the Alexa app until it
polled — and Amazon asks for alarms to be reported proactively.

The obvious source turned out not to exist: the `on…Changed` events the
`switch`, `brightness`, `ptz-autotrack` and `device-status` caps declare are
never emitted, and `alarm-panel`, `privacy-mask` and the sensor caps declare
none. Every state change reaches an addon as ONE event,
`DeviceStateChanged {deviceId, capName, slice}`. The same research found that
`DeviceOnline` / `DeviceOffline`, which the connectivity reports relied on,
are emitted by the Reolink provider only — every other camera's online state
never reached Alexa.

Every proactive post was also one-shot: a 429 or a transient 503 lost the
doorbell press.

## Decision

- `StateChangeReporter` subscribes to `DeviceStateChanged` and maps a change
  to the Alexa properties it changes on the endpoints this addon published:
  `alarm-panel` → `armState` + `burglaryAlarm`; `privacy-mask` / `ptz-autotrack`
  → that switch's `powerState`; `switch` / `brightness` → the accessory's
  `powerState` / `brightness`; `device-status` → connectivity on every
  `EndpointHealth` endpoint of the device (the camera and its detection
  sensors), deduplicated with the provider's own online/offline events.
- Those interfaces now declare `proactivelyReported: true`, and the endpoint
  signature records the flag, so the boot reconcile re-pushes the new shape.
- A report goes only to an endpoint Alexa knows WITH that interface (D76), only
  to accounts whose user may see the device (D767), and only when the reported
  values changed.
- Stream, session and control directives to a device the registry reports
  offline are answered `ENDPOINT_UNREACHABLE` at once (ReportState still
  answers, with `connectivity: UNREACHABLE`); a status read that fails never
  refuses.
- The Event Gateway is retried on 429 / 500 / 503 and network failures, up to
  three times at 1 / 2 / 4 s (or `Retry-After`, capped at 10 s), re-sending the
  SAME body so a processed 503 cannot become two events.

## Consequences

- Every exposed device with a published switch, light or panel is re-pushed
  once after deploy (signature change).
- A slice that changes without a value Alexa shows (a `lastFetchedAt` tick) is
  not sent.

## Enforcement

`state-change-map.spec.ts`, `state-change-reporter.spec.ts`,
`gateway-retry.spec.ts`, the offline cases in `directive-user-scoping.spec.ts`
and the proactive flag in `security-panel-endpoint.spec.ts`.
