---
id: D969
title: A forked child keeps a high-frequency category nobody else wants off the socket
status: accepted
date: 2026-10-29
supersedes:
applies-to:
  - packages/system/src/kernel/transport/uds-event-bus.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
  - packages/system/src/kernel/transport/child-cap-protocol.ts
---

## Context

The hub's per-minute event fan-out showed `fanoutOrphans` at 45% of
`fanoutEvents` (3764 of 8412): events a child serialised onto its UDS socket that
no child wanted. The largest were `stream-broker.metrics-snapshot` (1894/min),
`pipeline.trace` (659/min) and `broker.message` (408/min). The parent already
filters per child on the way OUT (`childWantsEvent`), so the cost sat on the
producer: encode, write, parent decode, bridge, hub-bus emit, all to be dropped.

The first idea was a subscription registry the child consults per emit. The
parent already holds every child's declared patterns, and the hub's own
in-process subscribers are already counted (`brokerLocalInterest`); the missing
piece was only a way to tell the producer.

## Decision

The parent pushes each forked child an `event-interest` set (UDS control message,
full-set replace): the patterns its siblings declared plus the hub's own
in-process subscriber patterns, never the child's own. It is re-pushed whenever
one of those inputs changes, never on a timer. The child's `emit` always
delivers in-process, and crosses the process boundary unless ALL of these hold:
a set has arrived (before the first one, and after a `null`, it sends
everything), the category is high-frequency (`isHighFrequencyCategory`, the ring
deny list), and no pattern in the set matches. A category the hub RETAINS is
never suppressed, because the hub ring is itself a consumer. The first
suppression of a category in a spell is logged once.

Only the hub turns this on (`setEventInterestSource`). An agent cannot see the
hub's subscribers, so its children keep sending everything.

## Consequences

- Events are telemetry and may be dropped (D8); nothing durable may depend on a
  suppressed category. Anything that must arrive uses RPC.
- A consumer on a REMOTE node of a ring-denied category produced by a hub child
  is invisible to the hub: it would stop receiving it. None exists today; a new
  one must either subscribe on the hub or take the category off the deny list.
- `broker.message` is not on the deny list, so the hub ring retains it and it is
  still sent. Suppressing it means a decision about its retention, not a change
  here.
- A new in-process hub subscriber starts receiving a suppressed category as soon
  as the next `event-interest` push lands (one UDS hop).

## Enforcement

`uds-event-bus-interest.spec.ts` (child gate, fail-open, local delivery, log
once), `local-child-registry-event-interest.spec.ts` (the set, its inputs, no
repeat) and `local-event-interest.spec.ts` (the hub-local source).
