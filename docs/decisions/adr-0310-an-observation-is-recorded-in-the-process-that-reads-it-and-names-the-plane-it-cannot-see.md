---
id: D310
title: An observation is recorded in the process that reads it, and names the plane it cannot see
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/system/src/kernel/moleculer/cap-usage-registry.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
---

## Context

`nodes.getCapUsageGraph {windowSeconds}` exists to answer "who calls which
capability, how often". Queried against the live hub — 64 addons, 1019 devices,
a drain running — it returned **`[]` in 0.21 s**. Not a timeout: an in-memory
read of an empty map.

[D237](adr-0237-a-verification-must-be-able-to-say-unknown.md) had already fixed
one cause here (an observation dropped whole because its PROVIDER could not be
named). That fix was correct and it changed nothing, because the writer it fixed
was never reached. Four structural causes remained, and all four were true at
once:

1. **The writer and the reader were in different processes.**
   `getCapUsageRegistry()` is a per-process module singleton. The only writer was
   the `localProviderLink` observer built in `addon-context-factory.ts`, which
   runs *inside a forked runner*; the only reader is `cap-providers.ts`, on
   hub-main. Every observation ever made went into an object hub-main cannot see.
   No aggregation path existed anywhere in the tree.
2. **Hub-main's own `ctx.api` carries no observer, and cannot simply be given
   one.** `AddonRegistryService.getBrokerApi()` builds ONE lazily-constructed
   tRPC client shared by every in-process addon, so there is no per-caller
   identity to record.
3. **Inside a runner, only co-located calls were recorded.** `localProviderLink`
   records when it resolves a local provider; every `return next(op)` is silent,
   and `ipcParentLink` — the link that carries every cross-process call,
   including every `ctx.settings.*` — takes no observer parameter at all.
4. **The callee side recorded nothing.**

And the store was wrong independently of all of that. The ring is indexed
`second % retention` and **nothing ever zeroed a bucket**, so a bucket written at
second S was still readable at S + 300k forever. The `lastCallAtMs` guard hid it
only while a triple was fully idle: one fresh call re-armed the entire stale
ring. A triple that made 1000 calls and then one call five minutes later reported
**1001 calls/min instead of 1**. Had the graph been wired up as it was, it would
have answered confidently and wrongly — which is worse than the silence.

The obvious repair — record in `onUnownedCall`, where `callerAddonId` is already
threaded — is **not sufficient, and the reason is the one that matters**: most
inter-addon traffic never gets there. `LocalChildRegistry.resolveChildId`
short-circuits a cap owned by a sibling runner straight to `callCap`, and on the
hub every addon IS a sibling runner. Recording in `onUnownedCall` would have seen
`ctx.settings.*` and `device-manager` (both hub-in-process) and missed every
addon→addon call — a graph with a whole plane silently absent.

## Decision

**An observation is recorded in the process that reads it, at the chokepoint
upstream of every route the call can take — and the surface names the planes it
cannot see.**

Concretely: the hub's `LocalChildRegistry` records one observation per
`cap-call-out`, before the sibling/unowned branch, from the `callerAddonId` it
stamps off the UDS connection the frame arrived on (a caller identity the child
cannot spoof). A sibling-routed call names the sibling as provider; a
parent-routed call uses `PARENT_ROUTED_PROVIDER_ADDON_ID`, a NAMED unknown, for
the D237 reason: the caller is always known and dropping it loses the question.

The agent's `LocalChildRegistry` is deliberately NOT given an observer. Recording
there would rebuild the original defect — a map nobody reads.

And the store is bounded, because it lives on hub-main, whose event loop is the
cluster's only queue ([D181](adr-0181-hub-mains-event-loop-is-the-clusters-only-queue.md)):
the ring ages by clear-forward (zero the buckets the ring advanced over, never
read past the last written second), and cardinality has a ceiling with
reclamation of dead triples. Reaching the ceiling is reported, never silent.

## Consequences

Measured (node 24, `heapUsed` + `arrayBuffers`, `--expose-gc`):

| | |
| --- | --- |
| per triple | **1.7 KB** (one `Uint32Array(300)` + three Map entries) |
| realistic hub (~600 triples) | **1.0 MB** |
| at the 4000-triple ceiling | **6.3 MB** |
| `recordCall` | **≈46 ns** — at 39 717 calls/min, ~30 µs of hub-main per second |

The previous docblock claimed "~22 MB worst case … under 200 KB at ~10 active
triples". The second figure was an assumption, not a bound, and the key space is
caller × provider × cap.

**The graph is now correct about what it shows and explicit about what it does
not.** Three blind spots remain, named in
`LocalChildRegistryOptions.capUsageObserver` and in the `getCapUsageGraph`
provider:

- **hub-main → hub-main.** Cause 2 above; closing it needs a per-addon `ctx.api`
  client first.
- **A runner's co-located calls.** `localProviderLink` answers inside the runner
  and the frame never reaches the socket. Only the `detection` / `ml` execution
  groups have co-located providers at all ([D9](adr-0009.md), [D29](adr-0029.md)).
- **Anything originating on an agent.** `$hub-cap-fwd`'s envelope carries no
  `callerAddonId`, so an agent-originated call arriving at the hub has no caller
  to attribute.

An edge missing from this graph means "not seen on this plane", never "did not
happen". That sentence is in the code, because an instrument whose blind spot is
undocumented is exactly how the empty array was read as "nothing is calling
anything".

Also now true: **`CapUsageEdge` carries no `methodName`.** The ring is keyed by
CAPABILITY, so `deviceManager.getAllBindings` (the whole fleet, 511 ms / 679 KB)
and `deviceManager.getBindings` (one camera) collapse into one edge. The method
is recorded on the way in and discarded by `getGraph`. So this instrument WOULD
have named the addon and the capability behind the fleet-wide binding reads, and
would NOT have named the method. Splitting the key by method is the obvious next
step and is a schema change to `nodes.getCapUsageGraph` plus a cardinality
multiplier, not a quiet widening of a map on hub-main.

## Enforcement

`scripts/check-silent-observation-drop.ts` (D237's ratchet) still guards the
drop-the-observation shape. For this record, tests — each confirmed RED by
removing the line that makes it pass:

- `packages/system/src/kernel/__tests__/transport/cap-usage-observation.spec.ts`
  — drives REAL `ctx.api` calls from a real `createUdsAddonContext` down the real
  link chain into a real `LocalChildRegistry`, and asserts on the singleton the
  hub's provider reads. Deleting the record site fails three; moving it inside
  the sibling branch (i.e. what `onUnownedCall` placement would give) fails the
  `ctx.settings` test; re-introducing the D237 provider gate fails the same one.
  The sibling test asserts `onUnownedCall` was NOT reached, so it cannot silently
  start measuring the other path.
- `packages/system/src/kernel/__tests__/cap-usage-registry.spec.ts` — ring
  ageing and the cardinality bound. Removing the clear-forward fails two;
  removing `sumWindow`'s `min(nowSec, lastSec)` fails one; removing
  `reclaimExpired` fails one; removing the ceiling fails two.

No guard script for the placement itself: "is this recorded in the process that
reads it" is not textually decidable. Review, against this record — and the
question to ask of any new observer is simply *which process does this run in,
and who reads that object*.
