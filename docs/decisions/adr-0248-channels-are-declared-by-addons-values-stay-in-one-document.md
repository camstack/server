---
id: D248
title: An addon DECLARES its log channels; the document keeps the only VALUE
status: accepted
date: 2026-08-27
supersedes:
covers:
  - packages/types/src/logging/**
  - packages/types/src/capabilities/log-channels.cap.ts
  - packages/addon-pipeline/src/stream-broker/log-channels.ts
  - packages/addon-provider-reolink/src/log-channels.ts
  - scripts/check-log-channel-gated.ts
---

## Context

The audit in `docs/design/plans/2026-08-26-per-component-logging.md` found the
log level spread over five knobs in three settings panels, two kernel config
keys and an env var that never reached an addon. D245 collapsed the VALUES into
one document on the `system` cap — one method pair, a hierarchy, and diagnostic
windows that carry a deadline instead of a boolean.

That left the operator's real question unanswered: *"how do we handle the flags
per camera / per addon? stream-broker (webrtc), reolink with its debug logs…"*.
Making those knobs reachable needs a LIST of what can be turned on, and the
first instinct — a central list of channel names — is the thing that must not be
built. Only `stream-broker` knows what "ICE" and "RTP" mean in its own process;
only `provider-reolink` knows about baichuan and the login handshake. A
hand-maintained list rots at the first addition and rots INVISIBLY: nothing
fails, an operator simply never sees the channel somebody added.

The opposite mistake was equally available and worse: give each addon its own
place to store which channel is on. That is the defect the plan exists to
remove, reintroduced from the cure side.

Two things were tried first and rejected:

- **A `logging` orchestrator capability.** `Logging.tsx` already documents why
  there isn't one, and the reasoning still holds: it would mean a codegen
  change, a framework publish, and a second home for a destination's identity.
- **Declaring per-camera filterability for every channel, because it reads
  better.** It is false for `stream-broker.rtp`, whose gated lines put the
  device in `meta` rather than in `tags: { deviceId }`. An operator who narrows
  to one camera and sees nothing concludes the code path was never taken.

## Decision

**Two axes, separated.** An addon DECLARES its channels through the
`log-channels` capability — name, one sentence describing what arming it shows,
default level, and whether it is honestly filterable per camera. A declaration
is inert: no value, no state, no persistence. The VALUE — which channel is
armed, for which cameras, until when, and at what level — stays in the single
logging settings document on the `system` cap, reached by the same
`getLoggingSettings` / `setLoggingSettings` pair. Adding a knob means adding a
FIELD, never a method.

`log-channels` copies the shape of `log-destination`: `mode: 'collection'`,
`internal: true`, `mount: { kind: 'skip' }` — no tRPC route, no generated hooks
— while `addons.listCapabilityProviders` still enumerates it and the hub's
`CapabilityRegistry` still holds an RPC proxy per provider. It carries exactly
two methods: `list` (the declaration) and `apply` (the hub pushing the
document's armed set into that process's in-memory mirror). `apply` stores
nothing and is never the source of a value; without it a channel the document
can name but not reach would be a knob with nothing behind it.

**`perDevice: true` is a promise with two halves** — the gate is consulted with
the numeric device id, AND every line the channel admits carries
`tags: { deviceId }` with that same id. A channel that cannot honour both is
declared `false`, says so on its row, and is offered no camera box; the server
REFUSES a patch that tries to narrow it rather than silently widening it.

**The `component` layer resolves.** The hierarchy is cluster → node →
component, most specific wins, and a component level is cluster-wide — a channel
means the same thing wherever its addon runs, so there is no per-node component
map and there must not be one (D62).

## Consequences

- The per-camera scope is only realisable because this repo already forces every
  log line about a device to carry `tags: { deviceId }` numerically. That rule
  was paid for with a 22% thumbnail gap and a 3-hour media blackout diagnosed by
  hand; this is the first mechanism that collects on it.
- `LogTags` gained `logChannel`, deliberately NOT `channel`: that key is already
  taken and means the NVR sub-channel index a Reolink hub camera sits on, and it
  is a number. One key meaning both `2` and `stream-broker.rtp` would make every
  LogQL selector over it ambiguous.
- A channel emits at `info` or above, never `debug`. Loki drops below `info` and
  the hub's ring holds ~35 minutes, so a `debug` diagnostic does not exist an
  hour later — which is worse than none, because it looks done.
- The disarmed cost is a plain boolean field read as the first instruction, the
  same discipline as `LoggingGate.allowsDestination`. Measured: 1.627 ns/call
  disarmed against a 1.608 ns/call baseline of one boolean read — no regression.
- Every addon that declares channels must register a `log-channels` provider and
  name it in its manifest. Missing the second half yields declarations that the
  hub can enumerate but never arm.

## Enforcement

`scripts/check-log-channel-gated.ts`, in the *Repository guards* block of
`.github/workflows/ci.yml`. It refuses a declared channel that no production
`<binding>.on` reads, an anonymous declaration, a name declared twice across
addons, a stale entry in the exception set, and a `wants(`/`log(` call that is
not prefixed by `<binding>.on &&` — the last because without that prefix a
disarmed channel pays a method call on every line the process emits, a
regression no test would notice.

Both refusals are neutralisation-checked: dropping the `CH_RTP.on` reads turns
the guard red naming `stream-broker.rtp`, and removing one `.on &&` prefix turns
it red naming `provider-reolink.handshake`.
