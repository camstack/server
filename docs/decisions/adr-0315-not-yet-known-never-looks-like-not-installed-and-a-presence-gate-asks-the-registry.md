---
id: D315
title: Not-yet-known never looks like not-installed — and a presence gate asks the registry, not the cluster
status: accepted
date: 2026-08-31
supersedes:
applies-to:
  - packages/addon-admin-ui/src/lib/capability-presence.ts
  - packages/addon-admin-ui/src/components/recordings/migration/StorageMigrationSection.tsx
  - packages/ui-library/src/composites/device-export-panel.tsx
  - scripts/check-absent-claim-is-answered.ts
---

## Context

An operator opened Recordings → Management and the page said, in words, that a
component was **not installed**. It held that for about ten seconds and then
rendered the working panel. The component had been installed and running the
whole time.

The gate was one line:

```ts
function useStorageMigrationAvailable(): boolean {
  const { data: topology } = useNodesTopology(undefined)
  return (topology ?? []).some((node) =>
    node.addons.some((a) => a.capabilities.includes('storage-migration')),
  )
}
```

Two independent defects sat in it, and the second is worse than the first.

**It could not say "I do not know yet."** `??` turns the unanswered query into
the empty answer, `.some` over the empty answer is `false`, and `false` renders
the absent copy. A `boolean` has room for two of the three things this gate has
to say, and the one it drops is the one the operator sees first. This is [D62](./adr-0062.md)
one step earlier: *disabled must never look like broken* has a sibling,
**not-yet-known must never look like not-installed**. The cost is not the wait —
it is that an operator who reads "not installed" concludes their addon has
crashed and starts an investigation into a fault that does not exist.

**It asked the whole cluster a one-bit question.** `nodes.topology` exists to
draw the cluster diagram. Its handler (`computeTopology` → `listNodes`) walks
every node in sequence: `$agent.status` and `$process.list` per online agent, a
forked `ps` sampling every child pid on every node (63 on the reference
cluster), one durable history-store write per online node, plus the persisted
history read. Measured against the production hub on 2026-08-31: **51.1 s /
32.4 s / 33.9 s**, 80.7 KB, four nodes. The same question asked of the
capability registry — `capabilities.getCapability({ name })`, a `Map.get` on the
hub's `CapabilityRegistry`, which every provider registers into through the
atomic `registerNode` RPC and which therefore sees agent-hosted providers too —
measured **0.15 s** and ~250 bytes. The hub was already recomputing that same
topology every 30 s for `cluster.topology-snapshot`, whose own header says it
"replaces UI polling on `nodes.topology`"; this gate was one of the callers that
had never stopped polling it.

Two fixes were rejected outright. **Raising a timeout** changes nothing about
either defect. **Caching the answer in the consumer** is what [D224](./adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md)
already forbade — it shipped here once as `privacy-plane-mirror.ts`, worked, and
was stale by design on the one write an operator actually makes. The remedy for
an expensive read is a smaller question, never a local copy of the big answer.

The same collapse was found a second time while checking whether the empty state
had been copied around: `DeviceExportPanel` derives `hasSupportedKinds` from
`deviceExport.listSupportedDeviceKinds` and, before that read answers, told the
operator that a named addon *"reports no exportable device kinds yet"*. A
spinner in the panel header does not undo a sentence in the body.

## Decision

**A UI may claim a component is absent only from a query that has ANSWERED with
nothing.** A presence gate returns a discriminated `CapabilityPresence`
(`pending | present | absent | unknown`), never a `boolean`, and every member is
a render the caller has to write: `pending` says it is checking, `unknown` says
the read failed and that this is not a statement either way, and only `absent`
uses the absent copy. **And a presence gate asks the authority that owns the
answer** — `capabilities.getCapability`, one capability by name — never an
endpoint whose cost scales with the fleet. No consumer-side cache: the registry
is asked each time, because asking it is cheap once the question is the right
size.

## Consequences

- `packages/addon-admin-ui/src/lib/capability-presence.ts` is the single owner
  of the question. A second way to ask it re-opens both defects at once.
- The gate's meaning shifted slightly and deliberately: it used to mean "some
  node's manifest lists this capability id"; it now means "the registry has a
  registered provider for it". A capability declared with no provider is
  `absent`, which is what an operator means by "not installed" and what the
  panel behind the gate needs to be true before it calls anything.
- Every surface that wants to say "not installed" now has to route through the
  tri-state or justify itself in the guard's allowlist. That is the intended
  friction.
- `nodes.topology` is unchanged and still expensive. This record does not fix
  it; it removes one caller that never needed it. The Cluster page still reads
  it as a bootstrap and then lives off the pushed snapshot, which is the right
  shape for a page that actually wants the diagram.

## Enforcement

`scripts/check-absent-claim-is-answered.ts`, wired into
`.github/workflows/ci.yml`. Three rules:

1. a UI source using the absent-claim vocabulary (*not installed*, *not
   deployed*, *doesn't advertise*) must resolve it through
   `useCapabilityPresence`, or carry an allowlist entry with a reason the claim
   cannot be premature;
2. no `use…Available/Installed/Present/Supported(): boolean` in a UI package —
   the signature is the defect;
3. a file that calls `useCapabilityPresence` must mention `'pending'`, so the
   tri-state cannot be re-collapsed with `presence === 'present' ? … : …`.

Verified by restoring the pre-fix file under a probe name: the guard fails it on
rules 1 and 2. Behaviour is pinned by
`packages/addon-admin-ui/src/components/recordings/migration/__tests__/storage-migration-presence.spec.tsx`,
which drives the REAL tRPC client and asserts the recorded operation list
(`['capabilities.getCapability']`, and explicitly not `nodes.topology`) rather
than wall clock, plus
`packages/ui-library/src/composites/__tests__/device-export-panel-pending.test.tsx`
for the second copy.
