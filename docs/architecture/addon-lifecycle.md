---
title: Addon lifecycle
applies-to:
  - packages/system/src/kernel/addon-loader.ts
  - server/backend/src/core/addon/addon-registry.service.ts
  - server/backend/src/core/moleculer/moleculer.service.ts
  - packages/system/src/kernel/moleculer/addon-runner.ts
  - packages/system/src/kernel/moleculer/init-watchdog.ts
  - packages/system/src/kernel/moleculer/crash-supervisor.ts
  - packages/system/src/kernel/moleculer/process-service.ts
  - packages/system/src/kernel/moleculer/runner-refusal.ts
  - packages/system/src/kernel/addon-refused-error.ts
  - packages/system/src/kernel/moleculer/runner-heap-flags.ts
  - packages/system/src/kernel/moleculer/runner-process-group.ts
  - packages/system/src/kernel/moleculer/addon-context-factory.ts
  - packages/system/src/kernel/moleculer/device-cap-proxy.ts
  - packages/system/src/kernel/isolated-builtin-phase.ts
  - packages/system/src/kernel/settings-door-view.ts
  - packages/system/src/kernel/config-manager.ts
  - server/backend/src/launcher.ts
  - server/backend/src/core/agent/agent-registry.service.ts
  - server/backend/src/core/agent/agent-addon-backfill.ts
  - server/backend/src/core/agent/agent-desired-set.ts
  - server/backend/src/core/agent/agent-delivery-ledger.ts
last-verified: 2026-10-15
---

# Addon lifecycle

Four operator verbs — install, update, uninstall, restart — reduce to two
operations: spawn an `addon-runner`, or stop one. There is no in-process
hot-reload ([D5](../decisions/adr-0005.md)).

## Process topology

One addon, one process. Co-location is opt-in via a shared `execution.group`
string, and the runner id is resolved by exactly one function — `resolveRunnerId`
in `packages/types/src/interfaces/addon.ts` ([D2](../decisions/adr-0002.md)).

Both spawn paths call it:

| Path | When |
| --- | --- |
| `buildAddonGroupPlan` | boot |
| `ensureForkedRunner` | hot-install, retry, operator restart, deploy hot-reload |

That symmetry is the point. When grouping was derived in two places, a respawn
produced a different topology than a cold boot.

**Every call that spawns a runner happens inside one critical section per runner
id.** `ensureForkedRunner` is not one action: it READS the running processes,
STOPS the stale ones, then SPAWNS the roster — three awaits, and the unit that has
to be atomic is all three. `process-service`'s `withRunnerLock` makes each action
atomic on its own, which is a different guarantee: two concurrent converges both
read "not running", both stop, and both spawn. Two children, one map entry, and
the one nobody tracks keeps running — it answers HomeKit, it holds its ffmpeg
grandchildren, and only a signal sent by hand removes it. `createRunnerSerializer`
(`server/backend/src/core/addon/runner-serialization.ts`) is a FIFO promise chain
per runner id, held by `AddonRegistryService`; different runners still converge in
parallel, and a converge that throws does not wedge the ones behind it.

Measured twice on the live hub. 2026-09-16, a deploy plus an operator
`restartAddon`: one "shutting down" and THREE runners started within five seconds.
2026-09-17, with **no** manual restart — a container reboot's own spawn meeting the
restart a deploy fires for itself — two runners started in the same second and
every camera was published to HomeKit twice. The first diagnosis blamed the
operator restart and the second episode disproved it: any two lifecycle operations
racing on one runner do this, and a deploy supplies both by itself.

The invariant is **not** "this function is serialized". Serializing only
`ensureForkedRunner` lost on the very next deploy, because the boot path
`initializeAddonGroup` reaches `$process.spawnRunner` directly — two spawn paths
with one of them serialized is the same race with a smaller window. The test
therefore enumerates the call sites rather than exercising one of them, and a
future third path fails it until it is inside the section.

Updating one member of a group respawns the whole group — they share a process.

