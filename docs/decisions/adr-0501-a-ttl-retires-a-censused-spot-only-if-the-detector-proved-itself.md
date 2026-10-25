---
id: D501
title: A TTL retires a censused spot only if the detector proved itself
status: proposed
date: 2026-09-15
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/**
---

## Context

The census retires an entry whose `lastConfirmedAt` is older than a TTL. That
measures ONE thing — elapsed time — and elapsed time answers two different
questions with the same number: *the car left* and *the detector stopped naming
the car*. Only the first is a departure.

Measured on device 102 on 2026-09-15. A motorcycle parked for 29 hours
(`c2b7352a`, `parkedForMs=104278137`) was retired at 10:59 with
`reason=ttl unconfirmedForMs=373384`. At 13:12 a track (`xtn160x3wm`) sat on its
exact spot — bbox `455x410 @ (3048,362)` — and lived 35 s across 295
observations with a **median centroid displacement of 0.0 px** and a max of
3.0 px. The object had never moved. It died before the 120 s span a promotion
needs, so it could not re-enter the census either. Six retirements in two hours
on that camera; the census fell from eleven rows to one.

The obvious fix — lengthening the TTL — was rejected: it buys time against a
detector gap of unknown length and makes a genuine departure linger by the same
amount. The number was never the defect; measuring the wrong thing was.

## Decision

A TTL retirement requires evidence that the detector was *working* on that class
in that window: the entry's class must have been emitted somewhere on that
device since the entry's `lastConfirmedAt`. Without that proof the entry is HELD
and the hold is counted (`ttlHeldUnproven`), never silently. A backstop at
12×TTL retires the entry anyway — a row must not outlive a dead detector
forever — and it names itself `ttl-unproven` so an assumed departure is never
confused with an observed one.

## Consequences

- A camera whose detector goes quiet for a class keeps its census instead of
  emptying it, which is the state an operator can actually act on.
- The cost is a bounded delay on a genuine departure that coincides with a
  detector gap: up to 12×TTL in the worst case, and unchanged in the ordinary
  case where the detector keeps naming other objects of the same class.
- `ttlHeldUnproven` is the signal that a detector is failing on a class. A
  camera that holds constantly is not a census problem, it is a detection
  problem, and this counter is where that shows up first.
- The evidence map is per-device and per-class and is cleared with the device
  (`forgetDevice`). It is in-memory: a restart re-enters the unproven state,
  which holds rather than retires — the safe direction.

## Enforcement

`stationary-ttl-needs-evidence.spec.ts` (5 tests). Removing the gate turns 3 of
them red — verified, not assumed. The three pre-existing TTL tests now establish
the precondition explicitly through `proveDetectorWorks()` rather than relying
on a default.
