---
id: D452
title: A process table's cost is the forking CALLER, not the scan — read /proc instead — and a WAL checkpoint runs on a thread nobody waits on
status: accepted
date: 2026-09-11
supersedes: D449 (its account of why the settings thread's commits were slow named `synchronous` as the cause; that line is corrected below)
applies-to:
  - packages/system/src/process/proc-stat.ts
  - packages/system/src/process/resource-monitor.ts
  - packages/system/src/builtins/native-metrics/proc-process-table.ts
  - packages/system/src/builtins/native-metrics/gpu-probe.ts
  - packages/system/src/builtins/native-metrics/native-metrics.addon.ts
  - packages/system/src/kernel/moleculer/process-service.ts
  - packages/system/src/builtins/sqlite-storage/wal-checkpoint-policy.ts
  - packages/system/src/builtins/sqlite-storage/wal-checkpointer.ts
  - packages/system/src/builtins/sqlite-storage/wal-checkpoint-worker.ts
  - packages/system/src/builtins/sqlite-storage/sqlite-pragmas.ts
last-verified: 2026-09-29
---

## Context

Two costs handed to this session, both paid by threads that do the least to
deserve it.

**`native-metrics` forked 26 times a minute, synchronously, from the largest
process on the host.** A 60 s CPU profile of hub-main at 5.8 GB RSS put the
`ps -eo` scan (every `samplingIntervalMs`), the `ps -p` calls `getPidStats`
issues for the runner census, and a `nvidia-smi` probe every 5 s (on a host
with an Intel i915 and no NVIDIA driver, so every one of those failed at
`exec` and returned `null`) at 8.5% of the main thread, p50 91 ms per fork,
max 200 ms: about 2.6 s of event loop per minute spent copying page tables
for a child that runs in 3-4 ms. `child_process.execFile` is `fork()` of the
CALLING process, not the target; the calling process was hub-main, and
`fork()`'s cost scales with the PARENT's address space, not the child's
work. Measured on the agent node, the identical `ps` spawn cost 1.4 ms from
a 45 MB process and 74 ms from a 1 GB one - the same syscalls, a 50x
difference, and the only variable is who is calling.

`ps` itself reads the kernel's per-process status files and formats what it
finds. There is nothing in that work a fork was required for: reading those
files from the caller's own process, through `fs/promises` (so the reads
land on the libuv thread pool and the main thread pays only the parse),
produces the identical rows without ever duplicating hub-main's address
space. Measured in the hub container (70 processes): 2-4 ms wall for the
whole-table read, against 3-4 ms for `ps` itself once it is running - the
entire difference is the fork that used to precede it, gone.

