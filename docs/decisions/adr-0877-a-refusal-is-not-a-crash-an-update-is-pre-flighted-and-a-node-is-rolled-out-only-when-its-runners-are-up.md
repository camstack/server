---
id: D877
title: A refusal is not a crash, an update is pre-flighted, and a node is rolled out only when its runners are up
status: accepted
date: 2026-10-18
applies-to:
  - packages/system/src/kernel/addon-refused-error.ts
  - packages/system/src/kernel/moleculer/runner-refusal.ts
  - packages/system/src/kernel/moleculer/process-service.ts
  - packages/system/src/kernel/moleculer/addon-runner.ts
  - packages/node-root/src/root-update-service.ts
  - server/backend/src/core/runner-health/runner-boot-check.ts
  - server/backend/src/core/addon/addon-process-view.ts
  - packages/system/src/builtins/alerts/runner-alert.ts
  - scripts/check-no-literal-addon-process-mode.ts
  - scripts/hub/check-node-runners.ts
---

> **2026-10-22:** the only pre-flight check (the D870 legacy-blob guard) is
> retired with the migration it protected; `applyServerUpdate` keeps its
> `updatePreflight` hook, unset until a new deterministic Init refusal exists.

## Context

On 2026-10-17 at 22:41 UTC the hub applied server 1.2.585, the first version with the
D870 legacy-blob guard, on a store that had not been migrated. Twenty-eight addons logged
`refuses to start ... Run scripts/hub/migrate-device-store.ts --copy --apply`, exited with
code 1 at Init five times in ten seconds, and the D6 breaker marked them terminally
`failed` - a refusal handled as if it were a crash loop. After the migration only nine were
respawned (via `updatePackage`); `addons.restartServer` was rejected (`confirm expected
true`), and nineteen runners (reolink, HA, homematic, auth, HAP, alexa ...) stayed dead for
four hours with no durable signal:

- the only announcement was an event (`addon.runner-failed`) whose consumers
  (notification-center, a runner) were among the dead - no push arrived;
- the hub-main alert centre DID record 28 "Addon crash loop" alerts, buried under 140
  "Process crashed" and 34 "Addon crashed" of the same minute in a ring of 500;
- the Addons page showed every addon healthy: `addons.list` stamped each initialized addon
  `process: { mode: 'in-process', state: 'running', pid: <hub pid> }` - a literal;
- the update itself was accepted, swapped and restarted with no question asked about what
  the new version would do to the live store.

## Decision

Four protections, then three that make the failure reach the operator.

1. **The update is pre-flighted.** `applyServerUpdate` asks, before staging, whether the
   target version would refuse any addon on this node's live data, and answers
   `outcome: 'refused'`, `reason: 'addon-would-refuse'` with the addons and the remedy.
   `acknowledgeRefusals: true` overrides it (off by default). Today the one deterministic
   Init refusal the framework can pre-check is the D870 legacy-blob guard; the store-shape
   check is version-independent (unmigrated blob tables present) and is applied to targets
   `>= 1.2.585`. A pre-flight that cannot ask (store not up) does not block - it logs and
   proceeds, because one bad read must not freeze every update.
2. **A refusal is not a crash.** An addon that refuses throws `AddonRefusedError` (typed,
   with a `code` and a `remedy`; `UnmigratedSettingsError` is one). The runner reports it on
   stdout (`REFUSED:<node>:<json>`) and exits with code 78; the exit code is the authority and the
   line is honoured only together with it (any other exit clears it and is a crash). The process service parks the
   runner in the new state `refused` with the reason: it never feeds the D6 breaker, is not
   respawned, and an operator restart / `updatePackage` retries it (it reuses the same
   restart paths as `failed`). It emits `addon.runner-refused` and NO `addon.crashed`, so
   topology, the admin UI and crash rules never read a refusal as a crash. Every settled
   state (`running`, `crashed`, `failed`, `refused`) is announced on `process.state-changed`. There are no timers or
   retry loops (D3); retrying on a store change has no clean hook and is NOT done.
3. **A durable boot check.** One-shot, 60 s after the boot sequence, the node compares the
   runners it PLANNED (hub: `resolveRunnerId` over the forked addons; agent: the runners its
   process service holds, because only the hub plans) with the process-service states, keeps
   `{ expected, running, failed[], refused[], missing[] }` in memory and serves it as
   `runners` on `serverManagement.getServerPackageStatus` and `/health` (`runners.degraded`;
   `ok` is not flipped - a container restart cannot fix a refusal). Absent means "not
   checked yet", never "all well". A runner that is `starting`, or `crashed` waiting on its
   backoff respawn, is `pending`, not failed: the verdict is FINAL only when nothing is
   pending, nothing is announced before that, and the check re-evaluates on each
   `process.state-changed` (in-process, no timer loop) until it settles. A runner stuck in
   `starting` forever keeps the verdict unsettled (visible as `pending`, never pushed).
