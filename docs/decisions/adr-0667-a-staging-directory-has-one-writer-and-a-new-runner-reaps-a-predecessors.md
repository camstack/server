---
id: D667
title: A staging directory has one writer — a new runner reaps a predecessor's, and refuses rather than co-writes
status: accepted
date: 2026-09-28
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/addon/staging-writer-guard.ts
  - packages/addon-pipeline/src/recorder/addon/staging-writer-match.ts
  - packages/addon-pipeline/src/recorder/addon/staging-boot.ts
  - packages/addon-pipeline/src/recorder/addon/process-table.ts
covers:
  - packages/addon-pipeline/src/recorder/addon/index.ts
  - packages/addon-pipeline/src/recorder/addon/recording-controller.ts
  - packages/addon-pipeline/src/recorder/addon/ffmpeg-args.ts
  - packages/addon-pipeline/src/recorder/addon/segment-writer.ts
---

## Context

A recorder writer is one ffmpeg per (camera, profile), writing
`.rec-tmp/<deviceId>/<profile>/`: a rolling `live.m3u8` (`-segment_list`,
15 entries) that the segment watcher tails, and segments named after the
epoch second they start in. Two writers in one directory rewrite each other's
playlist and collide on segment names.

Nothing ties a writer's life to its runner's. Runners are spawned in hub-main's
process group, writers are plain `spawn()` children, and the only kill is
`SegmentWriter.stop()`, which runs on a graceful path only. ffmpeg ignores
SIGPIPE itself and does not quit on stdin EOF, so a dead parent means nothing to
it — reproduced locally: after the parent's SIGABRT, ffmpeg kept writing
(1 → 7 segments in 5 s, PPID 1).

On 2026-09-28 the hub recorder runner died of a V8 OOM (SIGABRT: no JS runs, no
shutdown hook). Its 28 writers survived. The respawned runner spawned 28 new
ones into the SAME directories. For 13 minutes every camera had two writers:
the new watchers never saw their own playlist entries (1 512 "segment playlist
rolled past entries this watcher had not handled … processed=0", 83–130 a
minute), liveness declared every new writer dead (131 re-pins, 104 give-ups),
and the runner spawned writers 169 times while the orphans kept writing. It
went quiet the moment the orphans were killed by hand.

The hazard had been known since 2026-08-01 (a SIGKILL'd teardown "orphans the
ffmpeg writers — they keep double-writing `.rec-tmp`"). It was mitigated by
bounding the teardown RPC so the grace would not be blown, which removes one
way to die ungracefully and does nothing about the others. `writerStartedMs`
filters old playlist entries by time; nothing ever looked at who ELSE was
writing.

## Decision

Before staging recovery or the recording controller starts, the recorder reads
the process table once and finds every ffmpeg whose argv holds
`-segment_list <root>/.rec-tmp/<deviceId>/<profile>/live.m3u8` under any
resolved location. It sends all of them SIGTERM together, waits one bounded
grace, sends the verified survivors SIGKILL together, then waits one second
bounded grace. Each removed process is logged as one WARN with
`tags: { deviceId }`, its pid, ppid, age and profile. The controller starts
only after the sweep attempt; staging deletion/recovery runs only when the tree
was verified quiet. Recovery runs before the cleanup of an unassigned root, so
a reaped writer's tail gets a chance to land rather than being deleted first.
This reaches an event camera with no trigger, a disabled camera, a removed
profile and a moved placement — directories a per-spawn check might never see.

At attach, the same guard sweeps every staging directory of the device in one
table read and shared signal window, then checks the exact directory again
immediately before each spawn. A reaped attach-time writer's staged tail is
recovered before the replacement starts.

A foreign writer that is still there afterwards, a signal denied by the
kernel, or one whose death cannot be confirmed because the table stopped being
readable after it was seen is a REFUSAL: no spawn. The guard never SIGKILLs an
unverified pid. A refused `(directory,pid,start)` is remembered for 60 seconds,
so hot trigger/reconcile paths refuse immediately rather than repeat a
three-second kill window; the ERROR is emitted once per changed state and
repeats are DEBUG. Two writers in one directory is never an acceptable outcome
of a spawn.

## Consequences

- The boot and per-device sweeps coalesce the expensive work. The final claim
  still runs before the broker dial, so a refusal costs no stream session; it
  normally reuses the recent table read. `claimMs` on `recorder: writer
  spawned` measures it.
- The exact directory is what makes an ffmpeg a rival: another node's writers
  are in another pid namespace or on another host, and a writer of a different
  directory is by construction not a rival. Requiring an ffmpeg executable
  prevents a `grep`/`pgrep` command that merely mentions the path from being
  signalled. The path is spelled once (`segmentListPath`), because a spelling
  that drifted between the argv and the matcher would make every predecessor
  invisible.
- A writer this runner is already stopping remains in its owned-pid set until
  its exit event, so a teardown/reattach overlap is not falsely reported as a
  predecessor. On a hot deploy, the incoming runner may still send an outgoing
  runner's writer a second SIGTERM; the outgoing runner's own 500 ms escalation
  normally wins before the incoming guard reaches SIGKILL.
- A table that cannot be read at all is `unverified`, logged on every spawn,
  and the spawn proceeds. Refusing would stop all recording on a host whose
  table is unreadable, a larger loss than the one guarded against. Windows has
  no lister: one WARN at startup, no per-spawn guard, and no boot staging
  mutation. On a platform that does have a lister but whose boot read fails,
  staging deletion/recovery is likewise skipped: the missing read does not
  authorise moving a file an unseen writer may have open.
- If a known writer survives the boot reap, or the table becomes unreadable
  after it was seen, boot staging deletion/recovery is skipped. Moving a file a
  survivor is still appending to is not recovery.
- A writer's own inner
  restart (`SegmentWriter.start()` after a backoff) reuses a directory the same
  runner already cleared; a predecessor cannot appear there later.
- This is the recorder's own guarantee and is still needed if D668 (runner
  process groups, in progress and not yet merged when this record was written)
  lands: that reap covers the next death, not a writer left by an older build
  or one it failed to kill, and a double writer destroys footage where an
  orphaned inference server only wastes RAM.

## Enforcement

Tests, each confirmed red with its line of the fix removed:
`staging-boot.spec.ts` (the boot sweep precedes every staging mutation and
controller start; a known survivor permits controller start but no staging
mutation), `recording-controller-staging-guard.spec.ts` (one device sweep,
recovery before replacement spawn, refusal means no spawn or broker dial, and
tracked pids reach the guard), `staging-writer-guard.spec.ts` (same directory
reaped, other directories and prefixes untouched, tracked writers untouched,
one shared multi-profile window, SIGKILL escalation, EPERM, remembered
refusal, and a mid-reap unreadable table refuses without SIGKILL),
`staging-writer-guard-real-process.spec.ts` (a real process with the argv, on
the platform the suite runs on, is found and reaped, including one that
ignores SIGTERM) and `process-table.spec.ts` (both table readers on every
platform). Nothing stops a future spawn site from bypassing
`claimStagingDirectory`; review only.
