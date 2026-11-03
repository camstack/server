---
id: D1005
title: "The transition gate seeds its last level from history, off the event path; a first false waits a bounded moment for it"
status: accepted
date: 2026-11-03
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/services/sensor-transition-gate.ts
---

## Context

The sensor transition gate keeps the last boolean per device and cap in memory only. After a restart it had no prior, so the first `false` of a cycle begun before the restart was dropped as `baseline-seeded-inactive` and "appliance finished" never fired (dryer 5356, 2026-11-03). Seeding the composer's own dwell (2eb6df857) did not cover a device that publishes `null` at boot. Waiting on a history read inside the event is a fallible read gating a one-shot event (D49).

## Decision

The gate seeds `lastValues` from the persisted last boolean (`device-history` raw series `cap:<cap>.<field>`, last 48 h) with a read started at the FIRST sighting of a device and cap, including a `null`, and never awaited by `observe`. A seed never overwrites a value the live stream already gave; `null` stays unknown and changes nothing. The only wait is on a first `false` whose already-running seed read has not landed: `observeSettled` holds it (remembering nothing) for at most `seedWaitMs` (2 s), then decides again. A failed, empty or late seed decides exactly as before the seed existed, and a failure logs a warn with the device's `deviceId` tag. A first `true` is never held.

## Consequences

A true to false end can no longer be lost to a cold gate when history answers. When history is down the old behaviour returns, with a warn. A seeded `true` from up to 48 h ago can raise a late "finished" for a cycle that ended while the node was down; accepted, as the end did happen.

## Enforcement

`sensor-transition-gate-seed.spec.ts` (restart/null/false, restart/true, failed read, never-answering read, seed-never-overwrites).
