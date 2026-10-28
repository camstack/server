---
id: D962
title: A fresh node is given every any-node addon the hub installs
status: accepted
date: 2026-10-28
supersedes:
applies-to:
  - server/backend/src/core/agent/agent-addon-backfill.ts
  - server/backend/src/core/agent/agent-registry.service.ts
---

## Context

The back-fill converges a node to the roster that node itself last declared
(D766). A node that has never declared one — a newly paired machine, or one
whose data was wiped and came back under a new node id — therefore got nothing:
a freshly paired Mac agent loaded 13 addons where the previous install of the
same machine had 18, and the rest had to be pushed by hand with
`addons.updatePackage`.

## Decision

When the hub holds no declared roster for a node, the node's intended set is
every hub-installed package whose addons all allow an agent (at least one
`any-node`, none `hub-only`), at the hub's installed version. Bootstrap
packages, packages undeployed in the same pass and circuit-broken pairs are
excluded as before. A node WITH a declared roster keeps the history-based plan
unchanged. The plan is logged per node with `tags: { nodeId }`, and every hub
package left off is logged with its reason. The manifest has no platform or
architecture constraint field, so none is applied; one would be added to the
eligibility check (`freshNodeSkipReason`) when it exists.

## Consequences

A fresh node converges to the hub's any-node set on its first registration. A
package mixing `any-node` and `hub-only` addons is refused whole, because the
stale sweep would undeploy the hub-only addon and with it the shared bundle. The
roster is recorded at the first pass, so a package whose delivery failed on that
pass is not retried as "fresh" later; the operator repair trigger and
`addons.updatePackage` remain.

## Enforcement

`agent-addon-backfill-fresh-node.spec.ts` (fresh set, hub-only never planned,
history node unchanged).
