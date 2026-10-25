---
id: D666
title: A decode worker exits when its parent or its stdio is lost, and the runner kills its workers on shutdown
status: accepted
date: 2026-09-28
supersedes:
applies-to:
  - packages/addon-pipeline/src/session-decode/bounded-exit.ts
  - packages/addon-pipeline/src/session-decode/decode-worker-process.ts
  - packages/addon-pipeline/src/session-decode/decode-worker-main.ts
  - packages/addon-pipeline/src/session-decode/live-decode-workers.ts
  - packages/addon-pipeline/src/session-decode/fork-decode-worker.ts
  - packages/addon-pipeline/src/session-decode/session-decode-pump.ts
covers:
  - packages/addon-pipeline/src/session-decode/session-decode-coordinator.ts
  - packages/addon-pipeline/src/session-decode/decode-worker-child.ts
  - packages/addon-pipeline/src/pipeline-runner/index.ts
---

## Context

Amends [D652](./adr-0652-the-runner-never-destroys-a-frame-it-admitted.md).

On 2026-09-28 the native macOS agent had **17 orphaned decode workers**, all
with PPID 1. Together they held **3.7 GB RSS** and **641 % CPU**. Each one
still held its RTSP connection to the hub restream and kept pulling it. SIGTERM
did not end them; only `kill -9` did. The oldest was about 21 h old, and D652
had landed about 24 h earlier.

Two faults had to coincide for a worker to leak.

**The runner did not kill its workers before it exited.** A TERM to the agent
server makes the launcher call `process.exit(0)` at once. The addon runners are
then orphaned, their ppid watchdog runs `shutdown()`, and that ends in
`process.exit(0)`. The pipeline's `onShutdown` did call
`detectionUnsubscribe('immediate')`, but on a first call the pump only ran
`void iterator.return()`. The coordinator's generator is parked in
`await session.pullNext()`, not at a `yield`, and an async generator queues
`return()` behind the pending step. Its `finally` was the only thing that sent
`stop` and SIGKILL, and it ran only after the next frame, which came after the
runner had already exited. Occupancy re-check bursts keep their teardown in a
local variable, so `onShutdown` never reached them at all.

