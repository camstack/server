---
id: D1100
title: A device liveness notification is sent only after the new state held for 90 s
status: accepted
date: 2026-11-25
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/liveness-holdoff.ts
---

## Context

D1099 holds a device `unknown` until its integration answers, and the
notification centre ignores `unknown`. That gate only covers the restart paths
wired into it. After planning#713 these stay open: agent-hosted runners,
hub-main in-process addons and crash respawns. On them a restart still sent
spurious online/offline notifications (a gateway offline then online in 15 s,
sensors online then offline within seconds, climates notified twice). The
centre already had a trailing hold-off of 15 s, too short for these.

## Decision

The device liveness hold-off is 90 s, a named constant
`DEVICE_LIVENESS_HOLDOFF_MS`, not an operator setting. One pending flip per
subject; a flip back to the last notified (or seeded) state cancels it and
nothing is sent in either direction, logged as `liveness flip suppressed —
reverted within window` with the flip and elapsed time. At expiry the current
state is compared with the last notified one. Timers are cleared when the
device is removed and when the addon stops. The first state observed after an
addon restart is a seed, never a flip. The D1099 gate stays: it keeps the UI
at unknown instead of a false offline. Node liveness keeps its own 60 s window, and stream liveness keeps its own
15 s one: a stream's offline already waited the broker's 120 s stale window,
so 90 s on top would announce it about 210 s late.

## Consequences

This replaces the 15 s device hold-off of 2026-11-24 (a constant, no earlier
record). A real device outage is notified 90 s late. 90 s stays under the 120 s D1099
bound.

## Enforcement

`notification-center/__tests__/liveness-stability-window.spec.ts`.
