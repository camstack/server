---
id: D453
title: A decode worker is made cheap to START, and nothing is held warm — the knobs travel on `start`, not in the child's environment
status: proposed
date: 2026-09-11
supersedes: D282
applies-to:
  - packages/addon-pipeline/src/session-decode/decode-worker-child.ts
  - packages/addon-pipeline/src/session-decode/native-lease-knobs.ts
  - packages/addon-pipeline/src/session-decode/native-lease-config.ts
  - packages/addon-pipeline/src/session-decode/fork-decode-worker.ts
  - packages/addon-pipeline/src/session-decode/session-decode-coordinator.ts
  - packages/addon-pipeline/src/pipeline-runner/index.ts
  - scripts/check-decode-worker-child-lean.ts
---

## Context

Two decode-worker children were drawing 319% of the 522% of CPU CamStack took on
this host — 61% of everything — against a router under one core. In one hour:
443 sessions, median 14 s, 277 cold forks.

D282 had already measured why the keep-warm could not be the answer. A
`WarmDetachedDecode` held a detached camera's worker for 15 s hoping the next
motion event would adopt it, but a held worker does not idle: the child's loop
is `for await (... decoder.frames(demuxer.packets(...)))`, driven by the demuxer
and not by the parent's `pull`, and `minIntervalMs` throttles only inside
`FrameSlot.publish` — after the decode. `framesDecoded` advanced in 122 of 122
park windows at full source rate, at 40-80% of a core.

That measurement still holds, structurally and on the live hub (2026-09-11): the
park path sets nothing the decode loop reads, and the loop's only exit is
`stopped`, which a park does not set. 768 `warm detection decode expired` lines
in three hours say how often a window closed having adopted nothing. With a p50
gap of 61 s between two sessions of one camera against a 15 s window, only ~12%
of re-uses were warm and 272 of 440 windows expired empty. **Raising the TTL
scales the waste, not the hit rate** — that proposal was made in this session
and withdrawn.

So the park had to go. But removing it makes every session pay the fork, and
`forkToFrameMs` was p50 635 ms of which only 234 ms was attributed
(`spawnWait 0 · dial 15 · hwContext 1 · demuxerOpen 6 · decoderCreate 2 ·
firstDecode 210`). The IDR wait is not the problem — `dial` is 15 ms, so nothing
on the broker side needed correcting.