**A one-row `set` held the settings thread for up to 11.7 s, and D449 had
already ruled out the schema.** What D449 left open was which of two
remaining levers to pull: `synchronous = NORMAL`, or moving the checkpoint
off the write path. The first turned out to already be true and not a lever
at all - `better-sqlite3` compiles with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`
(`node_modules/better-sqlite3/deps/defines.gypi`), so a WAL database on this
build has been at `synchronous=NORMAL` since 2026-08-08, before this session
started. **This corrects D449's own account**, which named "`synchronous`
never set, so the default FULL fsyncs the WAL on every commit" among the
causes of the slow `set`s: querying the pragma immediately after `journal_mode
= WAL` does read FULL (2), because the WAL default is only applied at the
first write — read a fraction of a second too early, on a fresh connection,
and FULL is exactly what you see. `initialize()`'s own seed writes happen
before anything else can observe the value, so production has been at NORMAL
on every boot; `sqlite-pragmas.ts` already recorded this (dated 2026-08-08,
before D449) and a characterization test already read it back from the live
pragma (`1`, i.e. NORMAL) rather than trusting the claim. Writing the pragma
explicitly would have been a no-op that reads, forever after, like a
durability decision somebody made - exactly the leftover this repository's
own history warns against.

So the fsyncs a slow `set` pays are not durability at all - under WAL plus
NORMAL, an ordinary commit is an append with no fsync - they are the
CHECKPOINT's, and SQLite runs its auto-checkpoint (1000 pages, the engine
default) **inside the commit of whichever writer crosses the threshold**.
A 10 Hz syscall sample against the wal-index header (read at 1 Hz, no
lock), 2026-09-11 10:45-10:55 CEST: the WAL refilled at ~54 frames/s, the
auto-checkpoint fired every 12-25 s (42 times in 9.5 min), and every
uninterruptible-I/O sample on the settings thread sat in an fsync syscall -
74 of them, each within +/-2 s of a checkpoint boundary, 12.6 s of a 569 s
window, all of it inside a writer's commit. In the morning's two saturated
bursts the same fsync took 1-10 s once per checkpoint - the exact shape the
profiler had been filing as a slow `set`.

## Decision

1. **A process table is read from `/proc` on Linux, with no fork.**
   `process/proc-stat.ts` parses the per-process stat and status files
   (cutting at the LAST closing paren of the command field so a name
   containing spaces or parens does not desync the positional fields after
   it), plus the boot-uptime file for the elapsed-time base - reproducing
   `ps`'s own semantics: the CPU column is the LIFETIME average, the
   elapsed-time column is seconds since start, the memory column is
   resident set size. The process-tree snapshot (native-metrics) and the
   per-pid stats reader (`resource-monitor.ts`'s `getPidStats`, shared by
   the addon-registry runner census and
   `kernel/moleculer/process-service.ts`'s `$process.list`) both read from
   it through injectable deps, pinned by a test rather than by the CI
   host's platform. `ps` remains the source only where the kernel's
   per-process filesystem does not exist - a developer Mac - and a pid that
   vanishes between the listing and its reads is omitted whole, never as a
   partial row with a command and no memory.
2. **`nvidia-smi` is only ever spawned once its binary is confirmed on
   `PATH`.** `gpu-probe.ts`'s path search asks an executable-access check
   on the libuv pool - a handful of stats every 5 s, not forked, not
   latched (a latch is a second fact about the host that goes stale,
   D224's shape). A host with no NVIDIA driver now forks nothing for the
   GPU probe instead of forking and failing twelve times a minute.
3. **The WAL checkpoint runs on a worker thread, over its own tiny
   connection, at the SAME 1000-frame rule the engine's own auto-checkpoint
   already uses.** The point is not to checkpoint less often - a worker
   that checkpointed on a shorter interval would multiply the fsync count
   on a drive the media plane already saturates - the point is to change
   WHO waits on the disk. `wal-checkpoint-policy.ts` reproduces the
   threshold as a pure decision over the wal-index header read as raw
   bytes (no lock); the worker polls it every second and issues a PASSIVE
   checkpoint - never FULL/RESTART/TRUNCATE, so it takes no writer lock and
   blocks nobody - over a connection sized to do nothing but checkpoint
   (2 MiB cache, no mmap). The settings connection's own auto-checkpoint
   threshold is raised tenfold
   (`SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES = 10 000`) as a BOUND, not a
   target: it only fires if the worker is gone, and a dead worker is
   reported once at ERROR naming that bound as the only checkpoint left -
   no respawn (D6), because a thread that dies twice needs a person, not a
   loop.
4. **`synchronous` stays unset, on purpose, and the reason is asserted, not
   assumed.** `sqlite-pragmas.ts` keeps `SQLITE_SYNCHRONOUS_IS_BUILD_DEFAULT`
   and a characterization test that reads the live pragma back as `1`
   (NORMAL). A dependency bump that changes the compiled default turns that
   test red; nothing here re-derives the claim from documentation.

## Consequences

- Every number above was measured OUTSIDE the running closure - because
  none of this ships with `camstack deploy`. The process-reading modules,
  the GPU probe and the sqlite-storage changes are all `@camstack/system`;
  the moleculer process-service fix is in the same package. All ride the
  next published `@camstack/server` (D16). Until then hub-main keeps
  forking `ps` and `nvidia-smi`, and the settings thread keeps paying the
  in-commit checkpoint - this record names both costs so the next session
  does not re-measure them from zero, and the figures above are the
  BEFORE; the AFTER is only obtainable once a build carrying this record
  is deployed and re-measured the same way (`query-profiler`'s WARN line
  for `op=set`, and a repeat of the syscall sample against hub-main's CPU
  profile).
- `vite.config.ts` gains a second top-level worker entry, built and
  resolved the same way the addon-runner entry already is, through the
  package's own `exports["./package.json"]` - so the path is identical
  from the workspace and from an installed closure.
- The worker holds its own file descriptor on the database file. Shutdown
  order matters: the addon stops the checkpointer BEFORE closing the
  backend's own connection, so a checkpoint cannot land on a file
  mid-close.
- A quiet database (a developer machine, an agent with little to persist)
  still gets its WAL folded within the max-interval bound (60 s) even when
  it never crosses the frame threshold.
- The process-table and pid-stats readers are shared by every caller
  (native-metrics, the addon registry's runner census, and the moleculer
  process service) through one module each, rather than each caller
  keeping its own `ps` invocation - there is now exactly one place that
  decides the source per platform.

## Enforcement

- `packages/system/src/process/__tests__/proc-stat.spec.ts`: the stat-file
  parse (a command with spaces/parens, a truncated line is `null` not a
  throw), the lifetime-CPU and elapsed-time derivations against `ps`'s own
  semantics.
- `packages/system/src/process/__tests__/resource-monitor.spec.ts`: reads
  from the kernel filesystem and never forks on Linux - disarmed by
  removing the platform branch, red immediately (the fork path is called).
- `packages/system/src/builtins/native-metrics/__tests__/proc-process-table.spec.ts`:
  the same guard for the whole-table read, plus a pid that vanishes between
  listing and read is omitted, never partial. Disarmed by always forking:
  red.
- `packages/system/src/builtins/native-metrics/__tests__/gpu-probe.spec.ts`:
  the path search never execs when the binary is absent from every `PATH`
  entry.
- `packages/system/src/builtins/sqlite-storage/__tests__/sqlite-pragmas.spec.ts`:
  the synchronous pragma reads back as `1` (NORMAL) from a fresh connection
  with nothing set - disarmed by asserting `2` (FULL): red, proving the
  test reads the live engine and not a constant. The auto-checkpoint
  pragma reads back as the raised bound.
- `packages/system/src/builtins/sqlite-storage/__tests__/wal-checkpoint-policy.spec.ts`:
  the checkpoint decision's threshold/interval/unknown branches, and the
  wal-index parse rejecting a torn read (the two header copies disagree)
  instead of reporting a value mid-write.
- `packages/system/src/builtins/sqlite-storage/__tests__/wal-checkpointer.spec.ts`
  and `wal-checkpointer-over-real-sqlite.spec.ts`: the worker's reports
  drive the parent's stats and slow/summary logging; over the real engine,
  thousands of frames are written and the settings connection's own
  checkpoint finds nothing left pending once the worker has run - disarmed
  by not starting the worker, the same call reports every frame still
  outstanding.

## Amendment 2026-09-29 — the wal-index is not read as bytes any more (D679)

Decision 3 said the worker reads "the wal-index header as raw bytes (no
lock)". It did so with `openSync` / `readSync` / `closeSync` on `-shm` once a
second. That `closeSync` is what made the SIGBUS of D468. On POSIX, closing
any descriptor of a file drops every fcntl lock the process holds on it,
SQLite's DMS lock on `-shm` included. The next process to open the database
then rebuilt the wal-index under the runner.

[D679](adr-0679-a-live-sqlite-file-is-reached-only-through-its-owners-connection.md)
changes how the worker learns what is pending, not the rule it follows:

- The worker runs `wal_checkpoint(PASSIVE)` and reads `log` / `checkpointed`
  from its answer.
- It derives the append rate from two consecutive answers.
- It schedules the next checkpoint for when 1000 more frames will be pending,
  clamped to [1 s, 8 s].
- A PASSIVE with nothing to fold does no fsync. **The fsync count is no
  longer the auto-checkpoint's**: at the 54 frames/s measured above the
  threshold would fold every ~18.5 s, and the 8 s clamp folds about 2.3× as
  often. The clamp bounds how late a burst is seen before the engine's 10 000
  frame fallback lands on the settings thread; D679 has the sizing and the
  WARN that measures it.

`decideCheckpoint`, `parseWalIndexHeader` and `WAL_CHECKPOINT_MAX_INTERVAL_MS`
are gone. The Enforcement line naming the wal-index parse is superseded by
`wal-checkpoint-policy.spec.ts`'s schedule tests and by
`shm-lock-survives-a-second-open.spec.ts`.
