---
id: D245
title: Logging is ONE document, and a diagnostic's write is a field of it, never its own method
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - packages/types/src/capabilities/system.cap.ts
  - server/backend/src/api/core/logging-settings.ts
  - packages/system/src/logging/logging-gate.ts
  - packages/addon-admin-ui/src/pages/system/Logs.tsx
---

## Context

The audit in `docs/design/plans/2026-08-26-per-component-logging.md` found the
log level spread over **five knobs in three settings panels** (console-logging,
winston-logging, loki-logging), plus two kernel config keys, plus a
`CAMSTACK_LOG_LEVEL` env var that reaches no addon's code at all and a
`nodes.setProcessLogLevel` that answers `{ success: true }` without doing what
it says. No single place showed the picture, which is exactly what is needed to
answer the only question an operator asks: *this line — where does it go, and
for how long?*

A day later ADR-0244 shipped `system.getRequestCensus` / `setRequestCensus`,
adding a sixth knob on a sixth surface. That is the shape of the problem
reproducing itself on the API: today two methods for the census, tomorrow two
for the level, two for the per-component channels, two for the WS plane. Eight
methods configuring the same thing are eight places to get it wrong.

Two designs were rejected before this one:

- **A new `logging` orchestrator capability.** `Logging.tsx` documents why it
  does not exist and the reasoning still holds: every destination owns its own
  settings and `LogManager` already fans out to all of them. A new cap buys
  codegen, a framework publish, and a second home for a destination's identity.
- **Keeping `setRequestCensus` as a facade over the document.** It reads as the
  cheap option and it is the one that fails: a caller of `setRequestCensus`
  sees a different shape, a different freshness and a different `persisted`
  than a caller of `getLoggingSettings`, and the day they disagree about the
  same window is the day the operator stops trusting either. That is the defect
  the plan's own "I due meccanismi che si contraddicono" [The two mechanisms that contradict each other] section denounces —
  reintroducing it from the cure side would be grotesque.

## Decision

**Log levels and diagnostic windows are ONE document on the `system` cap, read
and written whole by exactly one pair of methods.** Adding a logging knob means
adding a FIELD to `LoggingSettingsPatchSchema`, never a method.

```
system.getLoggingSettings { scopeNodeId? }        -> { effective, explicit, activeWindows, persisted }
system.setLoggingSettings { scopeNodeId?, patch } -> the same state, after
```

Four properties make it usable rather than merely tidy:

1. **The patch MERGES.** A field absent from it is left as it was; `null`
   clears the addressed scope so it inherits again. Arming a diagnostic never
   erases a level, and setting a level never disarms a window.
2. **Both `effective` and `explicit` are returned.** `effective` says what a
   line is judged against and WHICH layer decided it; `explicit` says what each
   layer holds, with `level: null` for a layer that inherits. An operator who
   clears an override believing they are clearing an inherited value is the
   same defect as two contradicting knobs, moved one floor up.
3. **Diagnostics carry a DEADLINE, not a boolean** — the shape of ADR-0244:
   persisted, re-armed at boot for the REMAINDER, expiring by itself. Levels
   and destinations stay permanent.
4. **The hot path reads a MIRROR.** The document is the durable authority;
   `LoggingGate` is the in-memory copy `LogManager` consults on every emitted
   line, refreshed only off the hot path and only from a value actually read.

**`system.setRequestCensus` is retired.** Arming the census is now a field of
this document (`patch.diagnostics`). `system.getRequestCensus` STAYS, and the
split is the point: the write is a SETTING and belongs to the one authority,
while the read returns the census RESULT — per-procedure and per-caller counts,
up to 500 group rows — which is a measurement and has no business in a
settings document.

The layer selector is `scopeNodeId`, not `nodeId`. `nodeId` is reserved on
every cap method input: the generated router strips it and resolves the
provider on THAT node, so a document about `agent-1` addressed as `nodeId`
would be forwarded to an agent that holds no cluster document at all.

## Consequences

- Retiring a cap method is an API change. It shipped the same day it is being
  removed, so nothing deployed calls it — but the removal is deliberate and
  loud rather than silent, because a method that vanishes without a word is
  worse than one that lies.
- The `system` cap is now the home of a node-wide concern that is not
  "hub-level health". That is accepted over introducing an orchestrator cap for
  the same state, and it is the reason the pair is one and not eight.
- The floor gates the fan-out to DESTINATIONS only. The in-memory ring keeps
  every line and prunes by level under pressure, which the plan already settles
  as the better policy — an admission level for the ring would blind the log
  viewer exactly when an operator raises the level to quieten a disk. A
  destination's own level composes on top: most restrictive wins, which is a
  hierarchy and not a second authority.
- The mirror is this process's. Propagating a floor to a forked runner or an
  agent is not solved here; it is Track C of the same plan.
- The per-component layer is declared in the schema (`LoggingScopeKind`,
  `LoggingLevelSource`) and is not resolvable. Nothing returns `component`
  today. It is declared so consumers of the document do not have to change when
  it lands.

## Enforcement

- `packages/types/src/__tests__/logging-settings-schema.spec.ts` pins that the
  patch is a real partial, that `null` stays distinct from absent, that the
  layer selector is not `nodeId`, and that `setRequestCensus` is gone.
- `server/backend/src/api/core/__tests__/logging-settings.spec.ts` pins the
  merge, `effective` vs `explicit`, the self-expiry, the boot restore of the
  remainder, and that a failed store read moves neither the mirror nor an armed
  window (D49). Each with a stated neutralisation.
- `packages/system/src/logging/__tests__/logging-gate.spec.ts` pins the cost
  when nothing is set, with an entry whose every property getter THROWS — the
  same idiom `http-request-census.spec.ts` uses.
- `server/backend/src/__tests__/cap-routers/system-logging-settings.router.spec.ts`
  pins the routes and the admin gate through the codegen'd router; its sibling
  `system-request-census.router.spec.ts` pins that `setRequestCensus` has no
  route at all.

No guard script: the rule is about a shape of API surface, and there are now
two documents in this repo to compare against.
