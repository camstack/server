---
id: D1022
title: Every device transition is a recorded fact with its actor; a command is matched to the slice change it caused in the hub mirror, and an unmatched change is the device's own
status: accepted
date: 2026-11-08
supersedes:
applies-to:
  - packages/system/src/kernel/cap-router-builder.ts
  - packages/system/src/kernel/command-observation.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
  - packages/system/src/kernel/moleculer/trpc-links.ts
  - packages/system/src/builtins/device-manager/device-state-mirror.ts
  - packages/system/src/builtins/device-manager/transitions/**
  - packages/system/src/builtins/device-history/transitions/**
  - packages/system/src/builtins/device-history/retention/retention.ts
  - packages/types/src/capabilities/device-transitions.cap.ts
  - packages/types/src/audit/**
---

## Context

An operator asked who turned a device on: a person, a rule, Alexa, a token,
or the device itself. Nothing could answer. `DeviceStateChanged` carries
`{deviceId, capName, slice}` — no prior value and no actor — and is telemetry
that may be dropped (D8). device-history stores change-only points of catalog
fields and has no from→to record; `device-runs` covers appliance cycles;
`ActionRunChanged` is an action run, not a device command. No cap call path
logs a caller identity: `callerAddonId` is stamped only for the caps in
`CALLER_STAMPED_CAPABILITIES`, and only the hub tRPC mount holds the session.

Tried first and rejected:
- Reading the actor off `DeviceStateChanged`. The provider writes its slice
  later and asynchronously, in another process; the event has no room for a
  caller and may be lost.
- Diffing from→to in a subscriber. A dropped event makes the next "from"
  wrong; only the hub mirror holds the previous value at the instant of the
  write.
- Asking every bridge and the actions runner to write their own audit rows.
  Six writers, six vocabularies, and a call from the admin UI or an API token
  would still have no row at all.

## Decision

1. **A device command is observed where its caller is known, and only
   there.** The hub tRPC mount (`buildOneCapRouter`) reports a device-scope
   mutation with the principal from `ctx.user` (session, token, integration,
   mesh node); the UDS parent (`LocalChildRegistry` `cap-call-out`) reports
   one with the socket-stamped caller addon; an in-process hub addon's own
   client reports with its addon id. An addon may add an ORIGIN claim (action
   id and run id, scheduler id) in the call's out-of-band context
   (`op.context.commandOrigin`); the addon id is always the transport stamp, the
   detail is recorded as the caller's claim. A command is a vocabulary action
   (D920/D983) of a device-scope cap with a required top-level `deviceId`,
   projected into `COMMAND_CATALOG`.
2. **Attribution happens in the hub mirror.** `DeviceStateMirror`, the one
   place where the previous and the new slice coexist for every device, tells a
   `TransitionCorrelator` of each native slice that changed. The correlator
   keeps a bounded pending ring of commands per (device, cap) for 30 s and, on a
   change of an audited field (the fields vocabulary action effects name),
   attributes the transition to the newest pending command whose effect fits,
   else to a no-effect command (stop), else to the device. A command whose
   target already held is `already`; one that expires unmatched is
   `unconfirmed`; one the router saw throw is `failed`. The gate reads memory
   only (D49). An unknown prior is `from: null` (D393). The first slice a cap
   ever reports is the device being learned, not a change: with no command to
   claim it, no row. A command without an effect is stored with field `*`.
3. **Transitions are a records kind owned by device-history.**
   `device-transitions`, `events` database, class `audit`, `deviceRemoval:
   'delete'` (D865). The hub delivers batches by RPC
   (`deviceTransitions.record`), never over the event bus; only the kernel
   caller (`device-manager`) is accepted. Retention is the device-history
   retention policy and pass: `transitionDays` (default 365) beside the four
   tiers, swept by the same `RetentionJob` in time slices — no second mechanism.
4. **Reads are one cap.** `listTransitions` (per device, paged, protected),
   `listRecentTransitions` (fleet, admin only).

## Consequences

- Two kernel seams gain an optional observer; both are O(1) per call and
  never affect the call (D181).
- `CapCallInput` grows an optional `origin`; the actions runner and schedulers
  pass it. Bridges need nothing: their addon id is the actor. Fan presets are
  attributed to the `core-blocks` addon, not to a preset.
- Command args are stored redacted: the input schema's secret paths with their
  nesting (an object or array declared secret goes whole), then a key-name net
  at any depth for values of any type (credential-named keys, and keys whose
  last word is `pin`, `otp`, `code` or `key`), then the log redactor's text nets
  (URL credentials). The whole bag is replaced by `{_truncated: true}` past 1 KiB;
  a credential never reaches a row (D879).
- A device-origin change of one field is written at most once per 10 s; the
  changes inside the window are coalesced into one row (first `from`, last
  `to`, none at all when it ended where it began) released by the next sweep.
  A chatty field costs a row per window, not per poll; the intermediate flips
  are not kept. Commands are never bounded.
- Not attributed in this version, and the change is then recorded as the
  device's own:
  - agent-originated addon calls through `$hub-cap-fwd`;
  - co-located providers in a grouped runner (no UDS hop to observe);
  - hub-main in-process builtins that call through the shared, unstamped broker
    client (stamped in-process clients are covered);
  - changes to composition-owned fields (actor `composition` is a follow-up).
- Loss of a batch is a hole in the audit, never a wrong device state. The
  queue is bounded (10 000); past it the OLDEST rows are dropped with one ERROR
  naming the count and up to ten `tags: { deviceId }` lines. A failed flush is
  logged once per streak and its batch is kept.
- Every device-scope mutation with a required `deviceId` must be a vocabulary
  action or excused, so the catalog is complete by construction.
- A command the correlator settles (any outcome but `device`) is announced
  ONCE on the event bus as `EventCategory.DeviceCommandSettled`
  (`{deviceId, action, outcome, actor, at}`, no args). The command is named only
  by its vocabulary action id (D983), so a command that is not a vocabulary
  action is not announced. It is telemetry (D8): the audit row stays the record.
  The Notification Center turns it into the `device-command` system-event kind,
  filtered by `commandActions` (action ids, validated against the action index
  by the hub), `commandOutcomes` and `commandActorKinds`.

## Enforcement

- `packages/types` `command-catalog.spec.ts`: every operate mutation with a
  required `deviceId` is in `COMMAND_CATALOG` or excused.
- `cap-router-command-observer.spec.ts`: the observer fires once for a command
  and never for a query; a client-supplied actor or origin in the args is
  discarded. `command-observation.spec.ts`: the socket child id wins over a
  claimed addon id.
- `transition-correlator.spec.ts`: the outcome table above, clock-driven;
  `command-args.spec.ts`, `transitions-sender.spec.ts`,
  `transitions-wiring.spec.ts`, `device-state-mirror-transition-tap.spec.ts`.
- device-history specs: `record` refuses another caller; retention keeps the
  row at the cutoff and deletes older ones in slices; the removal hook deletes
  the device's rows.
- Existing guards: `check-durable-state-declared`, `check-cap-vocabulary`,
  `check-capability-union-complete`, the method-tier baseline, `codegen:check`.
