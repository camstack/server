---
title: Single-copy addons — no seed tree in the image, installed at first boot
last-verified: 2026-10-02
applies-to:
  - Dockerfile
  - server/backend/src/launcher.ts
  - server/backend/src/first-boot-addon-plan.ts
  - server/backend/src/bootstrap-packages.ts
  - packages/system/src/kernel/addon-installer.ts
---

# Single-copy addons — no seed tree in the image, installed at first boot

Roadmap task 32, the last unfinished half of [D45](../decisions/adr-0045.md).
Operator decisions, 2026-08-12:

- the docker seed **stays** for `@camstack/server` and the system packages —
  *"mi va benissimo tenere il seed che va con docker … una copia di server e dei
  pacchetti di sistema"* [I am perfectly fine keeping the seed that ships with docker … one copy of the server and of the system packages];
- everything else is single-copy, always — *"tutti gli altri addons devono
  rimanere copia unica, sempre, installati durante l'avvio iniziale"* [all the other addons must remain a single copy, always, installed during the initial startup];
- and a boot is never prevented — *"non dovremmo mai prevenire il boot"* [we should never prevent the boot]. The
  strict inventory flag is already gone, and nothing in this design
  reintroduces a refusal.

## 1. The copy landscape today — measured, not recalled

Every number below was read on 2026-08-13 from the live containers (`du -sm`
inside `CamStack` on the hub and `CamStack-Agent` on `agent-a`).

| Location | Hub | Agent | What it is | Task 32 verdict |
| --- | --- | --- | --- | --- |
| `/opt/camstack-hub` | 921 MB | 920 MB | image starter closure: `@camstack/server` + its whole dependency graph, incl. `@camstack/{system,types,sdk}` and the natives | **KEEP** — the operator's "una copia di server" |
| `/opt/camstack-seed-framework` | 510 MB | 510 MB | a SECOND copy of system/types/sdk + `better-sqlite3`, `sharp`, `node-av` (`@seydx` alone is 167 MB) | candidate — it duplicates what `/opt/camstack-hub/node_modules` already holds (see §5) |

> **The measurement above is 2026-08-13 and both trees carried `@camstack/shm-ring`
> then. They do not any more.**
> [D184](../decisions/adr-0184-the-closure-carries-no-package-nothing-imports.md)
> took it out of the dependencies of `@camstack/system` and `@camstack/server` on
> 2026-08-19, so the hub closure no longer resolves it and the seed's own
> `SYSTEM` list no longer asks for it — which it had to stop doing, because
> `ver('shm-ring')` reads the version out of the freshly-installed hub closure
> and would have thrown `ENOENT` at the next image build. The byte
> totals are barely affected; what changed is which packages exist, and §6
> depends on that.

> **2026-08-25: the `/opt/camstack-seed-framework` row above is now historical.**
>  deleted the second tree from the Dockerfile (rebuilt correctly by
>  after a bad slice briefly amputated the runtime stage); the
> fallback now copies its framework subset directly out of
> `/opt/camstack-hub/node_modules`, replacing rather than merging the
> `@camstack` scope. This is the §4.4/§5 dedup this document filed as a
> deliberate separate step — it landed, see the note at the end of §5.
>
> **Re-checked 2026-09-23: it is in the image definition.** The `Dockerfile`
> copies exactly one baked tree, `/opt/camstack-hub`, and there is no
> `/opt/camstack-seed-framework` step left anywhere in it. (The comment above
> that `COPY` still says "the two seed closures" and is itself stale — a
> leftover describing the right design, which reads as verification.)
| `/opt/camstack-seed-addons` | 43 MB | 43 MB | 8 addon trees baked at build time | **REMOVED** by the decision |
| `<dataDir>/framework` | 509 MB | 549 MB | the legacy framework tree; inert in data-root mode, still on `NODE_PATH` | **REMOVED** (D45 cleanup) — but see the trap in §5 |
| `<dataDir>/addons` | 265 MB (31 pkgs) | 175 MB (12 pkgs) | the runtime authority — the only thing `AddonLoader` reads | **KEEP** — this is "la copia unica" |
| `<dataDir>/server-root` | 3 653 MB | 911 MB | `current` (the active closure) + `current.bak-pre-*` × 3 on the hub + `dev-uploads` | out of scope, but the hub is carrying ~2.7 GB of retired roots |
| npm registry | — | — | the published truth; every version is installable | the source first boot pulls from |

