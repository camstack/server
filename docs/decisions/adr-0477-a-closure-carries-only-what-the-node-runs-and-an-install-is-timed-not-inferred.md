---
id: D477
title: A closure carries only what the node RUNS, and an install's cost is TIMED, never inferred from a fetch timer
status: accepted
date: 2026-09-12
supersedes:
applies-to:
  - packages/addon-admin-ui/package.json
  - packages/ui-library/package.json
  - packages/node-root/src/root-update-service.ts
---

## Context

The operator reported that updating the `agent-a` agent (Intel N100,
Unraid, container `CamStack-Agent`) had become "dannatamente lento" [damn slow] — it used to
be effectively instant — and volunteered a cause: the moleculer patch landed
"un paio di giorni" [a couple of days] earlier. Both halves of that report were checked. The date
was right. The cause was not, and neither was any of the six numbers the
investigation inherited.

**The regression is real and datable to the hour.** The agent's own
`docker logs CamStack-Agent` (retained since the container was created
2026-08-27) carries a start marker, `root package update requested`, and an end
marker, `root package update staged — restarting to apply`. Fourteen pairs:

| requested (UTC) | staged (UTC) | seconds |
| --- | --- | --- |
| 09-08 12:10:42 | 09-08 12:11:59 | 76.3 |
| 09-08 17:15:07 | 09-08 17:16:39 | 92.0 |
| 09-08 19:34:44 | 09-08 19:36:30 | 105.4 |
| 09-09 05:39:07 | 09-09 05:40:15 | 67.5 |
| 09-09 11:49:38 | 09-09 11:51:07 | 89.3 |
| 09-09 18:26:03 | 09-09 18:27:56 | 112.8 |
| 09-09 21:47:10 | 09-09 21:49:11 | 120.6 |
| 09-11 03:29:14 | 09-11 03:29:36 | 22.5 |
| 09-11 12:01:39 | 09-11 12:03:11 | 91.8 |
| **09-11 16:56:22** | **09-11 17:03:10** | **407.3** |
| 09-11 19:21:44 | 09-11 19:27:47 | 362.8 |
| 09-11 22:00:03 | 09-11 22:05:44 | 341.0 |
| 09-12 07:26:57 | 09-12 07:31:54 | 297.3 |
| 09-12 14:47:02 | 09-12 14:50:24 | 202.7 |

Median 92 s before, 297–407 s after, and the step falls inside
**2026-09-11 12:01 → 16:56 UTC**.

**The cause is a hung CIFS backup pinning the GLOBAL dirty-page budget.** On
that host:

```
D 2635427 balance_dirty_pages  tar -c -P -f \
  /mnt/remotes/agent-a_backups/agent-a/ab_20260911_051501/Influxdb.tar \
  /mnt/user/appdata/influxdb
D   14870 lock_sock            [cifsd]
D 2635139 cifs_server_lock     [kworker/u16:4+flush-cifs-3]
D 3167163 cifs_server_lock     [kworker/0:3+cifsiod]
```

An Appdata Backup `tar` started **2026-09-11 05:15:01** (the timestamp is in its
own path) has been in uninterruptible sleep for ~36 hours writing to
`//agent-a.local/backups`, mounted `hard`. Prometheus agrees to the minute:
`node_filesystem_avail_bytes` for that mountpoint develops gaps from
**09-11 03:35 UTC** and stops entirely at **09-11 06:55 UTC**; host iowait steps
`31 % (03h) → 57 % (04h) → 93.6 % (05h)` and reaches 150–177 % by evening (of
400 % = 4 cores), while `node_procs_blocked` goes `0 → 1–3` and **user CPU
FALLS** from ~155 % to 50–90 %. Local block devices stay at 2–17 % utilisation
throughout: nothing is saturated except the dirty-page throttle.

`balance_dirty_pages` is why this reaches an unrelated `npm install`.
`dirty_ratio` is a **system-wide** budget, not per-device. A mount that accepts
dirty pages and never flushes them pins that budget, and every other writer on
the box is throttled in the same place. A `stat -f` on the mount was unkillable
**even under `timeout 8`** — that is the signature.

Upstream, the hub's own `/mnt/user/backups` was healthy throughout (1.9 TB, 31 %
used, `smbd` up, no D-state), and the interrupted set tells the rest:
`plugin catalog.tar` (1.42 GB) landed 05:33:22 local, `pihole-v6-unbound.tar`
(460 MB) landed 06:30:54, `Influxdb.tar` — the file the stuck `tar` names — was
**never created**, and there is no set for 09-12 at all. A `hard` CIFS mount
with `cache=strict` and `retrans=3` does not recover from this on its own; it
stayed wedged ~37 hours.

**The diagnosis was then confirmed by a controlled before/after.** The host was
rebooted at ~16:23 UTC (not by this investigation). Host iowait fell from
**108–200 % to 10.7 %**, back into the pre-09-11 band of 14–28 %. Re-running the
*identical* warm-cache install — same version, same cache, same FUSE path, box
at load 3.9 and the agent back at 74.8 % CPU:

| | during the hang | after the reboot |
| --- | --- | --- |
| `npm` total | 505.3 s | **72.9 s** |
| `reify` | 490.3 s | 72.4 s |
| `reify:unpack` | 368.1 s | **41.6 s** |
| result | 947 MB / 29 704 files | 947 MB / 29 704 files |

**6.9x on the total, 8.8x on unpack**, and 72.9 s sits inside the 09-08/09-09
baseline band of 67–121 s. Nothing in the closure changed between the two runs.
That is the whole regression, measured in both directions.

**Every inherited number was wrong, and all in the same direction — inferred
from a partial signal instead of measured.**

| Inherited | Measured |
| --- | --- |
| staged closure is 1096 MB, `current` was 947 MB, "it GREW ~149 MB" | A fresh 1.2.275 install is **947 MB / 29 704 files**; `current` is **947 MB / 29 704 files**. The dependency sets of `@camstack/server@1.2.274` and `@1.2.275` are **byte-identical** — no package added, removed or changed. Nothing grew. |
| "roughly 2 minutes of `npm install`" | **202.7 s**, and the four before it were 297, 341, 363, 407 s. Worse than reported. |
| node-av 325 MB, `@seydx` 167 MB, "may be carrying prebuilds for every platform" | node-av **176 MB**, `@seydx` **167 MB** containing **only `node-av-linux-x64`**. npm skipped the other seven platforms correctly via `optionalDependencies`. Not a multi-platform problem — the ffmpeg static lib is simply 167 MB in 3 files. |
| "NOT ruled out — CPU: the agent was at 283 %" | 283 % is right and misleading: **100–180 % of it is iowait** and user CPU *fell* across the regression. IO/dirty-page starvation, not CPU contention. |
| "Staging writes NO log line" | It writes **two** — `root package update requested` and `root package update staged` — in the agent's OWN `docker logs`, which is what made the table above possible. What is missing is forwarding to the hub, and any phase narration in between. |
| the `168469ms` on `http fetch GET …/system-1.2.224.tgz` | **Not download time.** That same 4.29 MB tarball downloads in **0.56 s (7.7 MB/s)** from that container. pacote's timer spans the stream *including* cacache tee and tar extraction, so FUSE back-pressure inflates it ~300x. Attributing minutes to "the download" is the single mistake this record exists to prevent. |

**`npm --timing` attributes it in one run.** Staging installs into a fresh empty
`.staging-*` dir every time, so the honest experiment is a hand-run install of
the same version — warm cache, zero downloads — into a scratch dir on that host,
once on the FUSE data root and once on the container overlay:

| phase | A: `/data` (shfs/FUSE) | B: `/tmp` (overlay) |
| --- | --- | --- |
| `npm` total | **505.3 s** | **371.8 s** |
| `reify` | 490.3 s (97 %) | 365.9 s |
| `reify:unpack` | **368.1 s** | **119.4 s** |
| `idealTree` | ~14 s | 161.5 s (load variance) |
| result | 947 MB / 29 704 files | 945 MB / 29 704 files |

Today's real staging was 202.7–556 s; a warm-cache install with **no network at
all** is 505 s. Resolution and download are noise. **The cost is `reify:unpack`
— 29 704 files onto the node's filesystem — and shfs/FUSE multiplies it 3.1x.**
Raw throughput on that host now: shfs 27.8 MB/s vs `/mnt/disk1` 55.9 MB/s
sequential; shfs 2.56 ms per small file. 29 704 files × 2.56 ms ≈ 76 s is the
metadata floor alone.

**And a third of those files have no business on an agent.** The per-node
`reifyNode` timers name them in rank order — `monaco-editor` 267.5 s,
`lucide-react` 208.8 s + 200.8 s (two copies), `node-pty` 183.6 s, `hls.js`
128.5 s, `@xyflow/react` 129.9 s:

| package | MB | files | why it is there |
| --- | --- | --- | --- |
| monaco-editor | 99 | 1 909 | `@camstack/addon-admin-ui` `dependencies` |
| lucide-react (×2) | 88 | 7 276 | `ui-library` (`^0.576`) **and** admin-ui/pipeline/post-analysis (`^0.511`) — the version split forces a nested second copy |
| hls.js | 32 | 166 | `ui-library` + admin-ui `dependencies` |
| @xyflow/react | 5 | 1 388 | admin-ui |
| react-dom, konva, @xterm | 18 | ~380 | admin-ui |

`@camstack/server` depends unconditionally on all eight addon packages,
`addon-admin-ui` among them, so an agent that will never serve the admin UI
installs its entire browser toolchain. And it is dead weight even on the hub:
`addon-admin-ui` publishes `files: ["dist"]` — a 7.1 MB self-contained vite
bundle with monaco inlined into `dist/assets/Build-*.js`, and the only
`monaco-editor` reference in its source is an erased `import type`.
`ui-library` likewise ships `dist/hls-*.cjs` and `dist/icons/`: it **bundles**
hls.js and lucide-react and externalises only `react`. Roughly **240 MB and
~11 000 files — 37 % of the closure's file count — is a build-time toolchain
declared as a runtime dependency.** (`@types/qrcode` is in the same list, which
is simply a mistake.)