**Nothing in a plan is ordered, so the boot plan FANS OUT.** `spawnRunnerPlan`
used to `await` one group after another, and each iteration also dynamic-imported
the addon's built bundle inside the hub process just to read its `customActions`
export — forty module graphs evaluated in series were ~4 s of a 10 s kernel boot
and grew with every addon shipped. It is now a bounded lane pool,
`RUNNER_SPAWN_CONCURRENCY = 8` (`server/backend/src/core/addon/runner-spawn-fanout.ts`).
The bound is not decoration: the hub's event loop has to answer the children's
UDS handshakes while their bundles are being parsed.

**And hub-main now evaluates no addon bundle at all.** The import survived the
fan-out — it had moved, not gone, and still ran at every spawn and every hot
update to read one export, 9.3 MB of `pipeline-orchestrator` inside hub-main per
deploy, pinning each evicted graph's module scope. The catalog travels in the
runner's post-init register frame instead, schemas stripped, from the process
that owns the addon ([D444](../decisions/adr-0444-hub-main-measures-its-own-episodes-bounds-its-readers-and-reads-no-bundle.md));
with nothing left to purge and re-import, `require-cache.ts` and the guard that
watched it are deleted (D284 superseded). <!-- drift-ok: naming a file whose deletion is the point -->

### `@camstack/system` builtins, and the ones that are not in hub-main

Builtins are the exception to "one addon, one process": they load in the hub
ROOT process. The reason is narrow — storage, settings, logging and
device-manager must be resident in the process every runner depends on — but the
filter that implements it is a package-name test, so it swept up every builtin,
including ones that hold no infrastructure at all.

A manifest entry opts out with `execution.isolate: true`. Such a builtin is
planned, spawned, restarted, route-mounted and uninstalled exactly like any
other forked addon; `resolveRunnerId` still owns its runner id. Two entries
declare it:

- `snapshot` — camera capture, sharp resizes, JPEG caches
  ([D123](../decisions/adr-0123.md)).
- `sqlite-settings` — the WAL engine behind `settings-store`. `better-sqlite3`
  `Statement.run` does not belong on the loop that serves the API
  ([D231](../decisions/adr-0231-sqlite-settings-forks-infra-isolates-spawn-before-the-door.md)).
  `storage-orchestrator` stays in-process and owns the door.

They are **not** one spawn wave. `isolatedBuiltinPhase` splits them:

- **infra** (provides a capability in `INFRA_CAPABILITIES`) — spawned BEFORE
  in-process builtins. sqlite-settings is the engine the door dispatches to;
  spawn it after and every in-process builtin initialises against a missing
  store (the D44 empty-read failure).
- **consumer** — spawned AFTER, as D123 required. Snapshot persists behind
  `settings-store`.

`ctx.getNativeProvider` still leaves the process for a forked wrapper: it
cannot resolve its own cap name, so the call goes out over UDS with
`native: true` and is answered by the parent's `CapabilityRegistry`. Absence
surfaces as a rejection, not `null`.

When the engine is isolated, ConfigManager has no sync `ISettingsStore`.
In-process `ctx.settings` is `createDoorSettingsView` over the async door, so
hub-main can yield while `Statement.run` occupies the child.

Spawn-before-door is not enough. `applyNodeManifest` used to skip every
infra capability on every handshake, so the child's `data-store-provider`
never entered the parent's `getCollection` and the door had nothing behind
it (1.2.149). A hub-local child that provides an infra cap is proxied; a
remote agent's is not ([D233](../decisions/adr-0233-hub-local-isolated-infra-is-proxied.md)).
Spawn still returns when the child *process* exists, not when the handshake
has landed: 1.2.150 proxied the cap and still skipped device-manager because
the door was empty for four seconds.

Boot is `runHubAddonBoot` ([D234](../decisions/adr-0234-forked-addons-spawn-after-settings-door.md)):
wait until `getCollection('data-store-provider')` is non-empty, boot the
in-process door, *then* spawn every other forked addon. Waiting after the
other forks (1.2.151–1.2.153) let cloudflare-tunnel `resolveConfig()`
against constructor defaults and auto-start a quick tunnel while
notifications still minted the named hostname (Cloudflare 530, 2026-08-25).
`waitUntilReady` yields via `setTimeout`; the 1.2.151 deadlock was sqlite
waiting on the door (now a no-op), not the wait blocking the UDS read. A
timeout logs and continues — throwing aborted bootstrap and crash-looped
the starter. sqlite-settings still skips `resolveConfig` — it has no stored
config of its own. `addons.listCapabilityProviders({ capName: "data-store-provider" })`
is how you tell the engine registered — HTTP `/health` stays 200 either way.