The addon seed is the smallest tree on the list and the only one the decision
removes outright. That is the point: **its cost was never bytes, it was
answers.** The seed and the runtime disagree on the hub today —

| package | seed (`/opt`) | installed (`<dataDir>/addons`) |
| --- | --- | --- |
| `addon-admin-ui` | 1.2.47 | 1.2.50 |
| `addon-pipeline` | 1.2.64 | 1.2.69 |
| `addon-pipeline-orchestrator` | 1.2.45 | 1.2.49 |
| `addon-post-analysis` | 1.2.64 | 1.2.66 |
| `addon-notifiers` | 1.2.16 | 1.2.17 |

— five packages where a truthful "which version is on the hub" has two answers.
The per-package `keep` guard in the entrypoint means the seed no longer
overwrites them ([D90](../decisions/adr-0090.md)), so what remains is pure
ambiguity plus 43 MB.

Two more copies the decision does **not** remove, recorded so they are not
rediscovered:

- the agent still holds `<dataDir>/addons/@camstack/system@1.2.78` — a copy
  [D107](../decisions/adr-0107.md) says nothing should write any more, and the
  one that left both agents 17 versions behind. It is *installed*, not seeded, so
  removing the image seed does not touch it.
- `<dataDir>/framework` is **not** removable by deleting it. The entrypoint
  re-creates it from `/opt/camstack-seed-framework` whenever
  `$FRAMEWORK_DIR/node_modules/@camstack/system/package.json` is absent. The hub
  shows 509 MB and `system@1.2.78` today although the handover of 2026-08-12
  records it as purged — a container restart put it straight back.

## 2. What first boot has to decide, once the seed is gone

Bootstrap already installs from npm when a package is missing
(`AddonInstaller.ensureRequiredPackages` → `installFromNpm`). The seed simply
gets there first: the Dockerfile sets
`CAMSTACK_BUNDLED_ADDONS_DIR=/opt/camstack-seed-addons/@camstack`, which makes the
launcher resolve `installSource: 'local'` and copy. Delete the tree and unset the
env and the same loop reaches the registry — **the hook already exists and does
not move**. That is deliberate: no new boot phase, no second installer.

What changes is that two questions the seed answered implicitly become live.

### 2.1 Which version — `latest`, and that is the whole contract

**Operator, 2026-08-13, overriding the original design here:** *"il sistema è
designato per essere addons-agnostic, latest va sempre bene al primo boot"* [the system is designed to be addons-agnostic, latest is always fine on first boot].
There is no version contract between the closure and an addon, so first boot
asks the registry for `latest` and keeps what lands.

That deletes a machinery this design originally proposed — pin-from-the-closure
plus adopt-by-semver — and with it a real trap: the pin is not always there.
`@camstack/server` 1.2.90 → 1.2.94 were published with `"@camstack/addon-pipeline": "*"`
(`scripts/ci/pin-root-deps.mjs` did not run), 1.2.96+ carry exact versions, and
the image the hub is running is one of the unpinned four. A design that depended
on that field would have had nothing to read on the live fleet.

What survives from the idea is the **report**, not the behaviour: the boot prints
where an installed addon differs from the copy inside this node's own closure —
one node, two truthful versions, which is the condition task 32 exists to end.