**The orphaned worker's exit could not run.** D652 made the exit asynchronous
and bounded by a timer (`whenIdle(250 ms)`). A worker that sees `disconnect`
begins that exit, and the exit writes a metrics line to the inherited stderr.
That stderr's reader was the dead server, so the write failed with EPIPE.
`process.stderr` had no `'error'` listener, so the EPIPE became an
`uncaughtException`. The handler reported the exception by writing to stderr,
which raised a new EPIPE, and the cycle repeated. The whole cycle ran inside
Node's check phase (`CheckImmediate → TriggerUncaughtException →
FormatStackTrace` in `sample`), so the loop never reached the timer or the
signal handle. The 250 ms exit never fired, and SIGTERM was never serviced.
Before D652, `disconnect` and `uncaughtException` both called `process.exit`
synchronously. The D652 tests missed this because they drove the exit with
**fake timers**, and a fake clock always reaches its timers.

The operator's two repros separate the faults:

- **Test A, `kill -9` of a runner: no leak.** The worker gets `disconnect`, but
  the server is alive and still reading the inherited stderr. No EPIPE is
  raised, and the worker exits within 250 ms.
- **Test B, TERM to the server: leak.** The server dies first. The runner's
  graceful exit kills no worker, and each worker's exit turns into the EPIPE
  loop. After about 8 s the workers are at 100 % CPU and ignore SIGTERM.

Docker hid the same code path. There, a server exit ends tini and the kernel
kills the whole PID namespace. The container boundary prevented the leak, not
the code.

## Decision

**A decode worker does not outlive its runner process, whichever way that
process ends through `process.exit`. A worker whose parent is gone exits in the
same turn.** It has two sides.

1. **The runner kills every worker it forked** (`live-decode-workers.ts`,
   `RunnerDecodeWorkers`, wired in the pipeline runner):
   - Every fork, at every spawn site (live sessions and occupancy bursts), goes
     through `RunnerDecodeWorkers.fork`. The worker sits in a per-runner
     `LiveDecodeWorkers` set from that fork to its real exit.
   - **The first statement of `onShutdown`** SIGKILLs everything in the set,
     synchronously, before anything in the method can throw. It logs one line
     per worker, `session-decode: worker killed at shutdown`, with
     `tags: { deviceId }`. After that the set is **closed**: a fork that lands
     later (a burst parked on a spawn slot while the runner awaits the other
     addons) is killed as it is registered, and says so.
   - **Every `process.exit` kills what is left.** A `process.once('exit')`
     hook is armed at the first fork and dropped by the shutdown kill. It covers
     the addon runner's uncaught-exception `exit(1)`, which never reaches
     `onShutdown`, and a shutdown that threw before this addon's turn. `'exit'`
     listeners run synchronously inside `process.exit`, and `kill(2)` is
     synchronous. The log line is attempted, but the transport is going down
     with the process.
   - Every kill pass signals ALL workers before it writes ANY line, and each
     line is written in its own swallowing try: the exit hook runs while the
     transport goes down, and a logger that throws must not stop a kill. A
     worker whose kill threw stays tracked for the next pass.
   - A worker the runner killed is not warned about a second time as an
     unexpected death: its exit carries `killedByRunner`, and the coordinator
     logs it at debug.
   - `'immediate'` on the pump means immediate: it escalates the session to
     SIGKILL in the same turn, before `iterator.return()`. The generator's later
     `finally` finds the kill already sent and sends no second one. It retries
     only if the first kill threw.
   - **Not covered:** a runner killed by a signal it does not handle (SIGKILL,
     an OOM kill) runs no JS at all. There, the worker's own parent-loss exit
     (point 2) is the only protection.
2. **The worker's exit never waits on a timer once its parent is gone**
   (`bounded-exit.ts`, wired in `decode-worker-process.ts`):
   - **Stdio loss is never an uncaught exception.** `'error'` listeners on
     stdout and stderr route it to `stdioLost`, and raw stderr writes stop
     (`markStderrLost`).
     - **With the IPC channel up, the worker keeps running.** Raw stderr is the
       secondary log path: the IPC copy is what reaches the runner's logger. So
       the worker sends one `warn` line over IPC, `decode-worker-child: stdio
       lost (<code>) — raw stderr off, IPC logging continues`, and carries on.
       Exiting would only make the runner re-dial into the same dead stderr.
     - With the channel down too, it exits now.
   - **Every fault is reported, rate-limited, and a report never loops.** At
     most `FAULT_REPORT_LIMIT` (5) reports go out per `FAULT_REPORT_WINDOW_MS`
     (60 s); the rest are counted and reported as one line at exit. A report
     carries the first stack frames, and a report that throws is swallowed where
     it happens. The first uncaught error exits 1 with a flush; every later one
     exits at once. An unhandled rejection does not end the worker.
   - **Parent loss exits in the same turn.** `disconnect`, and a ppid that no
     longer matches the one at start (`watchParentPid`: every second, on an
     unref'd timer), exit without waiting for queued lines. A flush already
     waiting on its bound is cut short by a later parent-lost request.
   - The bounded flush stays only where the parent is alive, for `stop`, the
     first SIGTERM and the first uncaught error. A second SIGTERM exits at once.

When the parent is gone there is no sink for the exit reason: stderr's reader
died with it, and the channel is closed. The exit is not logged, and the code
must not try, because trying is what caused the loop.

## Consequences

- A runner's shutdown SIGKILLs workers that may still hold frames. That was
  already the meaning of `'immediate'` in D652; now the kill actually happens.
  Each kill is one INFO line per camera.
- A worker whose parent is gone no longer gets 250 ms to flush lines that have
  no reader. Nothing is lost that could have been delivered.
- A worker whose raw stderr died but whose parent is alive keeps decoding and
  logs over IPC only. Anything that reads the runner's raw stderr (the docker
  log pipe) no longer sees that worker's lines. The scoped logger still does.
- Fault reports past 5 a minute are counted rather than written.
- The worker's process wiring is `wireDecodeWorkerProcess`, so a test fixture
  runs exactly the production wiring. `decode-worker-main.ts` keeps only what
  needs native modules or the sharp loader.

## Known scope

- **`process.exit` can itself hang** if a libuv threadpool thread is stuck in a
  native read (`uv__threadpool_cleanup → pthread_join`). An example is node-av
  on an RTSP socket that stays open but goes silent, because
  `buildDemuxerOptions` sets no socket timeout. None of the 17 orphans was in
  that state (all were spinning, not sleeping). Exiting with a self-SIGKILL on
  the parent-lost path, and adding an RTSP socket timeout, change decode
  behaviour and are left for a separate change.
- **Other long-lived children** (the ffmpeg recorder `SegmentWriter`,
  pull-mode ffmpeg sessions, the llama supervisor) do not read stdin and were
  not checked for the same orphaning. None of them runs a Node uncaught
  handler that writes to inherited stdio, so the loop above cannot occur in
  them, but they may still outlive their parent.

## Enforcement

Every test below was disarmed by hand and seen red (the red lines are in the
implementation report of 2026-09-28, round 1 included):

- `decode-worker-shutdown-kill.spec.ts`: a real process tree, driven through
  the real `RunnerDecodeWorkers` and `forkDecodeWorkerAt` with the real
  `process` as the exit hook. A runner fixture forks a worker that never exits
  on its own.
  - After a graceful exit (shutdown kill, then `exit(0)`), the worker is gone
    within 2 s.
  - After a crash (uncaught error, then `exit(1)`, as in `addon-runner.ts`;
    no shutdown), the worker is gone within 2 s.
  - Units in the same file: one kill line per camera, a failed kill named, a
    throwing logger stopping no kill and losing no worker, a failed kill
    retried by the next pass, a worker added after close is killed, the exit
    hook kills, and shutdown drops it.
- `pipeline-runner/__tests__/decode-worker-shutdown-wiring.spec.ts` pins the
  **addon's own** wiring. A fork through `forkDecodeWorkerWithLease` is
  registered with the set, `addon.shutdown()` SIGKILLs it, and a fork after
  shutdown is killed at once. It goes red when either the `onShutdown` kill or
  the registration is removed. Before round 1 of review, removing both left the
  whole package green.
- `session-decode-pump.spec.ts`:
  - `'immediate'` with a pull pending SIGKILLs in the same turn, once.
  - A SIGKILL that threw is retried.
  - A worker the runner killed is not warned about; a worker that died on its
    own still is.
- `fork-decode-worker-exit.spec.ts`: the exit carries `killedByRunner` only
  when the runner killed the worker.
- `worker-exit-parent-loss.spec.ts`, with real timers: the `stdioLost` routing
  (channel down: exit now; channel up: keep running, exit on a later
  disconnect), the rate limit and suppressed count, a throwing report
  swallowed, the same-turn exit, a flush cut short, `disconnect` and a ppid
  change exiting now, the second SIGTERM, and `watchParentPid` firing on a
  changed ppid.
- `decode-worker-parent-loss.spec.ts`: a real worker process on the real
  wiring.
  - Stdio destroyed, then the channel closed: it exits 0 within 3 s.
  - Stdio destroyed, channel up: it stays alive, sends exactly one `stdio lost`
    line, keeps logging over IPC at its own pace, attempts no further raw
    stderr write, and exits 0 once the channel closes.
  - A lost channel alone, and SIGTERM, both end it.

Live check after deploy, on the Mac:
`ps -axo pid,ppid,etime,%cpu,command | grep '[d]ecode-worker-main'` should
show no PPID 1 rows after the next server restart. Orphans from before the
deploy ignore SIGTERM and need a one-time `kill -9`.
