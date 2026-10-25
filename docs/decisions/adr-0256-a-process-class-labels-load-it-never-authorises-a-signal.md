---
id: D256
title: A process class labels load; it never authorises a signal — the Processes page is a monitor
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - packages/system/src/builtins/native-metrics/process-classification.ts
  - packages/system/src/builtins/native-metrics/native-metrics.addon.ts
  - packages/addon-admin-ui/src/components/cluster/tabs/ProcessesTab.tsx
---

## Context

`metricsProvider.listNodeProcesses` classified every camstack-shaped process on
a node into four classes. Three were identities (`root` = this pid, `managed` =
a pid in the kernel's `$process.list`, `system` = crossed a supervisor
boundary). The fourth, `ghost`, was a *verdict*: `classifyByAncestry` walked
pid→ppid and declared an orphan whenever the walk reached `ppid=1` — or a
parent `ps` could not see — without crossing `SUPERVISOR_BOUNDARY_RE`.

`ghost` was also the only class `metricsProvider.killProcess` would signal, and
the admin UI built a red tile, a Ghost-only filter, a "recurring ghost parents"
tree-kill and a "Kill all N ghost(s)" bulk action on top of it.

`SUPERVISOR_BOUNDARY_RE` was entirely a dev-workstation list: `tsx watch …
launcher.ts`, the agent CLI, `concurrently`, `vite`, `npm exec`. Production has
none of those shapes. The definition did not age out — **it never knew
production**. Measured read-only across the three live nodes on 2026-08-27:

| node | «ghosts» | what they actually were |
| --- | --- | --- |
| `hub` | 1 | `pid 1` = `tini -- docker-entrypoint.sh … starter.js` |
| `agent-a` | 1 | same |
| `MacMiniAgent.localdomain` | 4 | `/Applications/camstack.app` + 3 Electron helpers |

Six detections, six false positives, zero true ones — and the bulk action aimed
SIGKILL at pid 1 while the tree-kill button aimed at the operator's own desktop
app. Nothing downstream stopped either, because `killProcess` refused only
`root` and `system`. The alarm surfaces were removed first, which
left the classifier and the kill path intact and the `Class` column still
reporting a verdict that was wrong every time it fired.

The obvious next move — teach the classifier the container and desktop shapes —
was rejected. Every candidate signal is negative evidence (`ppid == 1`, a parent
missing from a `ps` snapshot), and negative evidence is the normal state of a
container init, a launchd-started app, and anything a service manager owns.

## Decision

A process classification is a **label for attributing load**, not a licence to
act. It has exactly three values — `root`, `managed`, `system` — decided by
identity, never by an ancestry walk. There is no orphan class.

Nothing in the cluster signals a raw pid. `metricsProvider.killProcess` and
every affordance that reached it are deleted; Cluster → Node → Processes is a
read-only monitor whose purpose is per-addon CPU and RSS. A runner's lifecycle
belongs to `CrashSupervisor` and is driven through `addons.restartAddon` /
`$process.restart` — a raw signal goes around the supervisor's respawn budget,
which is exactly what D6 exists to prevent.

Detecting a *real* orphan remains legitimate, but it may not restart from an
ancestry walk gated on a hand-written list of supervisor command lines. The
evidence must be positive: a pid the cluster itself spawned, no longer in
`$process.list`, whose runner is gone. Anything weaker does not get to name a
process disposable — and it still would not earn a kill button, which is a
separate decision.

## Consequences

- `NodeProcess.classification` loses `ghost` and `NodeProcess.orphaned` (which
  was `classification === 'ghost'` under another name) disappears from the
  `metrics.node-processes-snapshot` payload.
- The cap loses a mutation. `metricsProvider` is now read-only apart from
  `dumpHeapSnapshot`, which resolves its pid from `$process.list` and so can
  only ever reach a runner this node spawned.
- An operator who wants a runner gone uses its addon page. There is no longer a
  way to kill a leaked non-managed process from the UI; that is accepted,
  because the class that claimed to identify one never did.
- `packages/addon-admin-ui/src/components/cluster/load/load-series.ts` still
  types `classification` with a `'ghost'` member it can no longer receive. It
  never branched on it (`bucketFor` sends anything unmanaged to
  `__unattributed__`), so behaviour is unaffected; the dead union member is left
  for the owner of that directory to drop.

## Enforcement

- `packages/system/src/builtins/native-metrics/__tests__/process-classification.spec.ts`
  pins the six real production shapes — the container init at pid 1, the desktop
  app, its three helpers — as `system`, and pins that only the three classes are
  ever emitted.
- `packages/addon-admin-ui/src/components/cluster/tabs/__tests__/ProcessesTab.spec.tsx`
  asserts no rendered control matches SIGTERM / SIGKILL / kill / term on any
  class, and deliberately does **not** stub `useMetricsProviderKillProcess`, so a
  component that reaches for the hook again throws at render.
- `scripts/check-method-tiers.ts` fails on a re-added cap method until its tier
  is pinned in `scripts/method-tier-baseline.json` on purpose.