!!! warning "Superseded on 2026-09-17: the report became an ENFORCE arm — after a month of reporting nothing"

    Two things happened to this paragraph, and the order is the lesson.

    **The report never printed.** `planFirstBootAddons` read the closure through
    `path.resolve(__dirname, '..', 'node_modules')`, which reads as plausible and
    points at `<server>/node_modules` — a directory npm never creates, because
    every `@camstack/addon-*` is HOISTED to the top-level `node_modules`, three
    levels up. So the plan found no closure version for any package, computed
    `twoVersions: false` for all of them, and printed `8 package(s), 0 to
    install` on every boot for a month. A wrong path that answers "nothing" is
    indistinguishable from a closure that carries nothing, which is why nobody
    ever acted on the observation: its INPUT was empty. The plan now says so out
    loud when EVERY package comes back without a closure version
    (`server/backend/src/closure-node-modules.ts`).

    **And the behaviour was built after all**, under the reserved number **D518**
    (`docs/roadmap.md` holds the reservation; no record has been written yet — <!-- drift-ok: moved to the private planning repo -->
    shipped under D518): the boot RE-ALIGNS an addon from the closure rather than only naming the
    drift. `applyServerUpdate` had been advancing the closure's copy of every
    addon while nothing ever loaded one from there — six addons on the hub were
    behind by up to nineteen versions, each frozen at whenever somebody last ran
    `camstack deploy`. A new install source, `closure`, distinct from `bundled`,
    is what lets an operator tell "I deployed this" from "the server update
    brought it"; the six stale copies all read `upload`, because each HAD been a
    deliberate deploy, once. The failure policy is this design's and does not
    change: a re-alignment that throws never ends a boot, and each failure names
    its addon.

    `latest` at first boot (the paragraph above) is untouched. What changed is
    what happens on EVERY LATER boot to a package the closure also carries.
INFO only; it never drives an action.

### 2.2 What about the copy already on disk

It wins, always (D90 — the unconditional `cp -a` that would have rolled every
deployed addon back). Bootstrap is seed-only: a package with a `package.json`
under the addon root is adopted whatever its version, older or newer. Nothing in
this path ever upgrades, downgrades or deletes an addon. That is what
`camstack deploy`, the Admin UI update and the back-fill are for, each with an
operator or a registration behind it.

## 3. Boot must never be prevented — the offline / registry-down path

A fresh node with no registry gets **no addons**. It still boots, and that is a
property worth stating precisely, because it is what makes the whole change safe:

- the four REQUIRED infra capabilities — `storage-provider`,
  `data-store-provider`, `storage`, `settings-store` — are **builtins of
  `@camstack/system`**, which comes from the closure the image keeps. Zero addons
  installed is a kernel that boots.
- `ensureRequiredPackages` already treats a failed install of a non-system
  package as a logged error and continues; only `@camstack/system` throws, and
  that path is unreachable while the closure resolves it.

What is missing today is **loudness and recovery**, not survival:

1. **Loudness.** A boot that installed nothing must say which packages are
   missing, why (registry unreachable vs version-not-found vs a bad tarball) and
   what the node cannot do as a result — the operator's usual symptom will be
   "the Admin UI is a 404", and the log has to be the thing that answers it. A
   branch that drops work silently logs it (CLAUDE.md, Logging).
2. **Recovery.** The retry must not be a boot-time backoff loop — that turns a
   registry outage into a slow boot, i.e. a refusal by another name. It belongs
   *after* the node is up and serving: a bounded catch-up that re-attempts the
   missing set when the hub next sees the registry, plus the existing
   `clusterNodes.repairNodeAddons` as the explicit operator escape hatch.
3. **A visible state.** "Bootstrapped incomplete: 3 of 8" belongs on the node's
   status alongside `imageContract`, so the Cluster page shows it rather than the
   log alone.

The counter-case that decides the shape: a hub that boots with no `addon-auth`
and no `addon-admin-ui` is reachable over SSH and fixable; a hub that refuses to
boot records nothing and notifies nobody (D45 § Enforcement).

## 4. How `camstack deploy` interacts

