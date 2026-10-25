---
id: D503
title: Force is the only thing that may wake a battery camera for a snapshot
status: proposed
date: 2026-09-15
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/snapshot-wake-gate.ts
  - packages/addon-provider-reolink/src/reolink-camera.ts
---

## Context

`snapshot.cap.ts` states the rule twice: `force` is an OPERATOR signal, the one
thing that walks past the sleep gate, and a background caller — a poller, an
event handler, a thumbnail — must never set it. On a sleeping battery camera
the correct answer to an unforced read is the cached frame plus `sleeping:
true`: stale but honest beats woken.

The Reolink driver did not implement that rule. Its `snapshot` cap mount
destructured only `deviceId`; `force` was dropped on the floor and never
reached the camera. What stood in its place was
`allowProactiveCameraAccess`, which consulted the 10-minute
`PROACTIVE_WAKE_COOLDOWN_MS`.

A rate limiter cannot express the rule. It answers "how often may we wake this
camera", never "may we wake it at all", so every background caller arriving on
the far side of the window got a login — and on a sleeping UDP/battery Reolink
the login IS the wake (the lib's discovery + handshake nudges the firmware up
before anything asks it for a picture), which is why the gate had already been
moved in front of `ensureApi`. Right place, wrong question.

Measured on the live hub, device 106 ("Baby monitor", battery), 2026-09-15
14:47:25:

```
[Baby monitor] battery cam login while sleeping — this wakes the camera. caller:
  <- at ReolinkCamera.fetchSnapshotWithSingleFlight
  <- at Object.getSnapshot            (cap dispatch, from the snapshot wrapper)
14:47:31  prestream: picture composed {source=cached-snapshot …}
```

The caller was the broker's `preparePrestreamFrame`, which asks without
`force` deliberately (D502). Six seconds later the picture was composed from
the CACHE. The camera was woken for a frame nobody used.

## Decision

A Reolink snapshot read reaches the camera's socket only when
`decideSnapshotCameraAccess` says so, and that decision has exactly three
inputs: `isBattery`, `sleeping`, `force`. A sleeping battery camera with no
`force` is REFUSED — no login, no `wakeUp`, no cache inspection, whatever the
cache holds — and the refusal is logged at INFO with the device tag. `force`
proceeds and stamps the shared wake cooldown but is never gated by it: operator
demand is not rate-limited, the same rule `wakeForStream` and `wakeIfSleeping`
already follow. The decision is pure and takes no clock, because a gate a stale
timestamp can talk out of its answer is not a gate (D49).

## Consequences

- An empty cache is not a licence to wake. After a hub restart the wrapper's
  in-memory cache is cold, and the honest answer is still a refusal: callers
  have their own fallback (the broker's generated card, the wrapper's courtesy
  `sleeping` frame). The alternative — "wake when we have nothing" — would wake
  every battery camera on the install at once, on exactly the boot where the
  system is least sure of anything.
- The wrapper's sleep gate keeps its meaning but is no longer load-bearing for
  Reolink. That matters, because on 2026-09-15 the wrapper let the call through
  while the driver knew the camera was asleep: the driver is the OWNER of the
  device fact (D224) and must be the last word on touching it.
- `allowProactiveCameraAccess` is deleted — the snapshot path was its only
  caller. `canProactivelyWake` / `markWakeIssued` stay for the genuinely
  opportunistic paths (contact expiry), where "how often" IS the question.
- Other providers are untouched; the cap contract is unchanged. This record
  makes a driver comply with it, it does not amend it.

## Enforcement

`packages/addon-provider-reolink/src/__tests__/snapshot-wake-gate.spec.ts` —
the four decision cases including the `force` CONTROL, plus wiring assertions
that the cap mount forwards `force`, that the gate is consulted before
`ensureApi` and before any `wakeUp`, that the refusal is logged, and that no
cooldown helper reappears in that method. The wiring assertions are structural
(source text): constructing a real `ReolinkCamera` needs the whole
`DeviceContext` mocked, and the invariant is an ordering one.