The fork predicate is `AddonRegistryService.runsInOwnRunner`, and it is the ONLY
one: the plan, the in-process boot filter and `isForkedAddonEntry` all read it.
They were separate once and disagreed, and `auth-oidc` mounted its routes
against an async UDS proxy.

### On an AGENT there is no engine at all

Everything above is hub boot. An agent's Phase 1 walks
`resolveAgentInfraCapabilities(process.env)`, which is `INFRA_CAPABILITIES`
minus `data-store-provider` — so `sqlite-settings` is never instantiated and no
`camstack.db` is created ([D332](../decisions/adr-0332-an-agent-has-no-store-of-its-own.md)).
Persistence is the hub's, and the agent's `settings-store` door forwards there
over `$hub-cap-fwd.forward` (`hub-settings-forward.ts`). A **local engine always
wins** over that remote, so the rollback is a single env var on the container —
`CAMSTACK_AGENT_LOCAL_DATA_STORE=1` — and no redeploy.

Two things follow that surprise people. Reads REJECT when the hub is
unreachable, never answering empty — an empty answer is indistinguishable from
an empty store, and the next read-modify-write would persist the patch alone.
And the agent's `storage_locations` stay in memory, re-seeded from declarations
at every boot: that table is keyed by a bare location id every node shares, so
forwarding it would land on the hub's rows.

### A runner's V8 heap is shaped by the manifests it hosts

The spawn argv of every forked runner is computed by ONE function,
`runnerHeapFlags` (`packages/system/src/kernel/moleculer/runner-heap-flags.ts`),
from the `execution` block of each hosted addon's manifest — never from an
environment variable, never from a table of addon names in the kernel. The
flags must be on the command line: `v8.setFlagsFromString` at runtime moves
neither the young generation nor the old space.