Unchanged, and simpler. Removing the seed removes a *writer* from the addon root,
leaving the list in `update-and-release.md` one shorter:

| Writer | Still there? |
| --- | --- |
| `camstack deploy` / Admin UI upload | yes — the operator gesture |
| `propagateToAgents` / `deliverAddonToAgent` | yes |
| the addon back-fill | yes — and it becomes the main first-boot repair path for an agent |
| `ensureRequiredPackages` (bootstrap, only when absent) | yes — now from npm rather than from `/opt` |
| the image seed | **gone** |

One interaction is worth naming: a deploy of a workspace build carries a version
that may also exist on npm as a *different* bundle (the 2026-08-02 back-fill
trap). Bootstrap never re-installs a package that is present, so it cannot
overwrite a deployed bundle — the seed-only rule is what protects this, and it is
kept verbatim.

Dev is unaffected: `CAMSTACK_INSTALL_SOURCE=local|symlink` with a workspace
`packages/` dir still wins over npm inside `ensureRequiredPackages`.

## 5. The Dockerfile diet

What leaves:

1. the whole **stage-1 addon seed step** (the `node -e` loop that installs each
   bootstrap addon standalone into `/opt/camstack-seed-addons/@camstack/<n>`) and
   its three `test -e` assertions;
2. `COPY --from=fetch /opt/camstack-seed-addons …`;
3. `ENV CAMSTACK_BUNDLED_ADDONS_DIR=…` — the env is what makes the launcher pick
   the local copy, so it must go with the tree, not after it;
4. the entrypoint's `NEED_ADDONS` block, and the addon half of the
   `/opt/camstack-seed-version` fingerprint;
5. `server/backend/src/__tests__/entrypoint-addon-seed.spec.ts`, whose subject <!-- drift-ok: deleted by this very change -->
   stops existing — deleted in the same commit, because a test that still
   describes a removed block reads as verification (CLAUDE.md, Working style).

Effect on `scripts/single-copy-baseline.json`: `Dockerfile » seed-addons-tree`
10 → 0. The ratchet then asks for a re-pin, which is the evidence the step
happened.

**What does NOT leave, and why it is a separate step.** `/opt/camstack-seed-framework`
(510 MB) is redundant on paper — `/opt/camstack-hub/node_modules` already carries
`@camstack/{system,types,sdk}` *and* `better-sqlite3`, `sharp`, `node-av` at its
root, which is exactly what the seed tree provides. But it is
the source the entrypoint copies into `<dataDir>/framework`, which is still on
`NODE_PATH` and is still the baked-mode fallback before the first
`applyServerUpdate`. Removing it is the `/opt` dedup half of task 32 and it moves
a resolution path, so it wants its own change, its own boot on a scratch volume,
and its own bucket in the baseline (`seed-framework-tree` 7 → 0,
`legacy-framework-dir` 4 + 4 → 0). It is **not** bundled with the addon diet.

> **2026-08-25 — the `/opt` half of this landed, the `<dataDir>` half did not.**
>  removed `/opt/camstack-seed-framework` from the Dockerfile (fixed
> after a bad slice by); `scripts/single-copy-baseline.json` lost the
> `Dockerfile » seed-framework-tree` key entirely (was 7), confirming the ratchet
> fired as this section predicted. The fallback block in the entrypoint (§7) is
> unchanged in shape — same `DATA_ROOT_SYSTEM` condition — but now sources the
> framework subset from `/opt/camstack-hub/node_modules` instead of the deleted
> second tree. `legacy-framework-dir` (`Dockerfile`: 4, `launcher.ts`: 4) is
> **still open** — that bucket has not moved, so `<dataDir>/framework` and its
> `NODE_PATH` fallback are not part of this change; they remain future work.
> Nothing has been built into an image or deployed for this yet (commit
> trailers say so explicitly) — §10 is still the accurate "still to do" list.

## 6. Convergence to one copy — the post-boot sweep

