---
id: D271
title: A settings surface renders ONE store scope, and an empty one says why
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-admin-ui/src/lib/settings-field-scope.ts
  - packages/addon-admin-ui/src/components/settings/NodeAddonsSettingsPanel.tsx
  - packages/addon-admin-ui/src/components/cluster/tabs/NodeDetailSettingsTab.tsx
  - packages/addon-admin-ui/src/components/addons/AddonCard.tsx
---

## Context

`ConfigFieldBase.perNode` is the only thing that makes a setting per-node: it
scopes the persisted key to `<key>@<nodeId>`. Without it,
`BaseAddon.updateGlobalSettings` **discards** the `nodeId` argument and the
patch lands on one blob shared by the whole cluster
(`packages/types/src/addon/base-addon.ts`, `addon/per-node-store.ts`).

`NodeAddonsSettingsPanel` takes a `nodeId` and renders whatever the addon
returns. Two callers made that a lie in opposite directions:

- **Cluster → node → Settings** rendered every addon on the node at
  `level: 'global'` with no field filter. The
  [2026-08-28 settings census](../design/2026-08-28-cluster-settings-census.md)
  counted 298 reachable fields of which 23 carry `perNode`, and a cross-node
  diff of all 298 found exactly 4 differing values — every one of them
  `perNode`. The other 294 were one value drawn under three different node
  headings, with a Save button under each.
- **Addons → card → Settings** passed a literal `nodeId="hub"`. For the five
  addons with `perNode` fields, `terminal.btmPath` edited there wrote
  `btmPath@hub` while the same field, same label, edited from Cluster →
  *agent-a* wrote `btmPath@agent-a`. Two controls, one label,
  different targets, and both displaying a value — the disagreement is
  invisible precisely because neither looks broken.

The first thing considered was a per-addon allow-list of "fields that belong on
a node card". It was rejected: the schema already carries the answer on every
field, and a hand-maintained second list is one more thing that can disagree
with the first.

The counter-argument, recorded: narrowing the node tab makes it SHORT, and on
some nodes empty. An operator uses it as a jumping-off point and will notice
the loss. The answer is that the removed rows were not information about that
node — they were the cluster's values wearing its name, and a shorter honest
page beats a fuller wrong one. It only holds if the empty case EXPLAINS itself;
a blank panel reads as a failed load, which is a third way to be wrong.

## Decision

A settings surface declares the store scope it is entitled to render, and
renders nothing else. `NodeAddonsSettingsPanel` takes `fieldScope`:

- `perNode` — for a surface drawn under a node's name. Cluster → node →
  Settings uses it. A field without `perNode: true` never appears there.
- `cluster` — for a surface with no node behind it. The Addons card dialog uses
  it, passes `nodeId={null}`, and states on screen that its values are
  cluster-wide. A `perNode` field never appears there, because the dialog would
  have to invent a node and any node it invented would be a silent wrong
  answer.

Filtering happens in the query function, so the tab bar, the fingerprint, the
panes and the dirty set all see the same schema; a section left with no field
is dropped, and a container is rewritten to hold only its survivors.

A surface that narrows with `fieldScope` MUST pass `emptyMessage` saying why it
is empty and where the other settings live. Omitting `fieldScope` keeps the
old behaviour, which is correct for a surface that genuinely owns both
populations.

## Consequences

- The node Settings tab is short, and empty for most addons. That is the true
  size of "what is configurable about this machine" until the 22 mis-scoped
  fields the census identified gain `perNode: true` — at which point they
  appear here with no further UI change. That is deliberately the ONLY thing
  needed to grow this tab back.
- The Addons card dialog can no longer edit `perNode` fields at all. Nothing is
  lost: all 23 have a node-addressed home (Cluster → node → Settings, Cluster →
  Pipeline → node, System → Terminal).
- Two `nodeId="hub"` literals remain and are NOT covered by this record:
  `pages/system/LocalAccess.tsx` (harmless — the addon has no `perNode` field)
  and `components/device/tabs/ProviderSettingsTab.tsx`, which renders an
  addon-wide `level:'global'` schema inside ONE camera, so editing
  `emailPushPort` from camera 102 changes every Reolink. That is a device-scope
  defect with a wider blast radius and is left for its own change.
- Nothing was moved onto the System page. It still renders the hub's addon list
  unscoped and remains the cluster surface.

## Enforcement

- `packages/addon-admin-ui/src/lib/__tests__/settings-field-scope.spec.ts` —
  the partition itself: no cluster key survives `perNode`, no `perNode` key
  survives `cluster`, containers are rewritten, sections are dropped.
- `components/settings/__tests__/NodeAddonsSettingsPanel.field-scope.spec.tsx`
  — the same claims through the REAL panel with only the tRPC transport
  stubbed, because the failure mode being guarded is a prop that is passed and
  then not used. Reverting the one line that applies the filter turns 5 of
  these red.
- `components/settings/__tests__/settings-surface-scope.spec.ts` — a source
  guard pinning both call sites: no hardcoded `nodeId` in `AddonCard`, the
  right `fieldScope` on each, and an `emptyMessage` on the narrowed one.