| Manifest field | Flag | Default when omitted | Grouped runner |
| --- | --- | --- | --- |
| `heapProfile: 'light'` (default) | `--max-semi-space-size=2 --v8-pool-size=2` | — | heavy if ANY member is heavy |
| `heapProfile: 'heavy'` | `--max-old-space-size=1024` (`HEAVY_MAX_OLD_MB_DEFAULT`) | — | — |
| `maxOldSpaceMb` | `--max-old-space-size=<n>` (`0` = none) | the class default | MAX; `0` wins |
| `semiSpaceMb` (1–256) | `--max-semi-space-size=<n>` | the class default (2 light, V8's 64 heavy) | MAX |
| `initialOldSpaceMb` (16–65536) | `--initial-old-space-size=<n>`, clamped to the ceiling | V8 grows it from the live set | MAX |
| `rssBudgetMb` | `CAMSTACK_RUNNER_RSS_BUDGET_MB` (env, the watchdog's alarm) | unwatched, said at boot | MAX |

Every value is the MAXIMUM across the group ([D2](../decisions/adr-0002.md),
[D29](../decisions/adr-0029.md)): a runner is respawned as a whole, so a
co-tenant's smaller number must never silence or starve the hungriest member.
An out-of-range `semiSpaceMb` / `initialOldSpaceMb` is not a declaration — the
class default stays — rather than being clamped, so the spawn log line
(`heap profile: … flags=[…]`) never says something the manifest does not.

Why the two shaping fields exist, and why only `stream-broker` declares them
(8 / 512): a heavy runner keeps V8's 64 MB young generation, which is right for
a process with a large live heap and wrong for one whose live old space is
small while its allocation rate is enormous. V8 sizes the headroom after a
mark-compact from the live set (~0.5×); when that headroom sits BELOW the young
generation, every scavenge promotes enough to restart incremental marking, and
the process never scavenges at all. The hub's broker (~100 MB live, ~11 k RTP
packets/s over 47 sources) ran 166–232 major GCs a minute and zero minors at
45–62 % of a core. Reproduced with the opt-in bench
(`npm run bench:stream-broker-gc`, which spawns the real broker under the flags
`runnerHeapFlags` computes for the shipped manifest): 232.5 → 21.0 majors/min,
0 → 223 scavenges/min, CPU 61.9 → 20.7 %, GC pause 1 886 → 102 ms per 5 min
(256 MB initial old space: 33.0 / 36.0 % / 1 377 ms — the 512 reservation is
old-space headroom the broker's 2 048 MB RSS budget already allows). The bench
with `--flags today` (class default) is the disarm proof and is expected RED.
Measurements in `docs/architecture/data-planes.md` § "Streaming" hold the
allocation-side changes that landed with it.

## Registration

A runner finishes boot, then hands its **complete** manifest over in one
`registerNode` RPC, which atomically replaces that node's capability set. Retried
until acked; reconnect is the same call ([D3](../decisions/adr-0003.md)). Nothing
polls, scans or waits.

### `initialize()` is on the critical path of the whole capability graph

`addon-runner.ts` appends an addon's entry to `runnerManifest` **after**
`await addon.initialize(context)` returns, and calls `refreshChildCaps('post-init')`
— the one UDS registration handshake — only after the whole load loop. So an
`initialize()` that does not return does not merely delay one feature: **the
manifest is never published, and every capability that addon declares is absent
cluster-wide.**

That is not a hypothetical. On 2026-08-14 a nightly timelapse window came due at
boot, `NotificationCenter.start()` awaited a `TimelapseScheduler` tick, a tick
RENDERS VIDEO, and the render timeout is 30 minutes per (rule, camera) pair —
so every capability `pipeline-analytics` declares answered "provider not
available" on all three nodes while the runner stayed alive and logged a reload tick every
30 seconds. Process health, a successful `addons.restartAddon` and a busy log
all read identically either way; `addons.listCapabilityProviders` is the only
answer to "did it register".

Two rules follow:

- **Any `await` in `initialize()` that can outlive a boot is an outage with a
  fixed blast radius.** Work that renders, fetches or polls belongs on the tick
  after the producer is armed. A `start()` resolving means "the producer is
  running", never "the back-fill has finished" — arm the interval, hand the
  back-fill to the background, and let the normal tick retry whatever is
  unstamped.
- **The stall is now named, not bounded.** `startInitWatchdog`
  (`packages/system/src/kernel/moleculer/init-watchdog.ts`) is armed around every
  `initialize()` and warns at `INIT_WATCHDOG_FIRST_MS` (60 s), then every
  `INIT_WATCHDOG_REPEAT_MS` (5 min), naming the addon and listing the exact
  capabilities the stall is holding offline (`unpublishedCapabilities`). It
  deliberately does **not** abort or kill anything: bounding `initialize()` would
  respawn a half-initialised addon in a loop.

## Node convergence

The hub owns every node's addon set ([D982](../decisions/adr-0982-the-hub-owns-every-nodes-addon-set.md)).
An agent converges to a **desired set** the hub computes (`agent-desired-set.ts`,
a pure function) and never keeps an addon on its own say:

| Part of the desired set | Rule |
| --- | --- |
| Hub packages | every package the hub installs whose addons are all `any-node` (a package with a `hub-only` addon is never wanted; one whose addons are ALL `hub-only` is a leftover), at the hub's version |
| Agent-tracked packages | `@camstack/addon-agent-ui`, which the hub never loads: the hub follows the registry's `latest` for it, so `addons.updatePackage` for it fans out to every online agent |
| Tombstones | a package removed on purpose from a node (a hub uninstall for it, an operator undeploy) stays off it; an explicit delivery to that node lifts it |
| Never managed | `@camstack/system` |

The diff against the node's reported roster is **install** (missing), **update**
(behind, or AHEAD of the hub: D942) and **remove** (tombstoned, or a hub-only
leftover — each removal is logged with its reason). The roster a node declared
(`ClusterNodeHistoryStore`) is history, never intent, so a node that already had a
roster still receives an any-node addon added to the hub later.

A convergence round runs **on registration**, **after a hub install / update /
uninstall** (`hub-change`) and **every 10 minutes for every online agent**
(`periodic`; `ADDON_CONVERGENCE_INTERVAL_MS`). Rounds that arrive while one runs
collapse into one more; a round never gates registration (D3) and a failed
delivery waits for the next round. The decl-level stale sweep below keeps its
connect-time blast radius and does not run on the scheduled rounds. The whole
convergence is **dry run until `addons.convergence.dryRun` is set to `false`**:
it logs the plan (`convergence plan (DRY RUN, nothing applied)`) and applies
nothing.

Registration also still runs the decl-level stale sweep ([D24](../decisions/adr-0024.md)):
an addon on the node that the hub does not install, or installs as `hub-only`, is
undeployed. Bootstrap infrastructure (`@camstack/system`,
`@camstack/addon-agent-ui`) never is. The agent has no local uninstall path:
`$agent.undeploy` is called only by the hub (an operator uninstall, the sweep, or
a convergence removal).

Failed deliveries are bounded by the same circuit-breaker shape as crashes:
`MAX_BACKFILL_ATTEMPTS` per `(node, package, version)`, then retired with a log
line saying the node is running without that package. A node missing capabilities
never merely looks healthy.

**The back-fill only reacts to a gap the node owns.** A hub delivery makes the
node's roster lie for its whole duration — `$agent.deploy` evicts the package's
declaration ids and `$agent.reload` re-registers every runner — and reacting to
that gap re-installed over every agent deploy on 2026-08-07. Three gates, each
pinned by a test that fails without it:

| Gate | Rule |
| --- | --- |
| trigger allowlist | the pass names why it runs; only `node-registration`, `hub-boot`, `operator-repair`, `hub-change` and `periodic` may install |
| delivery window | a node the hub is writing to (or finished writing to under `DELIVERY_GRACE_MS` ago) is never back-filled |
| confirmation read | a second `$agent.status` must agree the package is absent (install) or still present (removal) ([D49](../decisions/adr-0049.md)); a failed read is refused, not treated as agreement |

Both a delivery and a refusal are logged, with the source of the bytes and the
gate that stopped it. `clusterNodes.repairNodeAddons` is the operator's explicit
override. Where the addons may live at all — one root per node, and what may
never write it — is
[update-and-release.md](update-and-release.md#the-canonical-topology--one-addon-root-per-node).

## Uninstall — per node and everywhere

`addons.uninstallPackage({ packageName, nodeId?, everywhere? })`
(`server/backend/src/core/addon/addon-uninstall.ts`,
[D766](../decisions/adr-0766-an-uninstall-names-its-nodes-and-the-hubs-install-set-bounds-the-back-fill.md)):

| Call | Does |
| --- | --- |
| no `nodeId` (or `hub`) | the hub's `uninstallAndReload`, unchanged — throws on failure |
| an agent `nodeId` | the agent's `$agent.undeploy({ packageName, addonId })`, then prunes the package from that node's declared roster |
| `everywhere: true` | every node that has it — agents first, the hub last; an offline node answers `pending-reconnect` (record pruned; the stale sweep removes the copy when it registers, as long as the hub no longer installs it) |

Every mode answers per node — `uninstalled`, `not-installed`, `refused`,
`failed` or `pending-reconnect` — and the two cluster modes report a node's
failure instead of throwing. A package the hub's `isProtected` names is refused
before any node is touched. `addons.listInstallations` answers which nodes have
a package (hub installer, online agents' `$agent.status` in parallel, offline
agents' declared roster), with `unreachable` for an agent that did not answer.
The lifecycle job engine stays hub-local; its refusal for `kind: 'uninstall'`
points here.

**On the agent, removing an addon stops its runner.** `$agent.undeploy`
(`server/backend/src/agent/agent-undeploy.ts`) used to shut down an in-process
instance, destroy its Moleculer service and delete its folder — on an agent,
where nearly every addon lives in a group runner, that left the process running
and advertising its caps (decoder-ffmpeg on two agents, 2026-10-08). It now:
refuses the node's bootstrap packages and any manifest entry marked
`protected: true`; stops every runner hosting the addon (`$process.stop`, group
reap included); respawns a shared runner's survivors without it; drops the
agent-registry cap proxies and the `loadedAddons` rows; deletes the code; and
re-registers upward. `{ packageName }` finds the package's addons from the
on-disk manifest, so a copy that never loaded is still removed; `{ addonId }` is
the stale-addon reconcile's per-id removal and gets the same runner stop.

An agent that predates this answers `{ success, addonId }`. The hub sends
`addonId` alongside `packageName` so it still deletes the code, and the result
carries `this agent predates runner teardown` — its runner lives until the agent
restarts. Update agents before relying on a cluster-wide uninstall.

## Crash handling

`CrashSupervisor` respawns with exponential backoff and stops after
`MAX_CRASHES_IN_WINDOW` crashes inside `CRASH_WINDOW_MS`, marking the runner
`failed` — terminal ([D6](../decisions/adr-0006.md)). A persistently broken addon
fails loudly with its first stack trace intact, instead of busy-looping.

**A trip is an OUTAGE, and it is announced.** Bounding the respawns was never
the missing half — being told was. On 2026-08-18 the `recorder` runner died
three times in nine seconds of unhandled `spawn ffmpeg EAGAIN`, the breaker
tripped exactly as designed, and the whole fleet stopped recording for three
hours and fifteen minutes: `/health` returned 200 throughout, the hub answered
`Capability "recording" provider not available`, and no event was emitted at
all. The trip now also emits `EventCategory.AddonRunnerFailed`
(`addon.runner-failed`) — ONE event per trip, not per hosted addon, carrying
the node, the runner, the addons it hosted and the crash count — which the
Notification Center's intake maps to the `addon-crash-loop` system-event kind
(node-scoped, no device). The breaker itself is unchanged.

### A refusal is not a crash ([D877](../decisions/adr-0877-a-refusal-is-not-a-crash-an-update-is-pre-flighted-and-a-node-is-rolled-out-only-when-its-runners-are-up.md))

An addon that says "I will not start, and here is why" throws `AddonRefusedError` (`code`,
`remedy`; the D870 legacy-blob guard was the first, retired 2026-10-22). The runner
writes `REFUSED:<node>:<json>` and exits with code 78; the process service parks the
runner in `refused` with the reason. **It never feeds the D6 breaker**, is not respawned,
and an operator restart or `updatePackage` retries it. On 2026-10-17 twenty-eight refusals
were counted as crashes and parked as terminally `failed`. `$process.list` carries the
reason; `addons.list` reports the runner's real state (`describeAddonProcess`), and
`addon.runner-refused` is emitted once per refusal (never `addon.crashed`; every settled state
is announced on `process.state-changed`). A `REFUSED:` line counts only with exit code 78.

**Is the node's fleet up?** One check, 60 s after boot, compares the planned runners with
the process service and serves `runners: { expected, running, failed, refused, missing }`
on `getServerPackageStatus` and `/health`; the alert centre turns a degraded verdict into
a critical alert (notified only through an `alert-critical` rule, D890; `scripts/hub/check-node-runners.ts` is the operator gate).
A runner still `starting` or backing off is `pending`: nothing is announced until the
verdict settles. An agent cannot name a missing runner (only the hub plans).

### A runner owns a process group, and every exit reaps it

A runner is spawned `detached: true` on POSIX, so it leads its own process group
and every child it starts — ffmpeg writers, llama-server, tailscaled, cloudflared
— inherits it. On **every** runner exit (crash, SIGABRT/OOM, SIGKILL, stop,
restart, breaker trip) `$process` sends `SIGTERM` to the whole group, waits up to
`RUNNER_GROUP_REAP_GRACE_MS`, and `SIGKILL`s what is left; ESRCH — an already
empty group — is the normal case. Every spawn under that runner id waits for the
reap first, so a successor never runs beside its predecessor's children
([D668](../decisions/adr-0668-a-runner-owns-a-process-group-and-every-exit-reaps-it.md);
`packages/system/src/kernel/moleculer/runner-process-group.ts`).

Before this, a runner that died without running JavaScript left every child
behind: on 2026-09-28 the recorder aborted and 28 orphan ffmpeg writers wrote
beside the respawned runner's 28 for 13 minutes, into the same staging
directories. The crash supervisor above bounds how often a runner comes back; the
group reap is what makes "comes back" mean a clean process tree.

Three things follow. The runner is in its own session, so a signal to hub-main's
group no longer reaches it — hub-main's SIGTERM handler calls
`signalAllRunnerGroups`, and the launcher removes its bootstrap-only
SIGTERM/SIGINT handlers once the role runtime can perform the graceful shutdown
instead of pre-empting it with `process.exit()`. The `$process.stopped()` hook
awaits runner exit plus group reap before `broker.stop()` returns. A process
`exit` handler has no future turn in which to escalate, so it SIGKILLs whatever
registered groups are still left. If the hub/agent itself is SIGKILLed, each
runner's parent-death watchdog — armed before addon code loads — detects the PPID
change and SIGKILLs its own group. This is what closes the desktop-agent case
too: killing the Node child by pid cannot strand its detached runners or their
TERM-deaf grandchildren. A child that calls `setsid` itself (or is spawned with
`detached: true` by an addon) escapes the reap, which
`scripts/check-no-detached-child-spawn.ts` refuses for our own code. And Windows
is not a target: runners there are spawned as before and nothing is reaped.

## AddonContext

An addon receives everything through `AddonContext` and holds no reference to
another addon:

`id` · `logger` · `eventBus` · `addonConfig` · `dataDir` · `kernel` · `settings` ·
`api` · `deps` · `useCapability` · `acquireCapability` ·
`onCapabilityStateChange`

Conventions:

- Persisted settings are read through `ctx.settings` only. `addonConfig` carries
  no store data — `{}` for every addon, in-process or forked (D675: it used to
  be filled from a sync reader that has no backend on an isolated engine).
- Log through the scoped logger. Never `console.log`.
- Emit through `ctx.eventBus` with the `EventCategory` enum — never a plain string,
  never a hand-rolled topic ([D11](../decisions/adr-0011.md)). A DeviceProxy
  minted in this process watches slices on that same bus
  (`createEventBusSliceSource`), not on `api.live.onEvent`. The tRPC
  subscription never reports UDS `eventPatterns`, so the parent correctly
  drops the event
  ([D232](../decisions/adr-0232-a-forked-deviceproxy-listens-on-the-event-bus.md)).
- Per-device settings are `scope: 'device'` fields in the config schema.
- **Was this key ever WRITTEN?** is a question the hydrated view cannot answer
  (`getGlobalSettings` reports `value ?? default`) and `readAddonStore()` must
  not be asked (it folds a failed read into `{}`). Ask
  `this.readStoredGlobalKey(key)` (`BaseAddon`), which answers `present`,
  `absent` or `unreadable` — and `unreadable` is never turned into "never
  written". It runs on `ctx.settings.readAddonStoreResult()`, the three-way
  read (`value | missing | failed`) both views provide: the forked view
  forwards the kernel's `readBlobResult`; the in-process view wraps its
  throwing backends and answers `failed` while NO backend is wired yet (before
  `setSettingsStore`/`setSettingsDoor` the sync view read the bootstrap file,
  and a `{}` from there is "not asked", not "never written"). A settings view
  that predates the method reads as `three-way-read-unavailable`. Written for
  the cluster model choice ([D651](../decisions/adr-0651-auraface-is-the-face-recognition-default-and-no-vector-is-compared-outside-the-model-that-made-it.md)).
- **A device is built from a runtime-state load that ANSWERED.** `kernel.devices`
  `create()`, accessory spawns, rebuilds and `loadContext` load the device's
  stored runtime state first and REFUSE the build when the load does not answer
  (`RuntimeStateLoadError`, tagged) — a device started on cold defaults writes
  them over its restored values. A new device's `{}` is an answer. A provider's
  own restore loop runs its rows through `restoreWithBoundedRetry` so a refusal
  costs a retry (D347), not the device until the next restart. `createContext`
  stays synchronous and empty, for a caller that builds no device from it
  ([D677](../decisions/adr-0677-the-runtime-state-row-writer-never-writes-a-row-this-process-has-not-read.md)).
- Reuse `@camstack/ui-library` composites (`StreamPanel`, `IntercomPanel`,
  `TabbedSettingsForm`, `LogStream`, `NodePicker`, …). Do not fork them.
- `ctx.api` for anything cross-addon, including existence checks
  ([transport.md](transport.md)).

## Deploying during development

This is the single most expensive trap in the repo, so it gets its own page:
[update-and-release.md](update-and-release.md#deploying-an-addon-during-development).
The short version: editing `packages/<addon>/src` and rebuilding `dist/` has **no
runtime effect** — the running node loads addons from `<dataDir>/addons/`. Use
`camstack deploy`.

## Custom actions

An addon's operator buttons register on a DIFFERENT path depending on whether
it runs in-process or forked, and `camstack deploy` reporting success is not
evidence that a new one landed. See
[addon-custom-actions.md](addon-custom-actions.md).