The unattributed cost was in the child's own boot. `decode-worker-child.ts` is
its own vite build entry, but the bundler puts any module it SHARES with the
addon's main entry into a common chunk. Two helpers — `native-lease-config.ts`
and `lazy-sharp.ts` — value-imported `@camstack/types` for exactly four symbols
(`NativeLeaseSettingsSchema`, `NativeLeaseAdmissionSchema`,
`DEFAULT_NATIVE_LEASE_SETTINGS`, and rollup's `__toESM` interop helper), and
that dragged the 1.5 MB shared chunk — every capability's Zod schema, the
detection model tables, the whole `@camstack/types` index — into the child.
Measured on the hub, three runs each:

|                                | before        | after       |
| ------------------------------ | ------------- | ----------- |
| `import` of the child entry    | 166-176 ms    | 38-42 ms    |
| heapUsed delta                 | +99 MB        | +7.8 MB     |
| RSS delta                      | +158 MB       | +30 MB      |
| forked child, never decoded    | 202 MB / 0.26 s CPU | 92 MB / 0.07 s CPU |

Only ~21 MB of the 99 survived a forced GC: most of it was garbage produced
while EVALUATING schemas the child never called. Every fork paid it, 277 times
an hour.

The child needed those schemas only because IT resolved the native-lease knobs,
at module load, from `*_SETTING` env vars the parent wrote at fork time. That
design also made a decode worker un-pre-forkable: a child configured at spawn is
a child bound to the configuration it was born with.

## Decision

**A decode-worker fork carries no configuration, and no decode worker is held
across a detach.**

1. The native-lease knobs are resolved in the PARENT (`native-lease-config.ts`,
   which keeps the Zod schemas) once per session, and travel on the `start`
   message as a REQUIRED `WorkerRequest.lease`. The child's half
   (`native-lease-knobs.ts`) is the wire shape, a hand-written guard, and the
   spawn diagnostic — types only. A worker retains nothing until `start` hands
   it a configuration; it never falls back to the shipped defaults, because a
   default nobody decided is worse than an empty store.
2. Nothing reachable from the child entry may VALUE-import a workspace package.
3. `DETECTION_KEEPWARM_MS`, `WarmDetachedDecode` and the park/adopt/drop
   machinery are gone. A soft detach still parks the DETAIL step tree — a config
   slice, no process, no CPU — so a track outliving the session can resolve its
   enrichment steps; the two were entangled behind one flag and only the decode
   half is removed.

**No zygote pool.** It was designed and costed and is NOT being built, and that
is the least comfortable line in this record — the work started as a zygote.

The number that decided it was measured, not estimated. Fork a lean child, send
it nothing, read `/proc/<pid>/statm`: **92 MB RSS, 0.07 s of CPU, then flat**,
and `ready` (process up, bundle evaluated, node-av `dlopen`ed) arrives
**65-77 ms** after the fork. So a pre-forked worker buys ~74 ms of a
`forkToFrameMs` that now measures **p50 346 ms** live — about 21% — and holds
92 MB for as long as it waits.

Concurrency was sampled rather than averaged, because the brief was right that
bursts are what a pool has to cover: 60 samples at 2 s on the hub gave 1-3
concurrent decode workers, mode 2, peak 3. So a pool sized for the peak is three
processes, 276 MB permanently resident on a host already at 18.6 of 32 GB — to
remove a fifth of a cold start that just fell by 42% for free. plugin catalog's
`zygote.py` keeps four because its children are Python interpreters with a much
larger fixed import cost; after this change ours is not that child.

What IS built is everything that makes a pool possible later without touching
the child again: the `start` protocol is neutral (a worker is bound to no
camera until it is handed one), and the child announces itself with
`{kind: 'ready', warm}` once its native preload has settled. If peak
concurrency or fork rate changes, the pool is a parent-side component and
nothing else. The number to beat is 92 MB per idle worker.

## What it did, live

Deployed to all three nodes (hub, agent-a, MacMiniAgent) on 2026-09-11
as `@camstack/addon-pipeline@1.2.219`. `forkToFrameMs` from the hub's docker
log, every node's sessions:

| window                           | n   | p50     | p90      | p99      | mean    |
| -------------------------------- | --- | ------- | -------- | -------- | ------- |
| before, 10:00-11:40              | 529 | 599 ms  | 1286 ms  | 3717 ms  | 800 ms  |
| after, 11:44-12:02               | 187 | **346** | **656**  | **1188** | **421** |
| before, hub only                 | 133 | 458 ms  | 1196 ms  | 3895 ms  | 755 ms  |
| after, hub only                  | 47  | **262** | **894**  | 1008     | **349** |

p50 down 42%, p90 down 49%, mean down 47% — under a HIGHER fork rate, because
every attach now forks (317 sessions/h before, 623/h after: the park used to
absorb some re-attaches, and each of those now produces a first-frame line).
`warm detection decode` lines: 846 in the before window, 0 in the after.
Container CPU sampled six times over the after window: 161-243%, against the
522% that opened this work.

## Consequences

- Every session now forks. That is the intended trade: a fork costs ~74 ms of
  boot and ~0.08 s of CPU, a park cost 40-80% of a core for 15 s.
- `forkDecodeWorker(source, costRegistry)` takes no knobs. A third parameter
  reappearing there means a knob has crept back onto the spawn, and a pre-forked
  worker could never survive it.
- `WorkerRequest.lease` is required, so a worker and a runner from different
  releases cannot talk: the guard rejects a `start` without it. Deploy the addon
  whole — the child and the runner are one bundle, so this is already true.
- The `CAMSTACK_SESSION_NATIVE_LEASE_*` emergency env overrides still work, but
  they are now read in the RUNNER's environment, not the child's.
- `logs`: `session-decode: warm detection decode …` lines no longer exist. A
  detach releases at the detach.

## Enforcement

`scripts/check-decode-worker-child-lean.ts`, wired into
`.github/workflows/ci.yml`: it walks the relative-import graph from the child
entry and fails on any non-type import of a package. Verified by disarming — a
single value import of `@camstack/types` in `native-lease-knobs.ts` makes it
exit 1 and name the line.

Tests: `session-lease-on-start.spec.ts` (the knobs reach the child on `start`,
and are re-read per session), `fork-decode-worker-neutral.spec.ts` (the spawn
carries no configuration and the arity is 2), `worker-protocol.spec.ts` (a
`start` without `lease` is not a `WorkerRequest`),
`detection-decode-soft-detach.spec.ts` (a cooldown detach releases the worker
and keeps the detail park). Each was confirmed to fail with the fix removed.
