---
id: D998
title: A notification that needs a sleeping battery camera wakes it once, by the rule's leave, and waits bounded
status: proposed
date: 2026-11-02
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/linked-stills.ts
  - packages/addon-post-analysis/src/notification-center/live-intake.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
---

## Context

A sensor or alarm notification takes its picture from the linked cameras. The linked-stills
shelf read the wrapper state, left a `sleeping` battery camera out, and never passed `force`,
because D503 and D632 read `force` as the operator's button alone. The notification then
shipped text-only on the very camera the sensor sits next to, at the moment a picture
mattered most. Sending now and attaching later is not available: a `sent` outbox row is
final and attachments are resolved on every attempt.

## Decision

`force` is a demand with a named principal: an operator button, the D847 scheduled refresh,
or a notification rule that left the camera's wake allowed. It is still never used by a
poller, a thumbnail or a prestream (D173, D503).

A sensor rule's media policy carries `wakeSleepingCamera`; absent means on, `false` opts out
(never a Zod default). For one sensor event the shelf wakes a camera when the wrapper says
`sleeping`, some rule that could fire did not opt out, and that camera has not been woken in
the last 60 s: one forced `getSnapshot` under a 15 s bound. A `waking` camera is never
forced, only re-polled inside the same bound. Unreachable, disabled and offline cameras are
never woken. The dispatcher holds the row until the shelf's deadline, at most 15 s, instead
of the 3 s still wait; a picture that does not land inside it is not attached later.

## Consequences

A rule that sits on a flapping contact costs at most one wake per camera per minute. A
notification about a sleeping camera can be up to 15 s late. Every wake, skip and timeout is
named on the camera (`wake-skipped:*`, `wake-timeout`, `wake-refused`). D503 and D632 keep
their rule for every caller without a named principal.

## Enforcement

Specs: `linked-stills.spec.ts` (force only for a sleeping camera whose set allows it, the
gap, the bound, no force for a waking camera), `sensor-linked-evaluation.spec.ts` (the flag
follows the rules), `dispatcher-still-rescue.spec.ts` and `grouped-mosaic.spec.ts` (the
wait). No guard.