Operator, 2026-08-13: the system seed stays in the image for the first boot and
as a fallback; once a node has booted CORRECTLY the redundant data-side copies
are removed; the end state is one version of everything per node, and *"l'agente
deve essere identico all'hub"* [the agent must be identical to the hub]. Recorded as [D129](../decisions/adr-0129.md).

**What is redundant** — the legacy `<dataDir>/framework` tree, and any
host-provided package under the addon root that the RUNNING CLOSURE actually
resolves. `CLOSURE_PROVIDED_PACKAGES` (`server/backend/src/single-copy-cleanup.ts`)
still lists all five (`system`, `types`, `sdk`, `shm-ring`, `ui-library`), but the
sweep deletes a copy only when `closureProvides(pkg)` says so — and since
[D184](../decisions/adr-0184-the-closure-carries-no-package-nothing-imports.md)
that answer is **false for `shm-ring`**. An addon-root copy of it is therefore
KEPT, deliberately: it is no longer a stale duplicate of the closure, it is the
only copy a pre-[D18](../decisions/adr-0018.md) addon has left. Deleting it out
from under a running process is the shape that made a fresh deployment
unbootable once already. On `agent-a` that second one is real:
`<dataDir>/addons/@camstack/system@1.2.78`, a copy **nothing loads** — both roles
pass `['@camstack/system']` as the loader's skip list
(`addon-registry.service.ts`, `agent/addon-scan.ts`) — and which still wins for
anything that resolves through the addon root.

**When.** At the role's own healthy-boot moment, and nowhere else: the hub right
after `confirmBootHealthy()`, the agent inside `confirmAgentBootHealthy()` on its
first acked `registerNode`. Both call ONE function.

**The gates**, because a sweep at the wrong moment bricks a node:

| Gate | Why |
| --- | --- |
| boot confirmed healthy | before that, these copies ARE the recovery path |
| an active closure exists | in baked mode the node is running FROM the fallback tree |
| `@camstack/system` resolved from INSIDE that closure | otherwise the copy being deleted may be the one in memory |
| candidate not inside the closure / not under `/opt` / not on the module search path | each is a live copy whatever the mode says |

A blocked sweep is LOUD and names every copy it left behind — silence would be
indistinguishable from a converged node. Removal is rename-then-delete (the
`evictInstallDir` pattern): the rename is what ends the shadowing and succeeds
with inodes still open; a delete that fails leaves residue, not a shadow. A copy
that could not even be renamed is reported as failed.

`CAMSTACK_SINGLE_COPY_CLEANUP=off` disables it from the outside.

## 7. The entrypoint stops re-creating the framework tree

This is the half without which the sweep is theatre. `/data/framework` was
re-seeded whenever `@camstack/system` was missing under it, so deleting 509 MB
lasted exactly until the next container restart.

Now the condition is the closure, not the tree:

```sh
DATA_ROOT_SYSTEM="$DATA_DIR/server-root/current/node_modules/@camstack/system/package.json"
[ ! -e "$DATA_ROOT_SYSTEM" ] && NEED_FRAMEWORK=1
```

i.e. a genuinely fresh `/data` (before the first `applyServerUpdate`) or a
closure that did not survive one — the two boots that would otherwise fail. It
prints `FALLBACK` twice, with both paths. In steady state the block does nothing
and the tree stays gone.

## 8. What changed against the original design