The moleculer hypothesis is **refuted**, on four grounds and not on politeness.
The dirty-page step is 2026-09-11 **04h–05h UTC**; the D457 change landed
2026-09-11 16:30 local = **14:30 UTC**, and the release carrying it published
at 16:40 — eleven hours *after* the cause. The mechanism has no contact surface:
`npm install` is a child process and the moleculer TCP parser is not in its
path. The closure's dependency set did not change across the window. And per
[D478](adr-0478-a-patch-reaches-production-only-if-it-is-bundled-or-applied-in-the-closure.md)
that patch never reached production at all, so its arrival changed nothing on
this node. The operator's *date* was correct; they attributed it to the visible
software change of that day rather than the invisible backup failure of that
morning.

## Decision

A published package declares as a runtime **`dependency`** only what its
shipped artefact `require`s at run time. A UI whose `files` is a bundled `dist`
declares its build-time toolchain — bundler, framework, icon set, editor,
player — in `devDependencies`, and a library that inlines a vendor chunk does
not also depend on that vendor. And the cost of a closure install is
established by **`npm --timing`'s phase timers** on the node, never inferred
from the debug log's `http fetch … Nms`: that timer includes cacache and
extraction back-pressure and will attribute a filesystem problem to the network.

## Consequences

- ~240 MB and ~11 000 of 29 704 files leave every node's closure, hub included.
  This is now the **largest remaining lever**, and the healthy-box numbers say
  so more sharply than the degraded ones did: with iowait back at 10.7 %, the
  top three `reifyNode` timers are still `lucide-react` 41.6 s, `lucide-react`
  (second copy) 38.7 s and `monaco-editor` 38.4 s — against a
  `reify:unpack` of 41.6 s and an `npm` total of 72.9 s. The browser toolchain
  dominates a healthy staging almost entirely. It is **independent of the
  regression** and remains true after it was fixed.
- Moving a dependency to `devDependencies` moves the burden onto the build: a
  package that is published without its `dist` having been built will now fail
  at a consumer's `import`, not at install. `files: ["dist"]` plus a build step
  in `prepublishOnly` is the only thing making this safe.
- The lucide-react version split (`^0.576` in ui-library vs `^0.511` in three
  addons) costs a full second 46 MB / 3 638-file copy. Aligning the range is
  worth as much as removing one of them.
- `@camstack/server` depending unconditionally on `addon-admin-ui` and
  `addon-auth` remains: an agent still installs addons it will never run. Making
  the closure role-aware is the architectural version of this rule and is NOT
  done here.
- **Staging still narrates nothing between its two markers.** A 407 s operation
  that refuses concurrent calls with "another operation is in flight (staging)"
  and reports no phase is indistinguishable from a hang, and the agent's markers
  are not forwarded to the hub, so the aggregated log shows only pipeline stats.
  That is a live violation of CLAUDE.md's rule that a branch which accepts work
  and produces nothing must log it. Unfixed, deliberately named.
- The regression itself was **not a code fault and not fixable from this
  repository** — it was resolved by the host reboot that cleared the dirty-page
  budget, and staging is back in its baseline band. **It will recur**: nothing
  prevents the next Appdata Backup from wedging the same `hard` CIFS mount, and
  the only symptom the cluster surfaced was "updates are slow". Mounting
  `//agent-a.local/backups` `soft` (or with a `retrans`/timeout that gives up)
  turns a 37-hour silent brownout into a failed backup, which is the better
  failure. That is an operator change, outside this repository.
- **A node with a pinned dirty-page budget looks like nothing in particular.**
  The cluster reported no fault for 37 hours; the complaint arrived as a
  subjective "updates got slow". `ps -eo stat,pid,wchan:20,args | grep '^D'` and
  a load average that exceeds core count while the disks sit under 20 %
  utilisation are the two cheap tells, and neither is on any dashboard.
- A second latent hang was on that host before the reboot and is unrelated:
  `D 697 usb_sg_wait [usb-storage]`. Not investigated; gone now, may return.
- Staging on shfs still costs **3.1x** the container overlay for the same work
  (measured while degraded; 41.6 s of healthy `reify:unpack` is the new base to
  improve on). Pointing the agent's data root at a direct pool path rather than
  `/mnt/user/appdata/camstack-agent` is a container-template change, not a code
  change, and it is the same family of mistake as the `/mnt/user` SQLite
  corruption (D328). Lower priority now that the toolchain removal above is the
  bigger share of a healthy install.

## Enforcement

Nothing today — review only, which is worth writing down because this rule is
exactly the kind that rots silently: a `dependencies` entry added to a UI
package is invisible to every existing check and only shows up as seconds on a
node nobody is watching. The guard this wants is a `scripts/` check that, for
each workspace package whose `files` is a built `dist`, refuses a
`dependencies` entry that the built artefact never `require`s or `import`s —
run over `dist/` after build, so it measures the shipped bytes rather than the
author's intent. Wire it into `.github/workflows/ci.yml`.

The measurement discipline has no guard and cannot have one; it is why the
Context above records the `168469ms` line and the 0.56 s that contradicted it.
