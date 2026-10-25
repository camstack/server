---
id: D500
title: A camera retains the footage its own notification rules ask for, and an unanswered ask is not zero
status: proposed
date: 2026-09-15
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts
  - packages/addon-post-analysis/src/notification-center/clip-retention-ask.ts
---

## Context

The notification clip ring was flat: every camera with a broker retained
`CLIP_RETENTION_SEC` seconds of its cheapest profile, and on 2026-09-15 that
number was raised from 25 s to 60 s so an OCCUPANCY departure — anchored well in
the past, because its edge is confirmed by an independent read (D279) after the
condition's own `sustainSeconds` — could still be cut before the recordings can
serve it. The recordings' availability edge is a PHASE of the 10-second segment
cycle, not a number: full coverage of a 10 s window arrived at −18 s on device
104 and −26 s on 101 and 102.

That bought the occupancy case at the whole fleet's expense. Of the 15 rules on
the live hub, four attach no media at all, exactly one asks for a `clip` and ten
for a `gif` — and a `gif`/`clip` is the ONLY thing that reads the ring, because
`media.attach` (`best`, `best-matching`, `keyFrame`) is served by the track's own
media and the still shelf. Fourteen cameras need a notification window; one needs
the minute; the rest were paying for footage no rule would ever cut.

The PROFILE was worse: `armClipRetention` was private and REACTIVE. A rule that
asked for `high` learned it only after the first cut had already been taken from
the cheapest slot — the "cheapest first, re-arm later" dance — and the duration
travelled separately from the profile, so a consumer that needed a longer window
had no way to say so.

Two things were tried and rejected. **A push from the notification centre** —
`notification-rules` is a singleton while a camera's ring lives on the node that
ingests it, so a push would have to enumerate the cluster, and `nodes.topology`
measures 32–51 s (D315). **Deriving in the broker from `listRules`** — the broker
would then own a second copy of the rule semantics (which attachments read the
ring, what a rule's pre/post-roll defaults are), which is the mirror this repo
has spent the week removing.

## Decision

The notification centre states what each camera's rules ASK for
(`notification-rules.getClipRetentionAsks`, one ask per rule×camera: a rule with
no `conditions.devices` produces one device-less ask meaning every camera), each
node's broker PULLS that answer on its catalog-reconcile tick, and the broker
takes the MAX over the asks that reach a camera — bounded by the ring's existing
byte budget, which is never raised for an ask. A rule with neither `gif` nor
`clip` asks for nothing; an occupancy rule asks for `NC_CLIP_RETENTION_MAX_SEC`
(60 s = the worst recordings phase, 26 s, plus the confirmation lag, 29 s);
everything else asks for `preRoll + postRoll + NC_CLIP_DISPATCH_MARGIN_SEC`. The
reactive arming is the SAME ask (`noteClipAsk(deviceId, profile, seconds)`) —
one mechanism, not two.

**A plan that has never arrived is UNKNOWN, and unknown retains the full minute.**
A pull that fails, and an answer from a centre whose rule ledger has not loaded
(`rulesLoaded: false`), change nothing (D49). Only an answer about a rule set
that was actually read may take a ring away.

## Consequences

- On the live fleet: 1 camera at 60 s, 14 at 20 s, and every other camera
  allocates no ring at all — 340 camera-seconds against 1320, ≈8 MB against
  ≈32 MB at the measured 4.3 Mbps aggregate of the 22 cheap streams.
- A rule created, edited, enabled, disabled or deleted reaches every node's rings
  within one catalog-reconcile tick (30 s by default). Boot order is not a
  special case: until the first answer lands, every camera holds the minute.
- `NC_CLIP_RING_RETENTION_SEC` stops being a hand-kept mirror of the broker's
  constant — it had already drifted (25 here, 60 there). The dispatcher asks
  `ringRetentionSecFor(deviceId)` for the number that camera actually got, so the
  ring-or-recordings decision and the retention it depends on cannot disagree.
- A camera whose retention is zero can never produce a ring-sourced clip. That is
  correct only for as long as the asks are complete: any FUTURE consumer of
  `getClipBuffer` that is not a notification rule must register its own ask
  (`noteClipAsk`) or it will find an empty ring.
- Fixed on the way: `ensureBroker` applied retention BEFORE inserting the broker
  into `this.brokers`, so a freshly created broker was armed only if some later
  assignment change happened to re-apply. On a steady camera that is never.

## Enforcement

`packages/addon-post-analysis/src/notification-center/__tests__/clip-retention-ask.spec.ts`
pins the rule→seconds mapping (still-only, gif, occupancy, disabled, unscoped,
max-over-rules) and
`packages/addon-pipeline/src/stream-broker/__tests__/clip-retention-plan.spec.ts`
pins the broker half: per-camera application, zero for an unasked camera, the
UNKNOWN minute, a failed pull changing nothing, re-derivation on a later tick,
the profile in the ask, and the per-camera transition log. Each was verified to
fail with the corresponding line removed. Nothing stops a new `getClipBuffer`
consumer from forgetting to ask — that is review only.