| # | Original design | Operator decision | Result |
| --- | --- | --- | --- |
| 4.1 | drop the addon seed; framework seed "keep for now" | keep the SYSTEM seed as the deliberate first-boot/fallback source; remove the data-side copies after a healthy boot | the `/opt` system tree is now a *decision*, not debt; the debt moved to `<dataDir>` where it is swept |
| 4.2 | remove `<dataDir>/framework` as a later step | remove it AND stop the entrypoint re-creating it; recreation only as the logged fallback | shipped together — separately, the removal does not stick |
| 4.3 | pin from the closure + adopt-by-semver | **no pinning at all**, `latest` is the contract | `resolveWantedVersion`, `compareVersions`, `bootstrapPinsFrom` and the `pins?` argument on `ensureRequiredPackages` are DELETED, with their tests. Divergence survived as INFO until 2026-09-17, when it became a re-alignment — see the §2.1 note |
| 4.4 | dedup `/opt/camstack-seed-framework` against `/opt/camstack-hub` | keep the `/opt` tree; kill its data-side effects | as of 2026-08-13 the 510 MB in-image duplicate stayed and only the 509 MB per-node copy went; as of 2026-08-25 the `/opt` duplicate is gone too, sourced from `/opt/camstack-hub` instead — see the §5 note. Not yet in a built/deployed image |
| 4.5 | — | agent identical to hub; delete the agent's `addons/@camstack/system`; cap update backups at one | first two shipped as ONE function called from both roles. The third needs no code: `applyServerUpdate` already retains nothing ([D17](../decisions/adr-0017.md)) — the `current.bak-pre-*` dirs were made by hand |

## 9. What landed, and what the image still needs

**In this commit** (backend + image definition; no image built):

- `single-copy-cleanup.ts` — pure planner, discovery, executor, kill switch
  (24 tests; the three node-wide gates neutralised one at a time, each broke
  tests);
- `single-copy-cleanup-runner.ts` — the one adapter both roles call;
- `main.ts` / `agent/main.ts` — wired at each role's healthy-boot point;
- `first-boot-addon-plan.ts` — reduced to adopt / install-latest / skip, printed
  every boot;
- the Dockerfile: addon seed step, its `COPY`, `CAMSTACK_BUNDLED_ADDONS_DIR` and
  the whole `NEED_ADDONS` entrypoint block removed; the framework fallback
  re-conditioned on the closure; the seed fingerprint re-scoped (it covered
  `system`/`types`/`sdk` only; as of 2026-09-23 it is hashed over every baked
  `@camstack/*` JS file in the one remaining tree, which is what the line above
  it always claimed — it therefore moves on more changes than before, the
  conservative direction);
- `entrypoint-addon-seed.spec.ts` DELETED (its subject no longer exists) and
  replaced by `entrypoint-framework-fallback.spec.ts`, which runs the real block;
- baseline re-pinned: `Dockerfile » seed-addons-tree` 10 → 0.

**Still to do, operator-visible:** the image rebuild and the container recreate —
see §10.

## 9b. The sweep is TRAIN-BOUND — measured on the recreated agent, 2026-08-13

`agent-a` was recreated on `camstack-agent:single-copy-1.2.101`, built from
the commit that carries the post-boot sweep. The image half worked exactly as
designed — no `/opt/camstack-seed-addons`, no `FALLBACK` line, `first-boot addon
plan (observe) — 4 package(s), 0 to install`, every runner connected. **The sweep
never ran, and nothing said why.** Both targets were still on disk three minutes
later: `/data/framework` 549 MB, `/data/addons/@camstack/system` 81 MB.

Measured on the node:

| Question | Answer |
| --- | --- |
| `@camstack/server` at `server-root/current` | 1.2.101 |
| `@camstack/server` in the image (`/opt/camstack-hub`) | **1.2.101 — the same** |
| `dist/first-boot-addon-plan.js` present | yes, in both |
| `dist/single-copy-cleanup*.js` present | **no, in either** |

So the boundary is exact: the train published between this task's two commits.
1.2.101 carries the observe plan and not the sweep.

**And the deeper fact, which is not an ordering accident.** The image never
contains this repo's backend: the Dockerfile installs `@camstack/server@latest`
from npm. A backend change is therefore train-bound *by construction* — building
an image from a commit does not ship that commit's server code, and the starter
then prefers `server-root/current` anyway.

### Where the sweep belongs — and why it does NOT move to the entrypoint

