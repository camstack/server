---
id: D668
title: A runner owns a process group, and the kernel reaps that group on every runner exit before anything respawns it
status: accepted
date: 2026-09-28
supersedes:
applies-to:
  - packages/system/src/kernel/moleculer/process-service.ts
  - packages/system/src/kernel/moleculer/runner-process-group.ts
  - packages/system/src/kernel/moleculer/addon-runner.ts
  - server/backend/src/launcher.ts
  - server/backend/src/main.ts
  - scripts/check-no-detached-child-spawn.ts
---

## Context

At 10:21 CEST on 2026-09-28 the hub's recorder runner died of SIGABRT (V8 out of
memory). It ran no JavaScript on the way out: no `SIGTERM` handler, no
`addon.shutdown()`, so `SegmentWriter.stop()` — the only thing that ever killed a
recorder ffmpeg — never ran. The 28 ffmpeg writers it had spawned survived as
orphans. ffmpeg ignores SIGPIPE and does not quit on stdin EOF, so a dead reader
does not stop it; tini, PID 1 in the container, reaps zombies and kills nothing.

The D6 supervisor respawned the runner, and the new runner started 28 writers into
the SAME staging directories. For 13 minutes every camera on the hub had two
ffmpegs rewriting one `live.m3u8` and colliding on epoch-named segments; the new
watchers saw their entries rolled away (1,512 `rolled past … processed=0`), the
liveness check declared the writers dead and respawned them 169 times, and the
orphans kept writing throughout. It ended when they were killed by hand.

Nothing was specific to the recorder. llama-server (GBs of model RAM, a new one
on another port), tailscaled and cloudflared (holding a state dir and a socket),
stream-broker ffmpeg and HAP ffmpeg all had the same shape: a long-lived child
killed only on the graceful path. The hazard had been written down since
2026-08-01 in `recording-controller.ts` and mitigated only by bounding a teardown
RPC.

The structural cause was one spawn option. Runners were spawned `detached: false`,
i.e. inside hub-main's own process group, so there was no handle that meant "this
runner and everything under it". A parent-death watchdog already protects the
runner from hub-main dying; nothing protected the runner's children from the
runner dying.

Rejected:

- **Make each child die with its parent** (`-nostdin`, stdin EOF, a pipe). ffmpeg
  does not exit on either. The only per-child mechanism is Linux
  `PR_SET_PDEATHSIG` (`setpriv --pdeathsig`), which has no macOS equivalent (the
  Mac agent runs the recorder) and would have to be repeated in every addon that
  spawns anything.
- **A pidfile per child.** A crash leaves it stale, so it needs argv verification
  against pid reuse, and a missing file hides a live child. Per-addon, again.
- **Kill orphans by name at boot** (what `cleanupOrphanProcesses` does for one
  Python script in `server/backend/src/main.ts`). It only runs at hub boot, not at
  a runner respawn, and a name match cannot tell a predecessor's ffmpeg from another
  node's or another runner's.

## Decision

On POSIX every addon-runner is spawned `detached: true`, which makes it a session
and process-group leader (pgid = runner pid); every child it spawns inherits that
group. On **every** runner exit — crash, signal, clean exit, operator stop,
restart, breaker trip — `$process` reaps the group: `kill(-pgid, SIGTERM)`, up to
`RUNNER_GROUP_REAP_GRACE_MS` (2 s) for it to empty, then `kill(-pgid, SIGKILL)`
for what remains. ESRCH is the normal outcome (the runner stopped its own children)
and is not an error. Every spawn under a runner id — the crash respawn, `restart`,
`restartAll`, a `spawnRunner` call — waits for the predecessor's reap first, so a
new runner never co-exists with its predecessor's children.

The two cases where `$process` cannot perform that asynchronous reap have their
own synchronous backstops:

- When hub-main or an agent reaches its process `exit` event, it `SIGKILL`s every
  group still registered. An exit hook has no future turn in which to escalate,
  so sending only SIGTERM there is not a reap: a TERM-deaf grandchild can outlive
  both its runner and the exiting parent.
