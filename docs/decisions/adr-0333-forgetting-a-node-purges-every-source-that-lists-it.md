---
id: D333
title: Forgetting a node purges EVERY source that lists it, and an action that changed nothing never answers success
status: accepted
date: 2026-09-01
supersedes:
applies-to:
  - server/backend/src/core/agent/agent-registry.service.ts
  - server/backend/src/api/core/cluster-nodes.router.ts
  - packages/addon-admin-ui/src/components/cluster/NodeCard.tsx
---

## Context

An operator pressed "Forget node" on the offline `hub-test` repeatedly. Nothing
happened, and nothing said why.

Every layer reported success:

- `clusterNodes.forgetNode` answered `{ success: true }` — unconditionally,
  without looking at what `forgetClusterNode` had done (it returns `void`).
- `forgetClusterNode` used `historyStore?.forget(nodeId)`, so an ABSENT store
  and a completed delete were indistinguishable.
- The admin UI issued both calls through `Promise.allSettled` and **discarded
  the result**, so two rejections rendered exactly like two successes.

The first hypothesis was wrong and worth recording: that a `historyStore.touch()`
on every topology build was resurrecting the row the forget had deleted. It is
not. The history row IS deleted — the surviving topology entry proves it, because
its shape (`uptime: 121`, a populated `processes` array) is `buildOfflineEntry`'s,
while the history projection hardcodes `uptime: 0, processes: []`.

The real cause is simpler and worse: **the node is listed by TWO sources.**
`listNodes()` reads Moleculer's own catalog with `onlyAvailable: false`, and
`forgetClusterNode` never touched it. Forget purged one source, left the other,
and reported success for both.

The same session found the identical shape twice more. `applyServerUpdate` had
**six branches returning `{ accepted: false }` while logging nothing**, so "the
hub refused" and "the hub was never called" produced identical evidence — and
neither admin surface rendered `accepted` or `message`. The cluster-wide "Update
all nodes" loop wrapped every call in `catch {}`, justified by "a restart drops
the socket", which made a genuine failure indistinguishable from success.

## Decision

**A forget purges every source that can list the thing.** Not the one the author
happened to be thinking about. Where an entity is materialised from more than one
store, forgetting it is a fan-out over all of them, and the answer names each.

**An action that changed nothing never answers `success: true`.** The response
carries what was actually done — `historyRemoved`, `registryRemoved`,
`stillListed` — and a `message` that says which sources held nothing. A caller
that renders only a boolean is not entitled to one.

**An ambiguous failure is reconciled, never classified.** A refusal is not an
exception: it resolves with `accepted: false`, so that half needs no guessing. A
THROWN error during a restart genuinely cannot be told from a dropped socket, so
it is not guessed at — the node is read back (`pendingVersion` armed, or already
on the target) up to a bounded number of attempts, and a node that cannot answer
yields `unconfirmed`, never `applied`. That is [D58](./adr-0058.md)'s "gate on
whether it LANDED", not a heuristic over error text.

## Consequences

Optional chaining on a store that may be absent (`historyStore?.forget()`) is
banned on any path whose caller reports an outcome: an absent store is a fact the
caller must be able to distinguish, not a silent no-op.

Every branch that refuses logs before returning, with `tags: { nodeId }`. The
reason this rule exists is that six silent refusals cost a full session of
investigation that a single line would have ended.
