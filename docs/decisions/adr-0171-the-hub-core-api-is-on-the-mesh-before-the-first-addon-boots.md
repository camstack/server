---
id: D171
title: The hub-core API is on the mesh before the first addon boots — and the boot plan fans out
status: accepted
date: 2026-08-15
supersedes:
applies-to:
  - server/backend/src/boot/init-sequence.ts
  - server/backend/src/core/addon/runner-spawn-fanout.ts
---

## Context

[D167](adr-0167-boot-fans-out-nothing-serialises-on-a-read-that-cannot-answer.md) fixed three serial loops on the boot path and named, but did
not fix, the asymmetry underneath the worst of them.

**A hub-core cap could not be answered during addon boot, by construction.**
The hub's core (non-addon) tRPC routers reach the cluster as the `$core-caps`
Moleculer service, and `main.ts` registered that service only *after*
`app.init()` returned. `app.init()` is where the entire addon boot runs. So for
the whole of addon boot, every `ctx.api.<coreCap>` call was not slow — it was
unanswerable: `brokerTransportLink` polled the full
`DEFAULT_DISCOVERY_TIMEOUT_MS` (30 s) and fast-failed, with no boot-window
retry, because core caps are excluded from it. A non-core cap in the same
position gets 3 s and a retry. D167 fixed the one call site that hurt
(`armBlocksIntegration`); the 30 s was still there for the next one.

The first thing tried was the obvious one: move `registerCoreCapService` earlier
in `main.ts`. It does not work on its own. The service schema is built by
walking the appRouter, so the router has to exist first, and the router was
built after `app.init()` under a comment claiming it "depends on their results".
That claim was stale: `buildCapabilityRouters` is driven by
`ALL_CAPABILITY_DEFINITIONS` — declared *before* `app.init()` — and every
provider, registry singleton or `server-provided` factory, is resolved **per
request**, not at build time. Nothing in the router's construction reads a value
that `onModuleInit` produces.

The second thing tried was a placeholder service registered early and swapped
later. It cannot work: Moleculer's discovery matches on the *action* name, so a
service with no actions is not discoverable, and the action list only exists
once the router does. And a handler that *waits* for the real router would
deadlock — the caller is `core-blocks.onInitialize()`, which runs inside the
very `app.init()` it would be waiting on. Today only the 30 s timeout saves it.

**Separately, the runner plan summed what it could have overlapped.**
`spawnRunnerPlan` was `for (…of plan) await initializeAddonGroup(…)`. The fork
is cheap — `$process.spawnRunner` returns on the pid — but each iteration also
does a dynamic `import()` of the addon's built bundle *inside the hub process*,
purely to read its `customActions` export. Forty module graphs evaluated one
after another were ~4 s of the measured 10 s kernel boot, growing linearly with
every addon shipped. Nothing in a plan is ordered: `buildAddonGroupPlan` keys by
runner id, `resolveRunnerId` is `execution.group ?? addonId`, and no code reads
the iteration order. The ordering that *is* load-bearing is between the plans
(forked addons → in-process builtins → isolated builtins), and it is documented
where it lives.

## Decision

**Work the boot needs to CALL is published before the boot that calls it, and a
plan of independent units is never iterated serially.**

Concretely:

- The boot init sequence has one named seam, `beforeAddonBoot`, which runs with
  the broker started and before a single addon has booted
  (`boot/init-sequence.ts`). `$core-caps` is mounted there. This is a two-phase
  registration and it is stated as one: **the route is on the mesh immediately;
  each provider behind it completes on its own schedule.** A caller that is
  early gets an immediate, typed answer — including an immediate failure —
  instead of thirty seconds of silence. Anything else that must be *callable*
  during addon boot goes in the same seam, not after `init()`.
- A hub-core cap read from `initialize()` is still wrong (D167), and this does
  not license one. It removes the 30 s, not the ordering hazard.
- `spawnRunnerPlan` runs its units through a bounded lane pool
  (`RUNNER_SPAWN_CONCURRENCY = 8`). The bound protects the hub's event loop —
  which has to answer the children's UDS handshakes while their bundles are
  being parsed — not the code.

## Consequences

**The router is built once, before init, and handed to Fastify after it.** The
comment that said otherwise is gone. What has to stay true for this to keep
holding: no cap router may read state at *build* time. A router that snapshots
the capability registry, rather than resolving through it per request, would
silently serve an empty hub. `buildCapRouters` iterating `ALL_CAPABILITY_DEFINITIONS`
is what makes it safe, and that is the property to protect.

**`trpcRegistered` still flips only when Fastify has the router.** The readiness
flag means "HTTP is serving", and moving the build earlier must not make the
health route claim readiness sooner than it is true.

**A failed early registration degrades, never aborts.** A hub without the bridge
fast-fails core-cap calls; a hub that refuses to start is down. `main.ts`
catches, logs, and retries the registration once on the original late path.

**Overlapping the plan exposes exactly one shared resource: Node's
`require.cache`.** Loading a custom-action catalog purges the cache under the
addon's entry directory before importing — process-global mutation that was
implicitly safe only because the loop was serial. `@camstack/addon-remote-storage`
ships three addon ids resolving into one `dist/`, each on its own runner, all in
the same plan; overlapped, one sibling's purge could evict a module graph
mid-evaluation. Purge-and-import is therefore serialised **per directory**
(`createKeyedSerializer`) while different directories still overlap. Any future
process-global touched inside a plan unit needs the same treatment or the same
argument for why it does not.

**Spawn ordering within a plan is no longer observable.** It never was
load-bearing, and now nothing may make it so. `addon.started` lifecycle events
arrive as a burst rather than a sequence.

## Enforcement

Tests, each of which fails when its fix is removed:

- `server/backend/src/boot/__tests__/init-sequence.spec.ts` — pins that
  `beforeAddonBoot` runs after the broker and strictly before addon boot, that
  it is **awaited** (a fire-and-forget hook would leave the mesh bridge absent
  for exactly the window it exists to cover), and that a failure propagates to
  the caller rather than being swallowed by the sequence.
- `server/backend/src/core/addon/__tests__/runner-spawn-fanout.spec.ts` — pins
  the peak overlap and the bound, that a slow runner no longer delays the rest,
  that same-key work never interleaves (the `require.cache` gate) while
  different keys do, and that a rejecting predecessor neither cancels nor
  poisons its successors.

No guard script for the seam. "Is this call reachable during addon boot?" is a
reachability question over `ctx.api`, and a guard that answered it approximately
would either miss the real cases or block honest ones. Review, against this
record.

Related and shipped alongside: `BOOT_RECOVERY_BACKOFF_MS`
(`packages/types/src/util/boot-recovery-backoff.ts`) — the one retry schedule
for work that can fail merely because the node was still booting. It replaces
two byte-identical 5 m → 15 m → 30 m → 60 m chains (device feature probe,
Tailscale auto-rejoin) that both presumed a healthy hub, with 15 s → 60 s in
front of the same long tail.