- If the parent itself is lost to SIGKILL or a native crash, the runner's
  parent-death watchdog detects the PPID change and `SIGKILL`s its own negative
  pgid. The watchdog is armed before addon modules load, so parent loss during a
  hung import or `initialize()` has the same bound as parent loss after READY.

Once a role runtime has installed its own SIGTERM/SIGINT handlers, the launcher
removes its bootstrap-only handlers instead of calling `process.exit()` first.
That lets hub-main or the agent stop its broker and runners normally. hub-main's
handler also signals every runner group next to its own, giving the ordinary
graceful path its first TERM before the final backstop. The `$process` service's
`stopped()` hook awaits each runner exit and group reap, so `broker.stop()` cannot
return to the agent's final `process.exit()` while children are still alive.

No code under `packages/*/src` or `server/*/src` may start a child in a new group
(`detached: true`, `setsid`): such a child escapes the reap.

## Consequences

- `detached` also starts a new SESSION. The runner has no controlling terminal and
  is no longer in hub-main's group: a terminal Ctrl+C and hub-main's own
  `kill -- -<pid>` no longer reach runners by themselves. That is why
  `signalAllRunnerGroups` exists and why hub-main's signal handler calls it — drop
  that call and a hub stop leaves runners to their 5 s parent-death watchdog.
- The child is still ref'd (never `unref()`), its `exit` still fires, its pipes are
  still read, and `process.ppid` is unchanged. The desktop shell still stops the
  node by pid; if that node exits normally its exit backstop kills any remaining
  runner groups, and if the node is SIGKILLed each runner detects reparenting and
  kills its own group.
- A second SIGTERM can now reach a runner (its group, and `$process`'s own), so
  the runner's `shutdown()` is idempotent.
- A respawn can be delayed by up to the reap grace plus one table read. The D6
  backoff runs concurrently, so the first respawn (500 ms backoff) comes up to ~2 s
  later when a child ignores SIGTERM, and no later when the group is already empty.
- A reap that found members logs `runner group reaped {pgid, members, sigkilled}`
  with the executables by name; one that had to SIGKILL, or could not signal,
  logs at warn. The kernel knows the runner id and not which device a child
  served — per-device attribution is the addon's (the recorder's own
  foreign-writer reap, D667).
- A process group outlives its leader, so `kill(-pgid)` still reaches the orphans
  after the runner is gone — that is the whole mechanism. POSIX does not reuse a
  pid while a group with that id exists, so the SIGTERM always lands on our group.
- A descendant that calls `setsid`/`setpgid` itself leaves the group and is not
  reaped. No shipped addon does; the guard below keeps it that way for our own
  spawns, but a third-party binary that daemonises itself is out of reach.
- **Windows is not a target.** There are no process groups in this sense; the
  runner is spawned exactly as before and nothing is reaped.
- This is a framework change: it runs only once a `@camstack/server` whose closure
  carries this `@camstack/system` is installed on a node, hub and agents alike.

## Enforcement

- `packages/system/src/kernel/__tests__/moleculer/process-service-group-reap.spec.ts`:
  the spawn option, the negative-pgid SIGTERM→SIGKILL on a SIGABRT exit, the crash
  respawn and the operator restart both waiting for the reap, and a real process
  tree (a SIGKILLed fixture's two grandchildren, one ignoring SIGTERM, gone within
  2 s). It also covers broker shutdown waiting for its reap, a normal parent exit
  through the process `exit` backstop, and a SIGKILLed parent through the runner's
  early PPID watchdog; both real parent-loss cases remove a runner plus polite and
  TERM-deaf grandchildren within 2 s.
- `scripts/check-no-detached-child-spawn.ts` (CI): no `detached: true` and no
  `setsid` exec in tracked source under `packages/*/src` or `server/*/src`.
- hub-main's direct signal wiring remains review-covered; the process `exit`
  backstop itself is exercised by the real parent-loss fixture.
