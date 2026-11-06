---
id: D1017
title: An addon below the server's minimum runs, and the operator is alerted
status: accepted
date: 2026-11-07
supersedes: D989 (its spawn hold-back only; the single framework package and the delivery requirements stand)
applies-to:
  - server/backend/src/agent/stale-addon-gate.ts
  - server/backend/src/core/addon/hub-addon-support.ts
  - server/backend/src/core/addon/boot-health-snapshot.ts
  - packages/system/src/kernel/unsupported-addon-tracker.ts
  - packages/system/src/builtins/alerts/alerts.addon.ts
---

## Context

D989 made the framework one package and let every package declare the server it
needs (`camstack.requires`). Built on it, the hub (planning#447) and the agent
(#346) judged each addon at spawn and HELD BACK one whose installed package was
below what the running server requires, so it would not crash-loop before the
post-swap update reached it. The hold-back grew machinery: a held-back ledger, a
quiet retry on the health monitor, an exception for infrastructure providers
(holding storage left the node with none), and a runner plan that no longer
matched the boot check.

A held-back addon is invisible. It loses its function with no alert, the runner
boot check reported `DEGRADED: ... failed: <group>` for a group nobody had
started, and the infra exception existed only because the rule was wrong for the
one case that hurt most.

## Decision

An addon whose installed package is below the minimum the running server requires
(`camstack.requires.addons` of the server, or its own `requires.server`) ALWAYS
starts, on the hub and on agents, infrastructure or not. The gate's judgement
(`judgeSupport`) is kept, but its verdict means "alert", not "do not spawn".

The `UnsupportedAddonTracker` turns the verdict into the usual AlertCenter path:
`AddonUnsupportedVersion` (`addon.unsupported-version`) once per streak - the same
package, installed version and unmet facts - naming addon, installed version,
required minimum and server version, and `AddonUnsupportedResolved`
(`addon.unsupported-resolved`) when a later judgement finds the package supported.
AlertCenter keys one card per node and package and dismisses it on the resolve
edge. A package whose requirements cannot be read, or a server whose version
cannot be read, is unknown: the addon runs and no alert is raised. Auto-update
and the reconcile toward the required version are unchanged.

## Consequences

An unsupported addon may crash. `CrashSupervisor` (D6) bounds the respawns and
marks the runner `failed`, which is visible; a silent hold-back was not. The
held-back ledger, the monitor's `recordHeldBack` retry and the infra exception are
gone, and the hub's planned runners are exactly the spawned ones, so a runner
hosting an unsupported addon counts as running in the boot check.

## Enforcement

`hub-spawn-plan.spec.ts` (real registry, real package files: every addon is in the
spawned roster, one alert with both versions, the resolve edge, the boot check),
`stale-addon-gate.spec.ts` (the agent path), `unsupported-addon-tracker.spec.ts`
and `alerts.addon.spec.ts`.
