---
id: D770
title: Alexa.EndpointHealth is declared on an endpoint only together with a connectivity value Alexa always holds
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-export-alexa/src/endpoints/builder.ts
  - packages/addon-export-alexa/src/handlers/report-state.ts
  - packages/addon-export-alexa/src/connectivity.ts
  - packages/addon-export-alexa/src/lwa-event-gateway.ts
---

## Context

Amazon requires `Alexa.EndpointHealth` next to every sensor interface (a
camera with `Alexa.MotionSensor` is a sensor endpoint), and Works with Alexa
requires it on cameras. It was declared once (6c842489b) and parked again: the
Alexa phone app refused live view ("live view not available", no
`InitiateSessionWithOffer` ever reached the skill) while an Echo Show kept
streaming the same camera. The hub then reported `connectivity` only on an
online/offline TRANSITION and `Alexa/ReportState` did not answer it, so Alexa
held no value for a declared, retrievable property — an endpoint of unknown
health.

## Decision

`Alexa.EndpointHealth` (version 3.1, `connectivity`, retrievable and
proactively reported) is declared on an endpoint only when all three hold:

1. `Alexa/ReportState` answers `connectivity` for it, from the device's
   `device-status` slice. A status read that FAILS answers `OK`: the failure is
   the hub's, and `UNREACHABLE` would make the phone app refuse a live view
   that most likely works.
2. An initial connectivity ChangeReport follows every AddOrUpdateReport and
   every Discover answer that contains it, 5 s later (the cloud creates
   endpoints asynchronously).
3. Online/offline transitions are reported within the same event, deduplicated
   per account and endpoint.

Today that is every camera endpoint; the detection-sensor and generic-device
endpoints of later records follow the same rule.

## Consequences

- The camera endpoint shape changes, so the boot reconcile re-pushes every
  exposed camera once and each push is followed by its connectivity report.
- The phone-app regression must be re-checked on a real device after deploy
  (the operator test list names it). If it recurs with a value in Alexa's
  hands, the cause is something else and this record is where to say so.

## Enforcement

`endpoint-health.spec.ts`: the declaration, ReportState for online, offline and
unreadable status, the initial report for exactly the endpoints that declare
the interface, and the transition reports. `sync-engine.spec.ts` and
`directive-user-scoping.spec.ts` pin that every accepted push and every Discover
reaches the initial-report hook.