4. **A truthful `addons.list` and a rollout gate.** `process` is built from the process
   service by `describeAddonProcess` (forked/in-process, pid, state including
   `failed`/`refused`/`missing`, the refusal reason); an unanswered process service is
   `unknown`, never `running`. `scripts/check-no-literal-addon-process-mode.ts` keeps the
   literal out. `scripts/hub/check-node-runners.ts --server <url> [--node <id>]
   --expect-version <v>` exits non-zero when any runner is failed/refused/missing or the
   node runs another version: the post-node rollout gate, in addition to capabilities.
5. **hub-main is the SOLE pusher.** Critical findings raised in hub-main
   (`addon.runner-refused`, `addon.runner-failed`, the settled boot check degraded) are
   delivered by the alert centre straight to the notifiers (`notification-output`), to the
   enabled operator-level targets (or the ids set in the alert centre's settings), whether
   or not notification-center is alive. There is no presence heuristic and no second sender:
   notification-center keeps the state-summary row of `addon-crash-loop` but pushes nothing
   for it (a rule on that kind no longer fires; the summary still lists it). A burst is ONE
   digest per target ("28 addons need attention" with one line each: runner, state, remedy
   - never raw internal error text), gathered over a 2 s coalescing window. Delivery is a
   durable fact on each alert (`metadata.push`), tracked per target: a retry sends only to
   the targets that did not get it, a state delivered everywhere is never sent twice, and a
   `pending` push is retried at alert-centre boot and when `notifiers` or
   `notification-center` start (event + reconcile, D11). One complete message, never a
   follow-up. If the notifiers are down, the alert and the boot-check status are the record.
6. **One alert per runner.** `process.crashed`, `addon.crashed`, `addon.runner-failed` and
   `addon.runner-refused` of one `(node, runner)` fold into ONE alert that updates its count
   and state (`refused` and `failed` are terminal and never downgraded by a later crash), so
   a burst can no longer push other alerts out of the ring. A runner reaching `running`
   closes its alert; a failure after that opens a NEW episode, and the push key is
   episode + cause, so it is pushed again - while the same refusal repeated within an
   episode is not.
7. **The Addons page shows it.** The truthful `process` drives a per-card banner (failed /
   refused with the addon's own reason and remedy / missing) and an "In error" filter chip
   with a count (`?error=1`).

## Consequences

- The pre-flight protects updates FROM this version onwards; an update from an older hub
  never ran it. It only knows the refusals listed in `update-preflight.ts` - a new
  deterministic Init refusal has to be added there to be pre-checked. **Agent updates are
  NOT pre-flighted**: an agent has no store of its own and no hook is wired, so
  `acknowledgeRefusals` is accepted and ignored there. The hub's pre-flight covers the
  shared store, "Update all nodes" updates the hub last, and the rollout gate
  (`check-node-runners.ts`) is what catches an agent whose runners refused.
  `acknowledgeRefusals` is a field of the `applyServerUpdate` cap input, so it is admin-gated
  exactly like the method.
- The agent boot check cannot name a MISSING runner (`planKnown: false`): the hub plans.
- The critical push goes to every enabled operator-level notifier target by default; an
  operator who does not want that sets the target ids or switches it off in the alert
  centre settings.
- `AddonRefusedError` is the contract for any future "I will not start, and here is why":
  throw it instead of an Error, or the breaker will count it.
- A rule on the `addon-crash-loop` system-event kind no longer pushes (the state summary
  still lists it): the alert centre's critical push replaced it.

## Enforcement

`scripts/check-no-literal-addon-process-mode.ts` (wired into `checks.yml`). Specs:
`process-service-refusal.spec.ts` (6 refusals never reach `failed`, no respawn, restart
retries), `root-update-preflight.spec.ts`, `runner-boot-check.spec.ts`,
`update-preflight.spec.ts`, `addon-process-view.spec.ts`, `alert-episodes.spec.ts` (D890: the push itself is gone),
`alerts-runner-burst.spec.ts`, `crash-loop-not-pushed.spec.ts`, `check-node-runners.spec.ts`. Each was disarmed (the fix
removed, the spec seen to fail).

> **Amended by [D890](adr-0890-the-alert-centre-notifies-nothing-an-alert-reaches-a-phone-only-through-a-system-event-rule.md):** the alert centre's own digest push described above was removed; a runner failure is a critical alert notified through an `alert-critical` rule.