The entrypoint is image-owned and would have run today. It is still the wrong
home, because the gate that makes the sweep safe is knowledge the entrypoint
provably does not have at the moment it runs: no Node has started, no closure has
been exercised, no boot has been confirmed. The only condition available to it is
"the files look present", and deleting the baked-mode fallback because a
directory exists is precisely what [D129](../decisions/adr-0129.md) §6 refuses —
a closure can exist and still not boot, and that is the case the fallback is for.

Splitting it — the addon-root copies from the shell, the framework tree from the
runtime — was rejected for the other reason this repo keeps paying: two
implementations of one rule that must agree.

**So: the sweep stays in the runtime and ships with the next train.** What
changed instead is that its absence is no longer silent. The entrypoint now
states, before Node starts, which backend is about to run and whether that copy
carries the sweep:

```
[entrypoint] backend @camstack/server@1.2.101 from /data/server-root/current/…
             — post-boot single-copy sweep ABSENT; the redundant data-side copies
             WILL REMAIN this boot (the sweep ships in a published
             @camstack/server, never in an image build)
```

It reports and never gates. Pinned by three tests in
`entrypoint-framework-fallback.spec.ts`, which run the real block.

### Verifying it landed, on any node

```bash
docker exec <container> sh -c 'ls /data/server-root/current/node_modules/@camstack/server/dist/single-copy-cleanup.js'
```

Present → the next healthy boot converges. Absent → the node is running a
backend older than the sweep, whatever its image is labelled.

## 10. The morning-after procedure

Nothing below happened tonight. Order matters: the closure must be published
before an image is built, or the image labels a version it does not contain.

0. **The sweep needs a NEW `@camstack/server`.** Everything in §9b: the image
   installs the backend from npm, so the version that must carry
   `dist/single-copy-cleanup.js` is the one published for the next train. The
   image migration is already live and correct without it — a recreated node
   simply keeps its redundant copies and now SAYS so at boot.
1. **Publish first.** `@camstack/server` must exist on npm and be `latest`
   (`scripts/ci/verify-release-npm.mjs` gates this) — the image installs
   `@camstack/server@latest` and every addon comes from the registry now, so a
   half-published release is a node with missing addons rather than an old one.
2. **Build the image** from this Dockerfile (release workflow, tag
   `intel-<version>`). Expect it ~43 MB smaller and one build step shorter.
3. **Recreate ONE container first — the agent** (`agent-a`), because it is
   the node carrying the extra `addons/@camstack/system` and the smaller blast
   radius. Watch for, in order:
   - `[entrypoint]` printing **no** `FALLBACK` line (its closure is healthy);
   - `[launcher] first-boot addon plan (observe) — N package(s), 0 to install`
     (a node with its addons already installed fetches nothing);
   - `single-copy cleanup — 2 copy(ies) to remove`, then `removed /data/framework`
     and `removed /data/addons/@camstack/system`.
4. **Verify the agent is still running addons** (`nodes.topology`, and the
   `[launcher] resolved @camstack/system@… from …` line naming
   `server-root/current`). Then `du -sm /data` — expect ~550 MB back.
5. **Recreate the hub** and watch the same three lines.
6. **The one thing to check on a GREENFIELD volume** (a fresh `/data`): the
   entrypoint prints `FALLBACK` (there is no closure yet), the launcher installs
   the whole roster from npm at `latest`, and the sweep is BLOCKED that boot
   (baked mode) — it converges on the boot after the first `applyServerUpdate`.
   That is the path the removed seed used to cover; it is the one worth watching
   with a terminal open.
7. **If the registry is unreachable during a greenfield boot**: the node comes up
   with the kernel only (no Admin UI). The log names every package it could not
   fetch. Recovery is `clusterNodes.repairNodeAddons` or a `camstack deploy`,
   once the registry is back — not a container restart.

Rollback: recreate the container on the previous `intel-<version>` image. The
sweep does not run backwards — a node whose `<dataDir>/framework` was removed
gets it back on the old image the first time its closure looks broken, and never
otherwise.
