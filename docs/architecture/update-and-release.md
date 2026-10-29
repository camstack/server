---
title: Update and release
applies-to:
  - Dockerfile
  - .github/workflows/ci.yml
  - .github/workflows/checks.yml
  - .github/workflows/publish-packages.yml
  - .github/workflows/release.yml
  - scripts/ci/align-nx-db.sh
  - packages/node-root/**
  - packages/desktop/src/node-exit-handler.ts
  - packages/desktop/src/shell-log.ts
  - server/backend/src/core/server-update/**
  - scripts/ci/verify-release-npm.mjs
  - scripts/check-npm-orphan-packages.ts
  - server/backend/src/addon-root-inventory.ts
  - server/backend/src/core/agent/agent-delivery-ledger.ts
covers:
  - server/backend/src/core/updates/**
last-verified: 2026-10-27
---

# Update and release

Two different things ship through two different channels, and confusing them costs
hours. This page exists because it has cost them.

| What | Channel | Reaches a node when |
| --- | --- | --- |
| **Framework** (`types`, `system`, `sdk`, `ui-library`) | inside the `@camstack/server` dependency closure | a root-package install runs |
| **Addons** | `<dataDir>/addons/` | `camstack deploy`, or the Admin UI Addons page |

[reference/packages.md](../reference/packages.md) has a "Reaches a node via" column
per package, derived from the closure — check it rather than guessing.

## The canonical topology — ONE addon root per node

Every node, whatever its role, loads addons from exactly one directory:

```
$CAMSTACK_ADDONS_DIR  (defaults to <dataDir>/addons)  →  <root>/@camstack/<pkg>/
```

`AddonLoader.loadFromDirectory` is the only reader and it takes ONE directory —
there is no search path, no fallback root, no second location it walks to when a
package is absent. So the topology is a property of `<dataDir>`, and every
"which version is on that node" question reduces to "which data root".

| Role | THE data root | THE addon root |
| --- | --- | --- |
| Hub (docker) | `/data` | `/data/addons/@camstack` |
| Agent (docker) | `/data` | `/data/addons/@camstack` |
| Desktop / Electron agent | `<userData>/data` — i.e. `~/Library/Application Support/@camstack/<appId>/data` | `<userData>/data/addons/@camstack` |
| Dev | `server/backend/camstack-data` <!-- drift-ok: gitignored runtime data dir, created on first run, not present in a fresh checkout --> | `…/camstack-data/addons/@camstack` |

**What may write it**

| Writer | What it writes | When |
| --- | --- | --- |
| `camstack deploy` / Admin UI upload | one package | operator gesture |
| `propagateToAgents` / `deployToAgent` | one package, via `deliverAddonToAgent` | a hub install fans out |
| the addon back-fill | packages the node's declared roster is missing, and packages whose live version differs from the hub's installed version (either direction, D942). The agent does not read npm | a node registers, hub boots, or `clusterNodes.repairNodeAddons` |
| `ensureRequiredPackages` (bootstrap) | the bootstrap set: missing packages at registry `latest`, and an npm-source copy whose version differs from `latest` (either direction, D942). A workspace/bundled seed and a closure-provided `@camstack/system` are left alone. An unreadable registry changes nothing | every boot |
| ~~the image seed~~ | **gone** ([D129](../decisions/adr-0129.md), 2026-08-13) — the image carries no addon tree, so `ensureRequiredPackages` fetches a missing bootstrap addon from npm at `latest` | — |

**Nothing writes `@camstack/system` into an addon root any more.** Since
[D107](../decisions/adr-0107.md) an agent loads the builtins from the closure it
is running, exactly as the hub has since 2026-07-18. The retired
`seedBuiltinsFromClosure` wrote that copy **only when absent** — it guaranteed one
existed and never that it was current, which is how both agents came to sit 17
versions behind on 2026-08-11.

**The addon seed is gone** ([D129](../decisions/adr-0129.md)). It never
outranked the runtime — the entrypoint seeded per package and skipped anything
installed ([D90](../decisions/adr-0090.md)) — but it gave every bootstrap
package a second truthful version: on 2026-08-13 the hub's seed carried
`addon-pipeline` 1.2.64 against 1.2.69 installed, `admin-ui` 1.2.47 against
1.2.50. Non-system addons are now single-copy, always, installed from the
registry at first boot, at `latest` (the system is addons-agnostic: there is no
pin and no adopt-by-semver).

**The SYSTEM fallback stays — served out of the ONE baked tree.**
`/opt/camstack-hub` is what a node boots from when its closure is broken, and the
entrypoint re-creates `<dataDir>/framework` on exactly ONE
condition — no `@camstack/system` under `server-root/current` — printing
`FALLBACK` when it does. It used to re-create the tree whenever the tree itself
was missing, which is why the 509 MB purged on 2026-08-12 was back after the
next restart. In steady state a node holds ONE copy and the post-boot sweep
(`single-copy-cleanup.ts`, run at each role's healthy-boot moment) removes the
legacy tree and any host-provided package under the addon root.
`server/backend/src/__tests__/entrypoint-framework-fallback.spec.ts` extracts
that block from the Dockerfile and runs it — shell in an image is otherwise
untestable from here.

**There is no second baked tree any more.** `/opt/camstack-seed-framework` was a
SECOND npm install of the same `@camstack/{system,types,sdk}` plus the hoisted
natives, existing only to be copied into `$FRAMEWORK_DIR` on that fallback boot:
510 MB beside a 930 MB `/opt/camstack-hub`, and the THIRD copy of every framework
package — which is what made the [D45](../decisions/adr-0045.md) inventory report
three where the design allows two. It was removed on 2026-08-25 (
re-cut after the first slice amputated the runtime stage), because
it was redundant by inspection: `/opt/camstack-hub/node_modules` already hoists
`better-sqlite3`, `node-av`, `sharp` and `zod` at its root — the exact reason the
second tree was built that way — and already holds the three framework packages
as dependencies of `@camstack/server`. The fallback now copies that one tree and
then **replaces** its `@camstack` scope with `system`/`types`/`sdk` alone; merging
it would put `@camstack/server` and every baked addon into the framework dir, a
fresh set of shadow copies. A framework package missing from the
baked tree is fatal for that boot and says so, rather than letting the node start
and fail resolution with an error that names nothing. The
`/opt/camstack-seed-version` fingerprint is now hashed over that same tree, so it
covers every baked `@camstack/*` instead of only system/types/sdk — it moves on
more changes than before, which is the conservative direction.

**What may NEVER write it**

- `@camstack/system`, `types`, `sdk`, `ui-library`. They are
  host-provided ([D15](../decisions/adr-0015.md)) and belong in the closure. A
  copy under `addons/` WINS over the closure and never updates —
  `shouldSkipClosureProvidedSeed` refuses to seed one, and
  `<dataDir>/addons/@camstack/system` is absent on hub and on `agent-a`
  by design.
- `shm-ring` — deleted ([D763](../decisions/adr-0763-the-decoder-cap-is-a-hwaccel-answer-and-shm-ring-and-decoder-ffmpeg-are-deleted.md));
  it had left the closure with
  [D184](../decisions/adr-0184-the-closure-carries-no-package-nothing-imports.md),
  and no published addon version imports it. It is no longer a host-external
  or a closure-provided package. A stale copy under `addons/` is inert.
- Anything at all, by hand. **A rename is an install, not an archive**
  ([D90](../decisions/adr-0090.md)). Three consumers key on the `package.json`
  inside a directory and ignore the directory's name: the loader (its skip list
  is keyed on the PACKAGE name, so `@camstack/system.bak-pre-unshadow` was not
  skipped), the agent's `resolveAddonPackageDirs`, and
  `AddonManifest.reconcileFromDisk`. On 2026-08-07 the `agent-a` agent's
  main process held five live mappings of `better_sqlite3.node` out of a
  17-day-old copy; on 2026-08-08 the Mac agent had **no**
  `addons/@camstack/system` directory at all and still reported
  `@camstack/system 1.2.3` — read out of `system.bak-pre-1272-…` while running a
  1.2.61 closure.

  Two gates now close this, and neither deletes anything: `reconcileFromDisk`
  refuses a directory whose basename is not the package it declares, and
  `quarantineAddonResidue` (first thing the launcher does, before the seed and
  before any scan) MOVES residue to `<addonRoot>/.quarantine/`, logging the
  reason and both paths. Nothing reclaims that store — deleting what a human has
  not looked at is exactly the cleanup that gutted an agent.

**Everything else on disk is not an addon root** and nothing loads from it:
`/opt/camstack-hub/node_modules` (the starter and the fallback source, from the
image), `<dataDir>/framework`
(inert once `CAMSTACK_SERVER_ACTIVE_ROOT` redirects `CAMSTACK_FRAMEWORK_DIR` —
`launcher.ts` does this on every data-root boot), `<dataDir>/addons/.staging`
(swept, min age 30 min), `<dataDir>/server-root/current.bak-*`.

**The guard.** Two boot-time inventories make a second copy loud instead of
silent. Both are reported and **never fatal — there is no flag that makes them
refuse a boot**, and `scripts/check-inventory-never-fatal.ts` keeps it that way
([D45](../decisions/adr-0045.md) § Enforcement):

| Guard | Answers |
| --- | --- |
| `package-inventory.ts` ([D45](../decisions/adr-0045.md)) | how many copies of `@camstack/system` / `types` / `sdk` exist under the roots THIS node resolves through |
| `addon-root-inventory.ts` | whether a whole RIVAL data root exists on this machine — a retired Electron app id, the pre-Electron `~/camstack-agent-data` |

The second exists because the first structurally cannot see it: its roots are
all derived from the active `<dataDir>`. Measured on the Mac agent 2026-08-07:
four `addons/@camstack` trees on one disk holding `addon-pipeline` at 1.2.43
(live), 1.1.70, 1.1.59 and 1.1.1. Four true answers to "what version is on the
Mac"; an hour was spent on one of the three nothing had loaded since June.

> **Rule:** a version is a property of a PATH, not of a machine. Any answer that
> does not name the directory it came from is a coin flip between the node and
> its ghosts.

## Deploying an addon during development

**Editing `packages/<addon>/src/…` and rebuilding `packages/<addon>/dist/` is not
enough.** A running node loads addons from
`server/backend/camstack-data/addons/@camstack/<addon>/dist/`. Until you deploy,
the live runner keeps loading the **old installed copy**: log lines you added never
appear, refactors never run, and you can debug stale code for a long time without
suspecting it.

```bash
camstack deploy packages/addon-pipeline-orchestrator
camstack deploy pipeline-orchestrator          # workspace-name shortcut
camstack deploy <pkg> -n <nodeId>              # to a specific agent (hub is default)
```

`CrashSupervisor` respawns the runner after install — no manual kill.

The CLI's `-n` flag is the **working** channel for agent addon deploys.
`nodes.deployAddon` does **not** ship bundles.

Auth comes from the login session at `~/.camstack/<host>.json`, created by
`camstack login` — every hub command (`deploy`, `deploy-server`, `dev`, `watch`)
picks it up for the target server with no flags. Resolution, first hit wins:
`--token`, `--token-file <path>` (a bare token or a copied session file, for
scripts/CI), `$CAMSTACK_TOKEN`, the cached session. A 401/403 says which source
was rejected (a cached session: run `camstack login` again).

To find every stale addon after a rebase — compare installed vs workspace mtime:

```bash
for d in packages/addon-*; do
  name=$(basename "$d")
  installed=$(stat -f "%Sm" "server/backend/camstack-data/addons/@camstack/$name/dist/index.mjs" 2>/dev/null \
            || stat -f "%Sm" "server/backend/camstack-data/addons/@camstack/$name/dist/index.js" 2>/dev/null)
  workspace=$(stat -f "%Sm" "$d/dist/index.mjs" 2>/dev/null \
            || stat -f "%Sm" "$d/dist/index.js" 2>/dev/null \
            || stat -f "%Sm" "$d"/dist/*.addon.js 2>/dev/null | head -1)
  [ -n "$installed" ] && [ -n "$workspace" ] && echo "$name | installed=$installed | workspace=$workspace"
done
```

Any row where `workspace` is newer than `installed` must be redeployed before its
behaviour can be trusted.

**Symptom this prevents:** "I edited a log line, rebuilt, and the runner still
behaves like before" → almost always a stale installed copy.

## Deploying a framework change in development

A framework package ships differently: `camstack deploy packages/types` works
because `syncFrameworkDist` mirrors the package's `dist/` into the hub closure and
restarts. In production it needs a publish.

**A new or changed capability is a framework change.** An *additive* field on an
existing method needs only the providing addon redeployed.

**Builtins load from the closure, on both roles.** The hub
(`server/backend/src/core/addon/addon-registry.service.ts`, `bootstrap`:
`resolveHubClosurePackageDir('@camstack/system')`, then
`loadFromDirectory(addonsDir, ['@camstack/system'])`) and the agent
(`bootCoreAddons` in `server/backend/src/agent/main.ts` →
`planAgentAddonScan` in `server/backend/src/agent/addon-scan.ts`) both load the
`@camstack/system` builtins from the running closure and SKIP any
`<addonsDir>/@camstack/system` copy. Forked runners resolve `@camstack/*`
through the closure too (`registerFrameworkResolver` with
`CAMSTACK_FRAMEWORK_DIR`, set by the launcher to the active root). So
`applyServerUpdate`'s own restart refreshes the builtins; no second restart is
needed, and `updatePackage({name:'@camstack/system', nodeId})` is no longer how
an agent's builtins are refreshed.

This replaced the model [D87](../decisions/adr-0087.md) describes, in which an
agent's addon-root copy WAS its builtin infra. On 2026-08-11 both agents ran a
copy 17 versions behind the closure (`1.2.61`/`1.2.62` against `1.2.78`)
because "Update all" on an agent had been silently updating the hub instead
([D106](../decisions/adr-0106.md)) — the drift that motivated loading from the
closure. Two residues remain:

- **The agent fallback.** When the closure cannot resolve `@camstack/system`,
  the agent logs `not resolvable from the running closure — falling back to
  the addon-root copy` and loads whatever copy is on disk. That line in an
  agent's boot log means its builtins may be stale.
- **A stale copy is still read by the hub's hot-load scan.**
  `loadNewAddons` (same file) rescans the whole addons dir with no skip list
  and refreshes the metadata of already-registered entries from it — so a
  leftover `<addonsDir>/@camstack/system` is still worth removing.

Read the `[launcher] resolved @camstack/system@… from <path>` line for what it
says and no more: which copy the LAUNCHER resolves for its own imports.

## What ships in an addon — and why `addons/` has no `node_modules`

An addon deploys as a **self-contained `dist/` only**. The vite bundle
(`tools/build/vite-lib.preset.ts`, `externals: 'self-contained'`) inlines every
pure-JS dependency, and `stripBundledDeps` (`packages/system/src/kernel/fs-utils.ts`)
removes them from the installed `package.json` so the installer runs **no**
per-addon `npm install`. `RUNTIME_NATIVE_KEEP` is empty: a self-contained dist
requires nothing from a local `node_modules`.

The only exception is a **true native** (`.node`) or a lib that ships optional
natives that cannot be bundled. Those are **host-external**: declared once as a
dependency of `@camstack/server` (so they live in the framework closure) and
listed in `HOST_EXTERNAL_SPECIFIERS`, whose resolver hook
(`packages/system/src/kernel/moleculer/framework-resolver-hook.mjs`) redirects an
addon's import into `frameworkDir/node_modules`. The set is
`node-av`, `sharp`, `node-pty`, `ssh2` — plus `better-sqlite3`, which is
**deliberately not** host-external (hub-only, via the storage cap; a stray addon
import must fail, not be silently redirected). The list is mirrored in three
bootstrap-isolated copies (`host-externals.ts`, the zero-dep starter
`packages/node-root/src/starter-core.ts`, and the raw-ESM loader hook); a drift
guard in `host-externals.spec.ts` pins them equal.

**Host-external does not imply "in the closure".** A list entry is a routing
rule; the dependency is what supplies bytes. `@camstack/shm-ring` sat in all
three lists for seven weeks after it left the closure
([D184](../decisions/adr-0184-the-closure-carries-no-package-nothing-imports.md))
and resolved to nothing on a fresh node; it was deleted with
[D763](../decisions/adr-0763-the-decoder-cap-is-a-hwaccel-answer-and-shm-ring-and-decoder-ffmpeg-are-deleted.md).

Consequence: the version is whatever `@camstack/server` pins — an addon cannot
choose its own native version. In return, `addons/` carries only bundled code, so
the backup can tar the whole folder with no exclusion list ([D27](../decisions/adr-0027.md)).

> The Node `onnxruntime-node` runtime is **gone** — ONNX inference runs as a
> Python subprocess now, so no addon carries it and it is not a host-external.

## Updating a node

`applyServerUpdate` runs `npm install @camstack/server@X` into
`<dataDir>/server-root/.staging-*`, arms a pending root-swap marker and restarts;
the starter swaps it into `current/` at boot.

**Dev channel (`<base>-dev.<epoch>`).** Versions never exist on npm. The hub
stores tarballs under `server-root/dev-uploads/<version>/` via
`POST /api/server-upload`. Agents get the same layout through
`POST /api/server-upload/propagate` (`$agent.stageDevUploads`, hub-http pull —
[D825](../decisions/adr-0825-dev-server-uploads-reach-agents-through-hub-propagate-not-host-copy.md)),
then `applyServerUpdate` with `nodeId`. CLI: `camstack deploy-server --all` /
`-n <nodeId>`. Host copy of `dev-uploads` is emergency-only.

One copy only — no probation boot, no N-1 retention, no automatic rollback
([D17](../decisions/adr-0017.md)). Recovery from a bad version is an explicit
update to a known-good one.

The stage/apply engine is shared: `RootUpdateService` in `@camstack/node-root`, with
the hub binding its parameters in `ServerUpdateService`. Both roles use it so they
cannot drift ([D16](../decisions/adr-0016.md)).

**What the API says, and what each word means** ([D546](../decisions/adr-0546-what-runs-is-captured-at-boot-and-an-update-answers-what-it-did.md)).
Three versions describe a node and they are three different facts:

| Field | Means | Read from |
| --- | --- | --- |
| `runningVersion` | the code THIS PROCESS loaded | captured once at boot, in memory — never re-read |
| `installedVersion` | what is in `server-root/current/` right now | disk, on every read (`data-root` boots only) |
| `pendingVersion` | a staged closure awaiting its restart | the `.pending-root-swap.json` marker |

`restartRequired` is derived from them on every read (`pendingVersion` set, or
installed ≠ running) and is the one boolean a script should gate on: "1.2.353
is installed and will run after a restart" is `runningVersion: 1.2.352,
pendingVersion: 1.2.353, restartRequired: true`. `checkServerUpdate` carries
`pendingVersion` and `restartRequired` too — a staged version is a restart away,
not "an update available", so `updateAvailable` is false for it. Until
2026-09-20 `runningVersion` was a disk read on every call and the check result
had no restart fact at all: an evening of framework changes was declared live
off a number that meant "installed".

**An action answers what it DID.** `applyServerUpdate` / `restartServer` return
`outcome` — `staged` (installed and validated; the node restarts; NOTHING runs the
new code until that restart completes), `restart-scheduled`, `already-current`,
`refused` (a gate said no; `reason` names it) or `failed` (attempted and did not
land; `error` carries the npm output). `accepted` alone could not tell the last
two apart, and on 2026-09-19 the hub's staging install died on
`npm error code ECONNRESET` in the same clothes as "already running". A
transient registry failure (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, …) is retried
before it is reported — three attempts, ~20 s of waiting, a fresh `.staging-*`
each time (`STAGING_ATTEMPTS` in `root-update-service.ts`); a validator refusal
or a 404 is final on the first try.

**A staged closure is CHECKED before the swap is armed, never trusted.** Two
validators run against `.staging-*` and both are fail-closed:
`findMissingNativePrebuilds` (the natives the runners need) and
`findUnappliedClosurePatches` (`packages/node-root/src/root-single-copy.ts`).
The second exists because `werift` is not bundled — three addons resolve it from
the closure so the dedupe links them to one copy ([D343](../decisions/adr-0343-a-library-the-server-closure-provides-is-linked-not-copied.md))
— and the closure installs it from npm with no patch step, so hub, Docker agent
and Electron agent all ran an unpatched `werift@0.22.9` (`RTP_HISTORY_SIZE = 128`
instead of 4096, no guard on the candidate leak under `forceTurn`) for eight
weeks while three code comments asserted the opposite. `patches/patch-reach.json`
now declares, per patch, HOW it reaches production — `bundled` |
`closure-postinstall` | `dev-only`
([D478](../decisions/adr-0478-a-patch-reaches-production-only-if-it-is-bundled-or-applied-in-the-closure.md))
— and the applier being best-effort is only
safe because the validator is not: **a skipped patch must never look like an
applied one.** A closure carrying no patch payload at all reports nothing missing
— that is a pre-D478 release, and refusing it would make an older version
unreachable.

**The patch pass does not go through npm, and the interpreter is
`process.execPath`.** npm 12 blocks a dependency's install scripts by default and
still exits 0, so `@camstack/server`'s `postinstall` — the thing that applies
those patches — silently did not run on the Mac-mini agent, which had bootstrapped
npm 12.0.1 while hub and agent-a stayed on npm 11. That node sat two
versions behind with no symptom but the validator's refusal. Both halves are
closed: the staging manifest carries an `allowScripts` allow-list (npm 11's
behaviour, written down, so moving a node to npm 12 stops being a silent
downgrade), and `stageClosure` invokes the shipped applier itself
(`server/backend/src/core/server-update/system-apply-closure-patches.ts`) so a
patch of ours depends on no npm policy at all — it is idempotent, so it costs
nothing where npm did run the lifecycle. It spawns `process.execPath`, not
`node`: a packaged desktop ships one bundled Node at an absolute path and runs
under launchd's bare `PATH`, where resolving `node` by name is `exit 127`. The
pre-existing `ensureNativePrebuilds` workaround, which says it exists for a
"toolchain-less packaged host", was that same fault — the host was never
toolchain-less, it could not find `node`.

**The update is pre-flighted, and a node is rolled out only when its runners are up
([D877](../decisions/adr-0877-a-refusal-is-not-a-crash-an-update-is-pre-flighted-and-a-node-is-rolled-out-only-when-its-runners-are-up.md)).**
Before staging, `applyServerUpdate` can ask an `updatePreflight` hook whether the target
version would refuse any addon on the node's live data, and answers `outcome: 'refused'`,
`reason: 'addon-would-refuse'` with `blockers` (addon + remedy); `acknowledgeRefusals: true`
overrides it. The hub sets no hook today: its only check, the D870 legacy-blob guard, was
retired with that migration on 2026-10-22. **Agent
updates are not pre-flighted** (no store, no hook; `acknowledgeRefusals` is ignored there): after
an agent restarts, the gate below is the only check.
After each node restarts, the gate is: capabilities registered AND

```bash
npx tsx scripts/hub/check-node-runners.ts --server <host> [--node <id>] --expect-version <v>
```

(exit non-zero when any runner is failed / refused / missing, when the boot check has not
run yet - wait ~60 s - or when the node runs another version). "Online with its caps" is
not enough: on 2026-10-17 a hub was online on the new version with 28 addons refused and
19 dead for four hours.

**"Update all nodes"** (Cluster page) sequences online nodes **agents first, hub
last**, one at a time — the hub hosts the routing to every agent, so restarting it
first would cut the calls that kick the agents. Up-to-date nodes are refused
server-side.

**`applyServerUpdate` never updates the IMAGE.** The container image (starter,
entrypoint, boot seed) only changes on a container recreate, so `runningVersion`
can be current while the image is weeks old — on 2026-08-02 the hub ran a
13-day-old image from a RENAMED repository (`camstack-server:intel-1.1.74`)
with every version surface green. Each node's status therefore carries
`imageContract` (`packages/node-root/src/image-contract.ts`): the baked seed
version — the one image fingerprint visible from inside a container — compared
against the release the contract delivers, warn-logged by `checkServerUpdate`
and exported to Home Assistant as a sensor. It surfaces the fact; recreating the
container stays an operator decision ([D40](../decisions/adr-0040.md)).

**Only `behind-series` reaches the screen** (2026-08-27). The Cluster page banner
used to render `behind-patch` in amber too — but a seed behind the contract
within the same series is what EVERY node looks like the moment it takes a
runtime update, because `applyServerUpdate` installs into the data root and by
design never rewrites the image. The hub sat in `behind-patch` permanently (seed
1.2.175 vs contract 1.2.179), so the banner was furniture that read as a fault.
A full major.minor behind is the pinned-tag / dead-repo shape a `docker pull`
cannot fix — rare, actionable, still red. The verdict itself is unchanged: both
states are still computed, still warn-logged, still exported.

### An agent follows its own closure (2026-10-28)

The hub is no longer the only thing that moves an agent's `@camstack/server` closure. Each agent
keeps it current itself (`server/backend/src/agent/agent-self-update.ts`), through the same
`AgentUpdateService` stage + apply + `scheduleAgentRestart` path the hub drives (lifecycle =
respawn, D5). A freshly installed desktop agent boots the seed baked into the app and, unpaired,
had no hub to receive a fix from.

- **Target.** Unpaired: the npm `latest` of `@camstack/server`. Paired: the version the HUB runs,
  carried on the `$hub.registerNode` ack (`hubServerVersion`) — never npm latest, so there is no
  hub/agent skew. A hub too old to say its version leaves the agent where it is, and that is logged.
- **When.** Unpaired: at boot. Paired: on the first registration ack. Then every
  `DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS` (6 h). One periodic check, no retry loop (D3).
- **Never a downgrade.** An equal or older target is skipped. A failed registry or hub-version read
  is logged with its reason and changes nothing; it is never "up to date" (D49, D393). Every
  decision (checked, skip, staging, applied, not applied) is one `agent self-update:` log line with
  the versions.
- **Off switch.** `CAMSTACK_AGENT_SELF_UPDATE=off` (or `0`, `false`, `no`) on the agent. Default on;
  the hub's auto-update settings only pace the hub's notifications and do not reach agents.
- Containers are in scope: closures are applied in a container by the data-root swap.

## Being TOLD an update exists

Notification of an available update is a different mechanism from applying one,
and it runs on its own clock: `UpdateCheckScheduler`
(`server/backend/src/core/updates/`) sweeps every 6 h by default and publishes
`update.available`. It covers all four discovery paths in one pass — hub addons,
framework packages, each node's server root, and each agent's addon roster.

It is deliberately **not** gated on the auto-update channel. It used to be, via
`scheduleAutoUpdate`, which returns early on `channel: 'off'` — the setting every
live hub runs — so no operator had ever received an update notification
([D175](../decisions/adr-0175-an-update-notification-is-polled-on-its-own-clock-and-remembered-across-restarts.md)).

| Knob | Surface | What it controls |
| --- | --- | --- |
| `channel` | `addons.setAutoUpdateSettings` | whether addons are auto-INSTALLED |
| `intervalSeconds` | same | cadence of the auto-install sweep, gated on `channel` |
| `updateCheckIntervalSeconds` | same | cadence of the availability POLL — ungated; 900 s … 604800 s, default 21600 s |

Dedup state is durable (`<dataDir>/update-availability/<scope>.json`), so a
restart does not re-announce what the operator already saw. A check that fails
publishes nothing and logs: an empty snapshot means "up to date" and would clear
that state.

**One announcement covers ONE node.** `emitList` filters the held set by scope
and stamps `nodeId` on every row, the hub's included, so the Notification Center
can title it "2 aggiornamenti addon disponibili su agent-a". Until
2026-08-19 it emitted the union across nodes on any scope's change: one sweep of
a three-node cluster sent three pushes seconds apart, each listing all 45 rows
of the whole cluster and naming nobody — they differed by one line and read as
duplicates ([D187](../decisions/adr-0187-an-update-notification-names-one-node-and-both-versions.md)).
A per-node announcement is also what every other node-scoped notification does.

## Being told an update HAPPENED

The completed-update notification is built from the `.restart-pending` marker,
which is the only thing that survives the reboot — the process that reads it IS
the new version, and the single-copy swap has already replaced the old one on
disk. So `applyServerUpdate` hands the restart seam a `RootRestartUpdate`
(package, `fromVersion`, `toVersion`) beside the reason string, and one builder
(`server/backend/src/core/updates/restart-marker.ts`) writes the marker for the
hub and the agent alike. The reason string alone can spell one version, which is
why "Server aggiornato" carried none at all until D187: the sentence wanted both
and the marker had one.

A PLAIN node restart travels under the same `server-update:` reason prefix
(`RootUpdateService.restartNode` → `server-update: manual restart`). It is not an
update, carries no version, and is announced as neither.

## Being told an update is STARTING, and the desktop shell's supervisor

`node-updating` is announced before the restart for the closure, and for the
desktop shell when the hub asks it to install (`installDesktopUpdate`); a
container that boots on a new image says so after the swap (the old container is
gone first). The table of emitters is in `notifications.md`, "A node announces
its own restart". Those events are telemetry (D8): losing one never blocks the
update.

The Electron shell supervises its node child (`packages/desktop/src/main.ts`,
`node-exit-handler.ts`). On a child exit the work that keeps the node alive —
consume the restart-intent marker, classify the exit, schedule the relaunch —
runs BEFORE anything that only reports (tray refresh, log line), and each of
those is guarded: a throwing `console.log` (closed stdout, EPIPE) once left the
child `<defunct>` with its marker unconsumed. The shell also logs
`uncaughtException` / `unhandledRejection` to `<userData>/shell.log` (bounded,
one rotated generation, `shell-log.ts`) and swallows them without a dialog.

## Traps that cost a session, each with its evidence

### A green suite says nothing about the artefact you ship

**2026-08-29, twice in one hour.** `typecheck`, `test`, `lint` and `docs:check`
were all green. The deploy took the hub's `stream-broker` down — no broker, no
live streams, WebRTC dead — and it was rolled back, fixed, redeployed, and went
down again the same way.

None of those four checks loads the built bundle. The fault existed only there.

Three distinct shapes of this hit the same session:

- **The nx cache served a `dist` built before the change.** A passing
  `camstack deploy` was not evidence the bundle still built; it shipped an old
  one. Build with `--skip-nx-cache` and confirm a marker from your change is in
  `dist/` before trusting a deploy (§"nx-cache can bake STALE code" in
  `camstack-homelab-ops`).
- **A deploy ran from an uncommitted tree.** `camstack deploy` packs the
  working directory, not `HEAD`. Commit first, then deploy — the reverse leaves
  a hub running code that exists nowhere in git.
- **The fault only appears on a RE-deploy.** See below.

The rule: **before deploying, verify the thing that will be sent.** Not a build
you ran by hand a minute earlier with a different command — the deploy runs the
package's own `npm run build`, which for `addon-pipeline` is *two* vite passes,
the second writing into the same `dist` with `emptyOutDir: false`.

### The first deploy works; the second one breaks — a class that no longer exists

Until 2026-09-11 the hub re-imported a forked addon's entry **inside hub-main,
which is not restarted by an addon deploy**, to read its `customActions`
export. Anything a module did at evaluation time therefore ran again on every
deploy, against process state still there from last time — a failure that
could not be reproduced from a clean container, a clean `dist` or a dirty
`dist`, because it was a **deploy-lifecycle** property, not a build property.
The 2026-08-29 outage (a module-scope `declareLogChannel` running twice
because the purge was scoped to the entry's directory while shared chunks sat
one level above) is recorded in
`docs/decisions/adr-0284-a-module-graph-is-purged-whole-or-not-at-all.md`.

[D444](../decisions/adr-0444-hub-main-measures-its-own-episodes-bounds-its-readers-and-reads-no-bundle.md)
removed the re-import: the runner describes its catalog in its register frame
and hub-main evaluates no addon bundle at all. The require-cache purge and the
bundle-reload guard are gone with it. What remains true: **a forked addon's
code runs only in its runner, and a deploy restarts that runner** — so a deploy
that "did not take" is a runner that did not restart or a bundle that did not
land, never hub-main holding an old module.
A first deploy that works proves nothing about a module's re-entrancy.

### `manualChunks: () => null` does not mean "one file per entry"

`tools/build/vite-lib.preset.ts` says each entry "bundles its own full
dependency tree". **In the artefact that is false** — `stream-broker/index.js`
requires six sibling chunks. `manualChunks` governs manual assignment; it does
not prevent extraction. Any reasoning that assumes an entry is self-contained —
including cache purging, module identity, and singleton lifetime — is wrong.


Every entry below was hit on 2026-08-02 while shipping the hub OOM fix. They
share one shape: **the update reported success and did not happen.**

### `--cluster` silently deployed to the hub alone

`camstack deploy --cluster` printed *"no online agents found, pushing to hub
only"* while `agent-a` was online, logging, and accepting the very same
tarball via `-n agent-a`.

The agent was fine. The CLI sent `input={"json":null}` to `nodes.topology`,
whose input parses as an object — and **tRPC answers a validation failure with
HTTP 200 and an `error` in the body**:

| input | reply |
| --- | --- |
| *(none)* | 200 · 3 nodes, all online |
| a null input | 200 · `error: expected object` |
| an empty object | 200 · 3 nodes, all online |

`body.result?.data?.json ?? []` then turned that error into an empty cluster.
Fixed three ways, because the shape recurs: send an object, treat a 200
carrying `error` as a failure, and **refuse** a partial cluster deploy instead
of falling back to hub-only. Guarded by
`packages/cli/src/__tests__/cluster-enumeration.spec.ts`.

> **Rule:** a 200 is not a result. When a hub reply is optional-chained into a
> default, absence and refusal become indistinguishable — and a fleet split
> across versions is the quietest possible outcome.

### The back-fill un-deployed every agent deploy, 1.5 seconds later

**This is the one that cost the day.** `camstack deploy packages/addon-pipeline
-n agent-a` landed the correct bytes — verified by hash — and ~1.5s later
the node's `dist/` held a *different* build under the *same* version. It looked
exactly like a stale tarball cache. There is no cache.

`@camstack/addon-pipeline@1.2.43` existed as **two different bundles**: the one
built in the workspace and the one published to npm. The deploy's own
`$agent.reload` briefly empties the node's reported addon roster (`$agent.deploy`
evicts the package's declaration ids from `loadedAddons`). The hub's reconcile
reads that roster, concludes the package is MISSING, and the addon back-fill
repairs the node — by `npm pack @camstack/addon-pipeline@1.2.43`, i.e. **the
registry's build**, installed straight over the one just delivered.

The seam's own comment said "bytes come from the hub's own resolution of the
package". It called `packPackage`, which is the registry. A leftover that
described the right design, read as verification, for as long as it took to
measure the bytes.

Evidence (hub stdout, three deploys in 40 minutes):

```
[agent-registry] Back-fill agent-a: delivered @camstack/addon-pipeline@1.2.43
```

— once after each deploy, and the published 1.2.43's
`dist/pipeline-runner/index.mjs` hashes to exactly what landed on the node.

Fixed: `AddonPackageService.packInstalledPackage` packs the hub's **installed**
copy and the back-fill prefers it, falling back to the registry only when the hub
has no copy. The pack now logs its source (`hub-installed` / `npm-registry`).
Pinned by `pack-installed-package.spec.ts`.

> **Rule:** a version string is not a build. Any path that "repairs" a node by
> resolving `name@version` will happily replace a deployed bundle with a
> different one bearing the same number. Ship the bytes the hub runs.

This also explains the two facts that made the defect unreadable: hub deploys
were fine (nothing back-fills the hub), and `rm -rf` of the agent's `dist`
"restored the old bundle" (the back-fill saw the package missing — correctly,
this time — and installed npm's copy).

**That fix made the damage invisible; it did not remove the TRIGGER.** The
back-fill still fired after every agent deploy, because the roster gap it reacts
to is one the hub opens itself: `$agent.deploy`'s `onApplied` evicts the
package's declaration ids, `$agent.reload` re-instantiates every runner (a
status read landing mid-reload saw "14 checked" and, seconds later, "20
checked" on the same node), and each re-registration fires the reconcile again.

Three gates now stand between a roster gap and an install, and each one has a
test that fails when it is removed:

| Gate | Rule |
| --- | --- |
| **Trigger allowlist** (`triggerMayDeliver`) | a reconcile names WHY it is running — `node-registration`, `hub-boot`, `operator-repair` may deliver; `inspect-only` may not. A future caller has to choose. |
| **Delivery window** (`agent-delivery-ledger.ts`) | a node with a hub delivery in flight, or finished under `DELIVERY_GRACE_MS` ago, is never back-filled. Opened before the first byte, closed in a `finally` — not a sleep: a four-minute install holds it for four minutes. |
| **Confirmation read** ([D49](../decisions/adr-0049.md)) | a back-fill DESTROYS work, so every target is re-checked against a SECOND independent `$agent.status`. A package the second read reports present is dropped; a read that FAILS is refused, never treated as agreement. |

A back-fill that fires now logs what it installed, the version's source
(`hub-installed` — the only one since D766: a package the hub does not install is
logged as `NOT delivering` and never pushed), the trigger, and how many packages the
node reported versus how many its declared roster holds. A back-fill that
DECLINES logs which gate stopped it — silence would be indistinguishable from
"nothing was missing".

The trigger set deliberately does **not** exclude re-registrations. The case the
back-fill exists for — a node that lost `<dataDir>/addons` and came back with 4
of 14 packages — presents as a rejoin, and a brand-new node has no recorded
roster, so it back-fills nothing anyway. Excluding rejoins would delete the only
legitimate purpose. `clusterNodes.repairNodeAddons` is the explicit escape hatch
when the automatic gates decline.

### `-n <agent>` was silently redirected to the hub

`camstack deploy <pkg> -n agent-a` printed `✓ agent-a` while the hub
logged `hub install OK`. The named node was never addressed.

`data.fields` is the multipart plugin's live busboy body, populated as parsing
proceeds. The CLI sent `nodeId` **after** the file part and the route read it the
moment `request.file()` resolved — before the 4.9 MB tarball had been drained. So
`nodeId` was `null` and the route took the hub branch. A small tarball arrives in
one chunk and works, which is why every test passed and why it looked
intermittent.

Fixed on both sides: the CLI sends the text fields **before** the file, and the
route reads them **after** `toBuffer()`. Guarded by `checkDeployTarget` — the CLI
now FAILS when the hub reports a target other than the one requested, which
catches this class against any server version. Pinned by the chunked-payload test
in `addon-upload.spec.ts` (it fails against the pre-fix read order) and
`deploy-outcome-report.spec.ts`.

### `-n <agent>` installed the bundle and never loaded it

`camstack deploy packages/addon-pipeline -n agent-a` printed
`✓ agent-a: @camstack/addon-pipeline@1.2.43` four times on 2026-08-07
while the node went on executing the previous dist. It was blamed on a stale
tarball cache. There is no tarball cache: the agent verifies bytes **and**
sha256 before unpacking (`fetch-bundle-from-hub.ts`), and a marker file planted
inside `dist/` was on the agent two seconds after the tick.

The hub had **two** delivery bodies. `propagateToAgents` (the hub-install
broadcast) called `$agent.deploy` **and** `$agent.reload`. `deployToAgent` (the
`-n` branch) called only `$agent.deploy` — so the bytes landed, the install
manifest bumped `updatedAt`, and not one of the node's 12 addon-runner pids was
recycled. Worse, `$agent.deploy`'s `onApplied` evicts the package's declaration
ids from `loadedAddons`, so the node also stopped reporting addons it was still
running.

Both callers now go through `deliverAddonToAgent`
(`server/backend/src/api/agent-addon-delivery.ts`): deploy → **hash check** (the
agent reports the sha256 of the bytes it actually unpacked; a mismatch is a 502,
never a tick) → reload. The response carries `reloaded[]`, and the CLI prints it
and **warns** when an agent target reloaded nothing. Pinned by
`agent-addon-delivery.test.ts`, `addon-upload.spec.ts` ("reloads the named
agent") and `deploy-outcome-report.spec.ts`.

> **Rule:** a deploy is not done when the bytes are on disk. It is done when the
> node reports which addons it re-instantiated from them. Two code paths that
> must agree get ONE implementation.

### A second deploy deleted the first one's staging tree

Back-to-back propagations produced, on the Mac agent and on agent-a:

```
npm error code ENOENT
npm error path …/.staging/install-14820-2026-08-07T12-28-28-875Z/package/package.json
```

surfaced as `runtime dependency install failed`. `installFromTgz` opened by
clearing the WHOLE `.staging` root — including the tree of an install still
running its `npm install`. The sweep now skips trees this process is building
and anything younger than `STAGING_RESIDUE_MIN_AGE_MS` (30 min), so it only ever
removes residue from a crash (`selectSweepableStaging`, `staging-sweep.spec.ts`).

### A dist-tag update failed its own staging check, 30 times out of 30

`updatePackage` without an explicit version asks the fetcher for `latest`. The
staged `package.json` then carries the RESOLVED version — `1.2.139`, never the
string `latest` — and the staging area compared it to the literal tag it was
handed, so every tag-based update was refused as a version mismatch while the
bytes on disk were exactly right (30/30 on 2026-08-20). An exact semver is still
compared strictly; a TAG now accepts whatever the fetcher resolved, and that
resolved version is returned to the caller so the log names what actually landed
(`packages/system/src/kernel/lifecycle/staging-area.ts`).

### `applyServerUpdate` "times out" when it is working

The call blocks while the hub restarts, so the client sees a 60s timeout (or a
502/524). **That is the success path.** Do not retry it — poll
`serverManagement.getServerPackageStatus` until `runningVersion` matches,
`updateState` is `idle` and `restartRequired` is `false`. A reply that DID
arrive says what happened in `outcome`; `staged` means the old version is still
the one answering you.

`camstack deploy`'s post-deploy health gate has the same problem: it probes
`/health` while the addon is restarting, gets a 502, and reports
`1/1 target(s) failed` **after the install already succeeded**. Use
`--no-verify` and poll `/health` separately.

### The starter runs from the IMAGE, not from the closure

`applyServerUpdate` replaces `<dataDir>/server-root/current`. It does **not**
replace the starter: hub-main is
`/opt/camstack-hub/node_modules/@camstack/server/dist/starter.js`, baked into
the image. Code added to `starter-core.ts` deployed cleanly and produced
**zero** output, because the running starter was still the image's copy.

The converse trap (2026-09-19): `/proc/<pid>/cmdline` of hub-main names that
seed path on EVERY boot, and the seed's `package.json` next to it carries the
image version — that is not what the process loaded. What it loaded is the
starter's `booting @camstack/server@X from /data/server-root/current` line, the
launcher's `resolved @camstack/system@… from …` line, and `bootMode` /
`activeVersion` / `runningVersion` on `getServerPackageStatus`. Reading the
version off the cmdline path diagnosed a running hub as a version behind.

- Needs only a closure update → put it behind `main.ts`'s `bootstrap()`.
- Lives in the starter or the **entrypoint** (heap flags, env, gosu) → needs a
  new image **and a container recreate**. `applyServerUpdate` will never
  deliver it.

### Not every workspace package is in the closure

`@camstack/node-root` is `private: true` and is **absent** from
`<dataDir>/server-root/current/node_modules/@camstack/`. `server/backend`'s
`main.js` is `tsc` output, not a bundle, so importing that package from
`main.ts` would have been an unresolvable `require` at boot — it would have
broken the hub, not merely the feature. Verify before importing:

```bash
ssh <hub> 'docker exec CamStack ls /data/server-root/current/node_modules/@camstack/'
```

### The product release is not the npm version

`vX.Y.Z` is the product: image tags, the desktop app, the GitHub release. It
restarts at **0.1.0 beta** and lives in `product-version.json` (the same number
in `packages/desktop/package.json`). `@camstack/*` stay on 1.2.x. The viewer
app stays on 1.0.x and this workflow does not build it.
[D943](../decisions/adr-0943-the-product-release-is-not-the-npm-version.md).

Both the image and the desktop app install `@camstack/server@latest`
(`Dockerfile`, `packages/desktop/scripts/stage-deps.mjs`). The release records
that closure — image label `io.camstack.server.version`, and a line in the
release notes. `scripts/ci/verify-release-npm.mjs` fails closed when `latest`
cannot be resolved. It does not ask `latest` to equal the product version.

Image tags stay accel-prefixed: `intel-X.Y.Z`, `amd-X.Y.Z`, `intel-latest`,
`amd-latest`. A bare `:X.Y.Z` would name two accelerator images.

An install of the desktop app or the Electron viewer shell that is still on
1.2.x will not auto-update to 0.1.0 (electron-updater treats it as a downgrade).
Reinstall once. Later releases on this line use the same feeds (`latest`,
`viewer`). The release name is `CamStack X.Y.Z beta` while the major is 0.

### `npm run publish` — affected only. Never `--all`.

**Default to the affected mode** (`npm run publish`, no flag). It bumps only the
packages that changed since the last `publish-*` tag and prints its own mode
line — `[publish] Mode: affected since publish-YYYYMMDD-HHMMSS`. Check that line
before answering yes: it tells you exactly what is about to move.

`--all` bumps and republishes **every** package in the workspace — around sixty —
and each one then shows up as an available update the operator has to apply to
three nodes. The operator's instruction (2026-08-29) is explicit: *"fai publish
affected solamente, non serve pubblicare ogni volta tutti i 60 addons."* [publish only the affected ones, there is no need to publish all 60 addons every time] An
all-publish turns a two-package change into a thirty-three-package upgrade
window on a live NVR, and every extra package is a runner restart nobody asked
for.

Use `--all` only when the closure itself must be re-cut — a `node_modules`
resolution change, a dependency floor moved for every package, or a recovery
from a partial publish. Say why in the commit message when you do.

**Related trap:** `scripts/publish.sh` does `npm publish` FIRST, then commits the
version bumps and creates the tag. If the command is interrupted between those
two steps — a shell timeout, a killed terminal — **the registry moves and git
does not**, and the next `affected` run computes its diff from a stale tag. This
happened twice on 2026-08-29. Recovery is to commit the already-bumped
`package.json`s with a `chore(release):` message and tag manually; verify with
`npm view @camstack/server version` against `server/backend/package.json`.

The order is **publish → tag → build**, and it went wrong because
`scripts/publish.sh` scanned `packages/*` ONLY, so `@camstack/server` (which
lives in `server/backend`) was invisible to it. `npm run publish -- --all`
reported nine packages and silently omitted the one the release depends on.

Both halves are now closed: the publish script searches `server/` too, and the
release workflow's first gate (`scripts/ci/verify-release-npm.mjs`, pinned by
`scripts/__tests__/verify-release-npm.spec.ts`) verifies BOTH that the version
exists on npm AND that the dist-tag `latest` equals it — so the image's
`@latest` install and the desktop's `@${VERSION}` pin resolve the same closure
at the moment the `intel-<version>` label is minted. Rebuilding an old tag now
fails this gate on purpose: cut a new patch release instead.

### A release can queue forever on a dead runner

`.github/workflows/release.yml` needs `[self-hosted, linux, x64, tower]`. Only
two runners carry `agent-a`, and one (`unraid-2`) had been **offline for three
days** — so tags built one at a time, or not at all, with no signal beyond a
run sitting in `queued`.

```bash
gh api orgs/camstack/actions/runners \
  -q '.runners[] | "\(.name) [\(.status)] busy=\(.busy) :: \([.labels[].name]|join(","))"'
ssh <host> 'docker start github-runner-2'
```

Cancel a publish that has not finished. Once `create-release` has made
`v<version>`, delete that tag before dispatching again — `derive-version`
refuses an existing tag, and a run that already pushed `intel-latest` from
the older tree undoes the newer image if it is left to finish.

The heavy legs are on the home runners, in the org runner group `release`.
That group allows only `.github/workflows/release.yml` on `refs/heads/main`.
GitHub cannot express a `refs/tags/v*` pattern there, so a tag push cannot
reach these machines. The workflow is `workflow_dispatch` only, and its first
job refuses any other ref, so a fork pull request never schedules them. The
light jobs (`derive-version`, `create-release`, `publish-release`, `summary`)
run on `ubuntu-latest` and hold no secret beyond `GITHUB_TOKEN`. An offline
home runner still leaves a Docker or Electron leg `queued`.

### Deploying from a laptop

`camstack deploy` defaults to a LAN address that a laptop on Tailscale cannot
reach (`ETIMEDOUT 192.168.x.x:4443`). Log in to the public endpoint once and
name it; every tool then uses that session:

```bash
camstack login https://camstack.<local-user>.top
camstack deploy packages/<pkg> --server https://camstack.<local-user>.top -n <nodeId>
```

## Release order for a camera's motion path (D673, D696)

A camera's motion runs through these pieces:
- the server (framework, and `camera-grid` inside `@camstack/system`);
- the orchestrator (the camera-sensors bridge, and the ONLY writer of a
  camera's `motion` slice);
- the camera providers (the raw `ProviderMotion` push, and no longer any write
  of the camera's `motion` slice or its boot seed);
- `addon-pipeline` (the runner, which no longer writes the slice);
- the admin UI.

### What the server step really installs (the closure)

**Three of those pieces are not separate steps.** `@camstack/server` declares
eight addons as dependencies (`server/backend/package.json`), and its launcher
RE-ALIGNS every installed bootstrap addon to the closure's copy at boot
(`server/backend/src/launcher.ts`, `planAddonRealignment` in
`server/backend/src/core/addon/addon-realign-plan.ts`) when the closure's copy
is strictly newer AND the installed copy predates the closure:

| Node role | Re-aligned at the server step |
| --- | --- |
| hub | `addon-admin-ui`, `addon-auth`, `addon-decoder-nodeav`, `addon-notifiers`, `addon-pipeline`, `addon-pipeline-orchestrator`, `addon-post-analysis` (`addon-agent-ui` is agent-only, `camstack.agentOnlyBootstrapAddons`) |
| agent | `addon-pipeline`, `addon-decoder-nodeav`, `addon-agent-ui` (`camstack.agentBootstrapAddons`) |

The publish pins each to the version of the same run (`pin-root-deps`):
`@camstack/server` 1.2.430 carried `addon-pipeline` 1.2.315,
`addon-pipeline-orchestrator` 1.2.272 and `addon-admin-ui` 1.2.299. So the
runner, the orchestrator and the admin UI move AT THE SERVER STEP, on every
node that runs them. Only the camera providers are a step of their own.
(Released 2026-10-02, the operator measured the orchestrator booting about
1.5 min after the server step. By the code it is re-aligned at that same boot,
unless its installed copy was written after the closure landed. The hub's
`[launcher] re-aligned …` / `addon re-alignment: N re-aligned, M kept` lines
of that boot say which. **Settled 2026-10-02 follow-up:** the ~1.5 min was the
RUNNER gate waiting for every counted runner node to answer the census — not
the orchestrator install. Live evidence on this hub: the gate opens as soon as
the counted nodes answer (`writer gate open` with `nodes=[…]`), and flaps when
an agent is briefly offline / reconnects; providers open per camera once their
own census answers. The orchestrator process itself is up with the server
realignment.)

**A rollback does NOT roll them back.** An older closure under a newer
installed copy is "not strictly newer", so the re-alignment keeps the installed
copy (`addon-realign-plan.spec.ts`, "keeps a copy newer than the closure").
Rolling the server back leaves `addon-pipeline`, the orchestrator and the admin
UI at the versions they run. Each must be installed back explicitly, on EVERY
node that runs it (`addon-pipeline` runs on the hub and every agent).

### The order

**server (with `addon-pipeline`, the orchestrator and the admin UI) →
providers.** A separate orchestrator or admin-UI deploy after the server is a
no-op when the server step re-aligned it.

- **Record the rollback floor at release time.** The *orchestrator floor* is
  the first orchestrator version that subscribes `ProviderMotion` and carries
  D696 (1.2.272 in the 2026-10-02 release). Write it down; the rules below
  compare against it.
- **The providers go AFTER an orchestrator at or above the floor (D673)** — a
  split provider emits ONLY `ProviderMotion`, and one released in front of an
  orchestrator that does not subscribe it loses all of its cameras' onboard
  motion for every consumer, with no log line. **The closure does not guarantee
  it.** The re-alignment acts only on a package in the node's bootstrap roster
  (a `config.yaml` override wins), already installed, whose closure copy is
  strictly newer AND whose installed directory is older than the closure's; a
  failed re-alignment is a WARN and the boot goes on (`launcher.ts`). So the
  provider step waits for a version READ LIVE:

  **Preflight, before the provider step (reads only):**
  1. `addons.listPackages` — the entry `name: "@camstack/addon-pipeline-orchestrator"`
     has `version` at or above the floor (1.2.272). This is the version
     INSTALLED on the hub's disk, not the running process's; after a deploy
     the addon has restarted, so the two agree;
  2. `pipelineOrchestrator.getAgentLoad` — every entry with `online: true`
     carries `load.motionSliceWriter: "orchestrator"` (every runner is D696; an
     entry without the field is an old runner).

  **Stop rule:** either read short, and the providers do not ship.
- **`camera-grid` stays deferred and unsplit.** It is in `@camstack/system`, so
  it moves with the server; the orchestrator moves at the same boot only when
  the re-alignment re-aligns it, so the server cannot assume an orchestrator
  at the floor. `camera-grid` keeps emitting `MotionOnMotionChanged`
  (`MOTION_EMITTERS_DEFERRED` in `scripts/onboard-motion-emitters-guard.ts`);
  the bridge fails open on it and the session hold (`sensorHolds`) stays.

### How the orchestrator learns that a provider restarted

A forked runner has no Moleculer broker (Phase F), so `$node.connected` never
fires for it, and until 2026-10-02 nothing emitted `WorkerOnline` /
`WorkerOffline` for one: every consumer of those events, the D696 gates
included, was dead for every forked runner. The UDS parent registry
(`LocalChildRegistry`, `lifecycleEvents`) now emits them on the node's kernel
bus, keyed `<node>/<childId>` (a provider is its own runner, so `hub/provider-hikvision`):

- `WorkerOnline` at a new incarnation's FIRST register — the pre-init frame
  `LocalChildClient.start()` sends before the runner loads any addon module,
  emitted before that frame is acked. So it precedes `initialize()`, every
  device restore and every boot seed.
- `WorkerOffline` when the LIVE connection closes, after the hub unregistered
  the child (a superseded connection's close emits nothing).

**This is a framework change.** It is live only once a `@camstack/server`
carrying it is installed (hub and agents). Before that, nothing tells the
provider gate that a provider restarted: see the rollback rules.

**What is left.** The event is emitted on the hub's bus before the child's ack,
and the register handler then yields one event-loop turn (`setImmediate`) before
acking — so a UDS sibling (the orchestrator) that already holds the frame has
one turn to run `forgetProcess` before the provider child proceeds to load,
initialize and restore. The child's first write still needs several UDS round
trips after that, so the gate normally wins by a wide margin. An orchestrator
`setCapSlice` already past its post-await writable check when the gate closes
can still land (one in-flight RPC); the write path re-checks after every await
before starting a new one. A DROPPED event (telemetry, D8; the orchestrator
respawning at that moment) costs at most until the next provider census: every
runner census (each session dispatch, the admin load view) re-asks the
providers once the last provider census is over 30 s old, and an old provider's
own motion opens sessions. An orchestrator boot always reads the answer afresh.

Every hub and agent child coming up is now a real `WorkerOnline`. Who acts on
it, and who deliberately does not:
- **the provider gate**: only for its four provider ids;
- **the runner gate**: only for the runner's own child (`<node>/detection`,
  `isRunnerProcess`). A bare node id is never a Worker event — an agent
  reconnect is `AgentOnline` and that path calls `forgetNode` directly. A
  decoder or provider restart does not close the runner gate; the runner is
  also covered by its readiness epoch;
- **the topology push**: one debounced recompute per restart;
- **the Notification Center: nothing.** `worker.*` produces no notification
  subject (R1-H1), so no `node-online` / `node-offline` push, no
  liveness-ledger row, no state-summary line — as on 1.2.430. Folded into the
  node kinds it pushed for every decoder respawn and update under the seeded
  system rule, and could spend the cooldown of a real agent-offline. A runner
  that really dies is `addon.runner-failed` (D6). A pre-R1-H1 leftover
  `node:<node>/<child>` offline row is forgotten on NC hydrate and skipped by
  the state summary.

### Who writes a camera's `motion` slice, window by window

Two gates keep one writer per slice (D696):
- the RUNNER gate (`MotionSliceWriterGate`): the orchestrator writes nothing
  until every counted runner node answered `getLocalLoad().motionSliceWriter`;
- the PROVIDER gate (`ProviderSliceGate`, per camera, D696 amended
  2026-10-02): a camera owned by Hikvision, Amcrest, Reolink or Wyze — the four
  providers that wrote the slice before D696 — is written only once its own
  provider answered `deviceProvider.getStatus` with
  `motionSliceWriter: 'orchestrator'`. Any other camera's provider never wrote
  the slice and needs no answer.

Forward, from a pre-D696 cluster, with both gates and a server that emits the
worker events:

| Window | Hikvision / Amcrest camera | Reolink / Wyze camera | any other camera |
| --- | --- | --- | --- |
| before | old runner (phase) + old provider (raw, seed): pre-D696, unchanged | old runner + old provider's boot seed: pre-D696 | old runner |
| server step: old runner exited → every runner node answered (measured ~1.5 min) | old provider alone, RAW | NOBODY (frozen; an old provider's boot seed on a restart) | NOBODY (frozen) |
| runner gate open → that camera's provider step | old provider alone, RAW (gate: `old-provider` WARN) | NOBODY (frozen; boot seed on a restart) | the orchestrator, EFFECTIVE |
| provider step: old process exits (`WorkerOffline`) → new process registers (`WorkerOnline`) | the orchestrator alone (the provider is gone), seconds | same | — |
| new process registered → its census answer | NOBODY (closed on `WorkerOnline`), one census (≤ the `getStatus` call) | same | — |
| after | the orchestrator, EFFECTIVE (takeover with a grace window) | same | same |

**With a server that does NOT emit the worker events** (1.2.430, or an
orchestrator deployed ahead of its server), rows 4 and 5 do not happen: an
old-provider camera stays closed (`old-provider`) through the whole provider
step, and opens only at the next provider census — a motion edge on that
closed camera (at most one per 30 s), a runner census more than 30 s after the
last provider census, an `AgentOnline`, or an orchestrator restart. A quiet
camera stays unwritten until one of them. Never two writers forward.

On a multi-node cluster the server-step window ends node by node: an old runner
on a node the update has not restarted yet still writes the cameras it has
attached until it exits, and the runner gate opens only once the LAST runner
node answered.

No window from the server step on has two writers. The price is the frozen
windows: a Reolink or Wyze camera's slice, and in the first window every
camera's, is not written at all until its writer arrives (the takeover then
re-publishes it). An old Hikvision or Amcrest camera shows its RAW motion until
its provider step.

Without the provider gate (the 2026-10-02 release, orchestrator 1.2.272): the
runner-gate-open window had TWO writers on every old Hikvision/Amcrest camera
(the orchestrator and the provider's raw writes, ~1 min measured) and a second
writer on any old provider's restart (its boot seed).

### Releasing the provider gate itself

The released D696 providers (Hikvision 1.2.136, Amcrest 0.2.125, Reolink
1.2.167, Wyze 0.2.122) write no slice but do NOT carry the field, so the
provider gate reads them as old. The field is said by `BaseDeviceProvider`,
which every provider bundles, so the publish that carries this change rebuilds
them with it (the `@camstack/types` cascade).

- **Ship the four rebuilt providers BEFORE the server that carries the gate —
  only when the preflight above passes**: the hub's installed orchestrator is
  at or above the floor (1.2.272), and every runner answers
  `motionSliceWriter: "orchestrator"` (D673: a split provider needs an
  orchestrator at the floor in front of it). Then no window at all: that
  orchestrator ignores the field, the runner writes nothing, the new providers
  write nothing.
- **Server first instead** (or the preflight fails): each of the four
  providers' cameras has NO writer (frozen, `camera motion slice: provider gate
  closed … old-provider` WARN, per camera) until its provider is updated.
  Never two writers.

### Rollback

Reverse order, each addon installed back EXPLICITLY (the server rollback rolls
none of them back, see above):

- **The admin UI first.** Never roll it back alone: the orchestrator rollback
  must follow in the same window — and the providers and `addon-pipeline`
  steps fall between them, so the no-edit window below spans all four steps.
  Do not edit camera sensors from the admin-UI rollback until the orchestrator
  rollback is done: where an old admin-ui faces a new orchestrator (it rewrites
  a Confirm or Replace sensor as In-addition on any detach or apply), and, in
  either direction, where the new server faces a CS-1 orchestrator (it refuses
  every `setCameraSensors`). CS-2 rows read `unreadable` on a rolled-back CS-1
  orchestrator.
- **A provider rollback, with a server that emits the worker events:** the new
  process exits (`WorkerOffline`: the orchestrator writes its cameras alone),
  the old one's pre-init register (`WorkerOnline`) closes them before it loads,
  restores or seeds anything, and its answer has no field, so they stay
  closed: the old provider writes them alone (raw, seed). The race left is in
  "How the orchestrator learns that a provider restarted".
- **A provider rollback on a server that does NOT emit them (1.2.430):** the
  orchestrator never hears of it — the old provider and the orchestrator both
  write that provider's cameras. **Restart the orchestrator immediately after
  the provider rollback** (`addons.restartAddon {"addonId":"pipeline-orchestrator"}`):
  its boot census reads the old answer and keeps those cameras closed. Without
  the provider gate at all (orchestrator 1.2.272) a provider rollback while the
  orchestrator writes is two writers until `addon-pipeline` is rolled back.
- **`addon-pipeline` back (hub and every agent):** the runner gate closes when
  the old runner's `detection` group comes up — its `pipeline-executor`
  readiness with a new epoch, synchronously before any re-attach, and (with a
  server that emits them) its `WorkerOnline` — and the old runner writes every
  camera it attaches. With an old Hikvision/Amcrest also writing raw that is
  the pre-D696 state.
- **The orchestrator below the floor** while `addon-pipeline` is new leaves NO
  writer: every camera's slice freezes. Roll `addon-pipeline` back first. And
  once any provider is at its D673 version, never roll the orchestrator below
  the floor: no older orchestrator listens to `ProviderMotion`, so that
  provider's onboard motion is lost to every consumer with no log line. Roll
  the providers back first.
- **The server last.** It re-aligns nothing on the way down.

### The other rules that still hold

- **The orchestrator is on every onboard motion path.** While it respawns, the
  edges sent in that window are lost for every consumer (a lost clear can leave
  HA export's event path and Alexa ON; HAP resets itself after 5 s). A
  terminally failed orchestrator silences all onboard motion, motion-triggered
  recording included, and writes no camera's `motion` slice (D696): a slice that
  was ON stays ON for HA, HAP hydration, `isDetected` and the admin UI until it
  runs again. A sensor-only episode that straddles a respawn loses its `false`:
  the D475 row closes by `MOTION_CLOSE_AFTER_MS`, HAP self-resets, the slice is
  corrected by D696's boot re-publish, but Alexa and HA's event path stay ON
  until the camera's next effective episode. After a respawn a clear the new
  bridge never saw rise passes through unless an attached sensor still holds the
  motion, and a PIR first seen already high does not count.
- **Releasing the server that removes `virtual-doorbell` (D671 slice 6) needs the
  operator's passive preflight, IMMEDIATELY before the server release** (the old
  server's bindings UI can still re-bind the wrapper in between). The reads
  (reads only):
  1. `deviceManager.listDeviceIdsByCaps {"capNames":["doorbell"]}`;
  2. `deviceManager.getBindingsBatch {"deviceIds":[<the ids the first read
     answered — use those, not remembered ones>]}`: no `doorbell` entry may have
     `providerAddonId: "virtual-doorbell"` (a camera with a composed doorbell is
     expected on `composer`, one with a native doorbell on its provider);
  3. optional: `settingsStore.get {"collection":"addon-settings","key":"virtual-doorbell.doorbell-source-composition-migration-v1"}`
     reads `.value.complete === true` (the row comes back wrapped; no row means
     not migrated).

  **Stop rule:** if any camera still names `virtual-doorbell`, this server
  release must not ship (the migration that carried its doorbell is deleted).
  Rolling the server back below this release needs a server that still ships
  the wrapper (D671).
  See [D671](../decisions/adr-0671-doorbell-sources-migrate-to-composition-before-the-wrapper-is-deactivated.md).
- **The runner handover.** The runner gate opens one census (at most 4 s) after
  the LAST runner node's `detection` group goes ready. Its `pipeline-executor`
  readiness epoch asks for that census on every server; its `WorkerOnline` asks
  too, but only on a server that emits worker events for forked runners (see
  "How the orchestrator learns that a provider restarted"). Failing that, at
  most 30 s + 4 s after the first motion edge that follows. Every camera the provider gate allows is then
  re-published. The gate lines: `camera motion slice: writer gate open` /
  `… closed`, a WARN naming a runner node that has not answered through a whole
  census, and per camera `camera motion slice: provider gate open|closed for
  this camera` (`tags: { deviceId }`, WARN for an old provider). A node the
  registry reports offline does not keep the runner gate closed; a provider
  whose process left (`WorkerOffline`) does not keep its cameras closed.

## The trap worth naming

A framework fix is **not** live until a `@camstack/server` version containing it is
installed. A published `@camstack/system@1.2.13` sitting in the registry while the
running `@camstack/server@1.2.10` pins `system@1.2.9` means the fix is not
deployed — even though the package exists and the bundle hash changed.

So: publishing a framework fix means publishing `@camstack/server` too, even when
nothing under `server/backend/` changed. **The publish workflow now does that for
every package in the server's dependency closure** — `types`, `system`, `sdk`,
`ui-library` and the closure addons alike — derived from `server/backend`'s own
dependencies, not from a list (see *Publishing*). Nothing is "still on you", and
in particular the dependent cascade is NOT the way to get it: it republishes the
things that DEPEND on the change, which is the opposite direction from the one
that ships it.

## Where CI runs

Public CI uses GitHub-hosted runners. A public repository does not run
ordinary CI on the home self-hosted pool. Releases are the exception: Docker
and Electron stay on the home runners, and nothing else is allowed to.

| Workflow | Where it runs |
| --- | --- |
| `ci.yml`, `checks.yml`, `publish-packages.yml`, `unpublish-retired.yml` | `ubuntu-latest` (4 vCPU, 16 GB) |
| `release.yml` `derive-version`, `create-release`, `publish-release`, `summary` | `ubuntu-latest` (`GITHUB_TOKEN` only) |
| `release.yml` Docker and Linux Electron | home runner `[self-hosted, linux, x64, ci-release]` (`docker` on the image jobs), org runner group `release` |
| `release.yml` macOS Electron | home runner `[self-hosted, macos, arm64]`, same group |

`ci.yml` runs on push, pull request and the nightly schedule. A pull request
gets the default token only: no repository secrets, and no
`pull_request_target`. Publish is `workflow_dispatch` from `main`. A release
is `workflow_dispatch` from `main` only (`publish_release=true` creates the
tag). The runner group allows exactly
`camstack/server/.github/workflows/release.yml` on `refs/heads/main` — it
cannot name a tag pattern — and the workflow's first job refuses any other
ref. Each job sets the smallest `permissions` it needs (`contents: read` for
CI; `packages: write` on the image push; `contents: write` only where a
release or the version bump is pushed).

Nx cache is `actions/cache` over `.nx/cache` and `.nx/workspace-data`, keyed
on the lockfile and `nx.json`. The database file is named after the machine,
so `scripts/ci/align-nx-db.sh` copies it onto this VM before nx opens it
(D548, D704). The pinned ffmpeg is cached under `.camstack-ffmpeg`. The Checks
static job keeps an 8 GB heap (`NODE_OPTIONS=--max-old-space-size=8192`).

`runner-watchdog.yml` watched the home runners' queue and is not in this repo.

## Publishing

`.github/workflows/publish-packages.yml`, `workflow_dispatch` only, on
`ubuntu-latest`, and only when the ref is `main`. It is the only thing that publishes to npm — the
`NPM_TOKEN` secret is wired into that job alone, and `scripts/publish.sh` (still
reachable as `npm run publish`) is a local escape hatch, not the route.

- **Affected detection** compares against the last `publish-*` tag.
- **A changed package says so in its CHANGELOG.** `scripts/check-changelog-unreleased.ts`
  runs before the bump, with the same base tag, and fails the run when a package
  whose own files changed (not its specs, README or CHANGELOG) has nothing under
  `## [Unreleased]`; the message lists the packages and the exact
  `npm run changelog:add -- <package> "<line>"`. After the bump and the output
  comparison, `scripts/release-changelog.ts` moves each published package's
  entries under `## [<version>] - <date>` (an empty block becomes "Rebuilt against
  updated dependencies.") before `npm publish`, and the bump commit carries the
  files. The same guard runs in the on-demand Checks workflow.
- **`affected` (default)** publishes only packages whose own files changed — a
  change to `types` / `ui-library` republishes just that library, not its
  ~40 dependents.
- **The closure cascade: anything `@camstack/server` depends on drags
  `@camstack/server` with it.** Narrow from 2026-08-15 (`@camstack/system`
  only), generalised on 2026-09-17. `@camstack/server` is the single root package
  a node installs and the ONLY one published with exact pins
  (`pin-root-deps.mjs`), so a change to a closure member reaches a node through a
  new server and through **nothing else**: publish the library alone and every
  node stays pinned to the previous version, `updateAvailable` stays false, and a
  green publish job reads as deployed. The set is derived from `server/backend`'s
  own `dependencies` — a hand-written list of what is in the closure is exactly
  what goes stale — and the job **fails** if `@camstack/server` is missing from
  the workspace index. Packages outside the closure (`cli`,
  every independently deployed addon) still publish alone.
- **A bundle candidate publishes only when its built output changes.** The
  cascade still selects every package that compiles another package's source
  into its artifact (an authoritative copy, D545) — that select is what gets
  built. After the build, `scripts/ci/publish-output.mjs` hashes the tarball
  (`npm pack --dry-run` file list and bytes, version stamps, absolute build
  paths, vite content hashes, and a bare host-provided
  `@module-federation/runtime` import normalised) and the same hash of the
  version already on the registry.
  Equal, and the package was selected only by the cascade: it is dropped, and
  the server keeps pinning the registry version. Different: it is published.
  A package whose own files changed, a `force_packages` entry, an
  `include_dependents` dependent, and the server itself are not asked.
  Run 40374002262 is the case: a ui-library field and the admin Integrations
  grid published admin-ui, ui-library and the server, and would have dropped
  agent-ui, benchmark, model-studio, osd-manager and training. `dry_run` on
  the workflow prints those decisions and does not publish.
- **Dependent cascade (opt-in, rarely right).** It publishes everything that
  DEPENDS on a changed library — a dozen addons that pin nothing, declare
  `@camstack/*` as `"*"`, and resolve whatever the closure installed. It was
  being used as the workaround for the gap the closure cascade now closes, and it
  bumped 11 packages for a one-file `ui-library` change on 2026-09-17. Turn it on
  only when a dependent's PUBLISHED tarball must change without its own files
  changing — and say why.
- **`all`** publishes everything.
- `scripts/ci/pin-root-deps.mjs` pins the root closure before publish and restores
  after.

**`npm publish`'s exit code is the verdict, and nothing else is.** Three rules,
each bought with a bad release (2026-09-14):

- **0 means published.** The job does not then read the registry back. It used to
  poll ~180 s per failure and call the result, which was wrong in both
  directions: four polls turned one run into 16 minutes, and `types`, `system`
  and `post-analysis` were all declared FAILED while live.
  `ui-library@1.2.162` became visible at 20:49:22 — seven minutes after its PUT,
  four after the run had given up on it. **A read that slow cannot be a verdict
  about a write.** When a version becomes visible is the registry's business.
- **A 403 over an existing version is a FAILURE, not a success.** It was accepted
  as proof that our own flaky double-PUT had landed; it is not — it says the
  version exists, never whose build is under it. `addon-admin-ui` sat at 1.2.199
  in git while the registry was at 1.2.201, the bump computed 1.2.200 off a stale
  replica, the PUT hit an earlier run's artifact, and the job called it published.
  The operator installed a build OLDER than that evening's work three times, was
  told each deploy succeeded, and saw no change. Refusing costs a re-run, which
  reads a caught-up registry and picks a free slot; accepting costs a silent
  no-op release that leaves no trace anywhere.
- **The closure ships only if the rest of the run did.** `pin-root-deps.mjs`
  pins `@camstack/*` to the versions this run publishes whether or not they land,
  so a run with any earlier failure would ship a `@camstack/server` nobody can
  install — the symptom being an `ETARGET` at staging time on every node, twenty
  minutes and one deploy chain from its cause. `@camstack/server` is therefore
  refused outright when `FAILED > 0`. The gate asks what this RUN knows; an
  earlier version of it looked the pins up on the registry and would have refused
  the perfectly good `server@1.2.294` during exactly the seven-minute window
  above. A guard that fires on good releases teaches people to ignore guards.

It ends by running `npx tsx scripts/docs-generate.ts`, then committing the bumped manifests as
**`chore: publish packages (<bump>) [skip ci]`** with `--no-verify` — the commit
is machine-generated and `npm publish` has already run, so a pre-commit hook
could only produce a false failure at the worst moment.

**The regeneration is in the bump commit because the reference embeds the
version.** `docs/reference/packages.md` was NOT regenerated
until 2026-08-20 — every train on 2026-08-19/20 left it stale and turned each
following CI run red on the drift guard, on a diff no human had written. Anything
else generated FROM a version number belongs in this same `git add`
(`docs/reference`, `docs/decisions/index.md`). It then pushes an
annotated `publish-<UTC timestamp>` tag, **before** the commit, so a rejected
commit push still leaves the next `affected` run a usable base.

It creates no `vX.Y.Z` tag, pushes no image, and touches no GitHub Release.

## Cutting a release

A release is a **dispatch from `main`**, and the order is
**publish → dispatch → build**. The workflow creates the tag. Commit the
product version (`product-version.json` and `packages/desktop/package.json`,
the same number) on that commit first.

```bash
gh workflow run "Release — CamStack (Docker + Electron)" --ref main -f publish_release=true
```

`publish_release` defaults to false. That run is an artifact build: installers
stay on the home runner, there is no GitHub release, and `version_type`
(`patch` / `minor` / `major`) still bumps the image tag the way a manual run
always has. `dry_run=true` stops after derive.

```bash
gh workflow run "Release — CamStack (Docker + Electron)" --ref main \
  -f dry_run=true -f version_type=patch
```

`.github/workflows/release.yml` then runs. Light jobs are on `ubuntu-latest`.
Docker and Electron stay on the home runners (group `release`):

| Job | Runner | What it does |
| --- | --- | --- |
| `derive-version` | `ubuntu-latest` | refuses any ref other than `refs/heads/main`. `publish_release` reads `product-version.json` and refuses when `v<version>` already exists; an artifact run bumps by `version_type`. Then `scripts/ci/verify-release-npm.mjs` records `@camstack/server@latest` — see *The product release is not the npm version*, above |
| `create-release` | `ubuntu-latest` | publish only: creates tag `v<version>` on `github.sha` and the GitHub Release **as a draft**, notes from `git log <previous v-tag>..HEAD` |
| `build-docker` | `[self-hosted, linux, x64, docker, ci-release]` | buildx pushes `ghcr.io/camstack/camstack:intel-<version>` **and** `:intel-latest` (and the `amd-` pair) to GHCR with `GITHUB_TOKEN`; linux/amd64 unless `multi_arch` |
| `build-electron` | `[self-hosted, linux, x64, ci-release]`, `[self-hosted, macos, arm64]` | FIVE legs, in PARALLEL: the full desktop product (mac arm64, mac x64, linux x64) **and** the viewer shell (`CamStackViewer-*`, mac arm64 + linux x64, `electron-builder.viewer.json`, no staged closure). One release, one version (D429). A publish uploads each leg to the draft; an artifact run leaves the files on the runner |
| `publish-release` | `ubuntu-latest` | `gh release edit --draft=false`, the only thing that makes the release visible. A failed Docker or Electron leg leaves the draft |

The legs are not serialised
([D429](../decisions/adr-0429-one-release-both-products-and-the-legs-run-in-parallel.md)).
The two mac legs match the same `[self-hosted, macos, arm64]` labels and land
on the two home Mac runners, one user each, so they do not share a keychain.
Signing still builds a temporary keychain from `CSC_LINK`, and the "Restore
the user's keychains (macOS)" step (`if: always()`) puts `login` back before
the job ends. `max-parallel: 1` was tried when one release attached ~2.2 GB at
once and is gone: it cost wall clock and moved no bytes.

The Electron viewer shell is built in this same release, at the **product**
version (D429), not at `@camstack/server`'s version. It is a shell that loads
`/viewer/camstack/` from the hub at runtime, so a viewer app change never needs
a new shell build — `ship-viewer.mjs` owns that path (OTA, the orchestrator's
web bundle, the submodule pin). The viewer **app** stays on its own 1.0.x line
and is not tagged here. Splitting the shell onto a `viewer-v*` tag was tried
and reverted: it moves ~232 MB, about 10%, and costs a second tag to remember.
A shell still on 1.2.x will not auto-update onto 0.1.0; reinstall it once.

**One release, but not one update feed.** electron-updater reads ONE file per
channel per platform, so two products on one release and one channel overwrite
each other's: measured on `v1.2.338`, the `latest-mac.yml` attached to the
release named `CamStackViewer-1.2.338-arm64.dmg` — the file the FULL app reads.
Each product now declares its own `publish[].channel`, the full app keeps
`latest` (its installed base asks for that name and cannot be told otherwise)
and the viewer is `viewer`:

| | mac | linux x64 | windows |
| --- | --- | --- | --- |
| CamStack | `latest-mac.yml` | `latest-linux.yml` | `latest.yml` |
| CamStack Viewer | `viewer-mac.yml` | `viewer-linux.yml` | `viewer.yml` |

The channel is one value read by both halves — electron-builder names the feed
after it, and `initAutoUpdater` hands the same constant to
`autoUpdater.channel` — and each release leg stages its own feed by
`matrix.feed_glob`. A mac product also ships `zip` beside `dmg`, because
Squirrel.Mac applies a zip and nothing else; the order matters, and
[D584](../decisions/adr-0584-each-desktop-product-owns-its-update-channel-and-a-mac-product-ships-the-zip-its-updater-applies.md)
records why the zip is safe only after the channels are separate.
`scripts/check-desktop-update-feeds.ts` fails the build on any of it.

**One mac feed per product, whatever the number of mac legs.** Mac arm64 and
x64 are separate legs, so each electron-builder run wrote a `latest-mac.yml`
listing only its own arch and the last upload won: `v0.1.1` published an
x64-only feed and Apple Silicon Macs updated to the Intel build (Rosetta
prompt). A mac leg now stages its feed as `<feed>.<arch>.feedpart` (release
assets, never `upload-artifact`: the org quota). The `merge-update-feeds` job
runs after every `build-electron` leg, merges the parts with
`scripts/ci/merge-mac-feeds.mjs` (union of `files` by url, everything else from
the first part, x64 first), uploads the merged feed over the name, deletes the
parts, re-downloads the published feed and fails the release if an arch a leg
built has no entry. `publish-release` needs that job, so a draft with a bad
feed is never un-drafted. Applies to `viewer-mac.yml` the day the viewer gets a
second mac arch; a single part passes through unchanged.

**Windows.** The `windows` column above is declared but not built. Enabling
the leg is a matrix row with labels `self-hosted, windows, x64`; the app side
is ready and described in [windows-agent.md](windows-agent.md). A service-mode
agent loads the closure from `Program Files` and an `electron-updater`
replacement of those files while it runs is not handled yet.

A publish uploads the installers from the home runners onto the GitHub Release.
The ~2.2 GB is still attached to one release; if that upload fails, stop
attaching the full desktop installers. They reach nodes through Docker and npm
and are never downloaded by hand. An artifact-only dispatch does not upload
them: the runner keeps the files under its work directory. There is no
`actions/upload-artifact` step.

### A release is not started by a tag

`create-release` creates `v<version>` on the dispatched commit (`github.sha`)
after `derive-version` has refused an existing tag. Pushing the tag yourself
does not start this workflow, and a `[skip ci]` line in the commit message
does not suppress it. The publish workflow still marks its own bump commit
that way so push CI does not rebuild it; that marker is unrelated to a product
release.

### A failed matrix leg leaves the release invisible and the image published

`publish-release` needs every `build-docker` and `build-electron` leg, so ONE
failing leg skips it and the release stays a **draft** — nothing on the releases
page. But the gate is only evaluated once those legs have finished: an Electron
failure does not roll back `build-docker`, which by then has put the image on
GHCR and **moved `:intel-latest`**.

`v1.2.104` and `v1.2.105` are both still drafts (their linux Electron leg died)
while `intel-1.2.104` and `intel-1.2.105` are both on GHCR. So "no release on the
releases page" is not "nothing shipped" — read the registry, not the releases
page, to answer whether an image exists. The repair is to re-run the failed leg
(it uploads to the same draft) and let `publish-release` flip it; un-drafting by
hand publishes a release whose installer list is missing a platform.

## Retiring a published package

Publishing is one-way. Deleting `packages/<x>/` is a one-line commit; the npm
entry outlives it forever — still installable, still the first search hit, and on
a node that already has it, still *running*. An audit on 2026-08-09 found twelve
such names, seven of them published before the 2026-05-21 history reset and so
not recoverable from this repo's git at all.

**A package name tells you nothing about an addon.** One package declares many
addons: `@camstack/addon-pipeline` carries six manifest entries,
`@camstack/addon-provider-homeassistant` two, `@camstack/addon-cloudflare` two.
So the two failure modes are opposite and must be told apart before anything is
retired:

| Case | Example | Verdict |
| --- | --- | --- |
| Package gone, its addon ids **absorbed** by another package | `@camstack/core` → all 18 ids now declared by `@camstack/system` | retirable — the ids MOVED |
| Package gone, its addon ids **deleted** | `@camstack/addon-analytics` — id `analytics` exists nowhere | retirable — say so, it is a removal not a move |
| Package alive, an addon id it used to declare gone | any bundle that dropped an entry | NOT a package question |
| Package gone, ids gone, **but a copy is still deployed** | `advanced-notifier` | do **not** unpublish — see below |

Answering that needs four sets, not two:

| Set | What | How to get it |
| --- | --- | --- |
| **A** | every `@camstack/*` on npm, **including deprecated** | `npm access list packages @camstack` — the registry's *search* endpoint omits deprecated packages, so it silently under-reports exactly the ones you are auditing |
| **B** | workspace package names | every `packages/*/package.json` + `server/*/package.json` `name` |
| **C** | workspace **addon ids** | every `camstack.addons[].id` across all of B — one package, many ids |
| **D** | ids and packages actually **deployed** | `<dataDir>/addons/@camstack/**` on each node **and** `nodes.topology` — a deployed copy can exist unregistered, and a registered addon can be running from a directory that no longer exists |

`scripts/check-npm-orphan-packages.ts` keeps A ⊆ B ∪ retired from rotting again:
anything npm still presents as current must be buildable from this workspace, or
be recorded as deliberately retired with a note saying where the behaviour went.

**The dangerous bucket is D − C: code running on a node that nobody can read.**
The audit found exactly two, both on the hub, both still `running` because the
process was started before their directories were renamed aside:

- `advanced-notifier` (`@camstack/addon-advanced-notifier@1.2.4`, ids
  `advanced-notifier` + `notification-output`) — deleted from the workspace in, **never published to npm**, and still deployed on the agent
  (`agent-a`, 1.2.0, unregistered there). The quarantined directory on the
  hub is the last complete copy in existence.
- `export-ha-mqtt` (`@camstack/addon-export-ha-mqtt@1.2.10`, cap
  `device-export`) — superseded by `homeassistant-export` in
  `@camstack/addon-provider-homeassistant`. This one *is* on npm, so the tarball
  is the recoverable copy.

For anything in that bucket the order is fixed: **un-deploy first, restart the
runner to prove nothing depended on it, and only then touch the registry.**
Unpublishing before the copy is gone destroys the only artefact that could put
the node back.

Two residues that outlive a quarantine and must be cleaned in the same pass:

1. **`<dataDir>/addons/manifest.json` still names the package.** Renaming the
   directory does not touch the manifest, and the addon back-fill reads the
   manifest — so on the next reconcile the hub tries to install a name that 404s.
2. **The process keeps running.** Quarantine is a rename; the loaded module is
   already in memory and `nodes.topology` will keep reporting `running` until the
   runner respawns.
