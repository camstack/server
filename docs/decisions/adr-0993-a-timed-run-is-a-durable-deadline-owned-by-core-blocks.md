---
id: D993
title: A timed run is a durable deadline row with one timer, owned by core-blocks
status: accepted
date: 2026-11-01
supersedes:
applies-to:
  - packages/system/src/builtins/core-blocks/timed-run/**
  - packages/types/src/capabilities/timed-run.cap.ts
---

## Context

A plug-in heater has no thermostat: the only safe way to run it is "on for N
minutes". The pet fountain pump has the same need in seconds. A timer held only
in memory leaves the device running if the hub restarts in between, and a timer
per device is the shape D983 already rejected for schedulers.

## Decision

`timed-run` is a hub-owned wrapper cap (`runFor`, `cancel`) that applies to
devices of a type listed in `TIMED_RUN_LIMITS` (Heater 180 min, PetFountain
300 s). The deadline is one `timed-runs` row per device, written BEFORE the
device is switched on; ONE timer is armed for the earliest deadline. A request
above the maximum is refused with a typed reason, never clamped. A manual off
cancels the pending deadline silently; an explicit `cancel` (Stop) switches the
device off once as well, and sends nothing when no run is armed. At boot a passed deadline issues the off
once and a future one is re-armed (D49: the off is a one-shot, a failed one is
logged with the device tag and not retried in a loop).

## Consequences

The limit lives with the type, not in the UI. A crash between the row and the
on command costs one harmless extra off. The slice is a mirror of the row and is
rewritten at boot.

## Enforcement

`core-blocks/__tests__/timed-run-service.spec.ts` (schedule, cancel, over-max,
manual off, restart reconcile, failed off not looped) and the cap-vocabulary,
method-tier and export-coverage guards for the cap itself.
