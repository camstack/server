---
id: D553
title: A test owns its budget and waits for the landing — and the disk is bounded, because a hang is not an exception
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/system/src/builtins/camera-grid/grid-last-frame-store.ts
  - packages/system/src/kernel/__tests__/moleculer/tcp.cluster.spec.ts
  - packages/system/src/kernel/moleculer/__tests__/moleculer-tcp-parser.spec.ts
  - packages/addon-pipeline/src/recorder/addon/__tests__/settle.ts
  - packages/addon-pipeline/src/recorder/addon/__tests__/spec-root.ts
---

## Context

The second layer of D551's disease, from CI runs 35497173489 and 35501079112 —
still the first runs in weeks to reach the test step. Five failures, green on a
developer Mac, red on the self-hosted Linux runner. Each one was traced to the
end, and only one of the five turned out to be about the runner at all.

**1. `Buffer.poolSize` is not a constant.**
`moleculer-tcp-parser.spec.ts` asserted `pending.buffer.byteLength <
65_536` — the size of Node's Buffer pool, where a copied 3-byte remainder
lands. Node **v24.19.0 raised that pool from 8 KiB to 64 KiB**; the runner is
on v24.19.0 and this Mac was on v24.17.0. Verified by downloading v24.19.0 and
running the spec: `expected 65536 to be less than 65536`, the runner's error,
byte for byte. The parser patch is correct on both — the assertion spelled a
number that belongs to the platform.

**2 & 3. The TCP cluster spec had never been green anywhere.**
It was gated `describe.skipIf(!process.env.CI)` behind a comment blaming macOS
UDP multicast. The gate's premise is false: the agent is handed an explicit
`hubAddress`, which disables UDP discovery on the path being measured. Run
here with `CI=1` both tests **pass, in 7.3 s and 6.2 s** — and
`packages/system` has no vitest `test` block, so `testTimeout` is the default
**5 000 ms**. The spec's own internal budget said as much out loud
(`waitForServices(..., 10000)`, calls at `timeout: 8000`): it asked for twice
what the harness allowed. Restoring the 5 s budget reproduces the runner's
`Test timed out in 5000ms` on this Mac. It timed out on CI, and the env gate
skipped it on the one machine where someone would have noticed.

**4. A hang is not an exception — and that one IS a product defect.**
`grid-last-frame-store.spec.ts` asserted that a store "never throws on a
directory it cannot write" by pointing it at `/proc/definitely-not-writable`.
On macOS there is no `/proc` and `mkdir` answers ENOENT, so the test passed for
a reason unrelated to its claim. On Linux as root — measured in a bounded
container on `ci-runner` itself — `fs.mkdir(path, { recursive: true })` under
a parent that exists but cannot hold a directory **never settles**: procfs
answers ENOENT, and Node's recursive mkdir walks to the existing parent and
retries the child forever. `GridLastFrameFileStore.put` wrapped that in
`try/catch` and documented "NOTHING here throws", which is true and beside the
point; `GridSnapshotSource.keep` **awaits** it on the snapshot answer path, so
a grid's snapshot RPC never answered at all. The spec's 5 s timeout was the
first thing in two years to notice.

**5. A counted drain is a bet on the machine's disk.**
The recorder specs drained the event loop by hand under fake timers —
`for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)` — and then
asserted. `RecordingController` does real filesystem work in between (an attach
`mkdir`s the staging dir, a detach reads the watcher's playlist), so the count
is a guess about libuv. The runner lost that bet in two consecutive runs, on
two different specs, and **four more tests in the same directory had already
been commented out on 2026-09-14** as "flaky under host load". Their notes
name the mechanism correctly and then delete the test.

## Decision

Four rules, one disease.

- **A test never gates on the environment.** No `skipIf(process.env.CI)` in
  either direction. A test that runs in one place is a test nobody reads, and
  its "green" is an absence of evidence.
- **A test owns its budget.** Where a test's internal waits exceed the
  harness default, the budget is ONE named constant in the file, used as the
  test's timeout AND as the ceiling of every wait inside it. A harness that
  allows less than the test asks for is a contradiction, not a flake.
- **Wait for the work to LAND, under a bound — never for a number of turns**
  (D58's rule, applied to specs). `settleUntil(landed, what)` spins until the
  effect is observable and fails naming what never happened. A fixed drain is
  legal only before an assertion of ABSENCE, which no extra waiting can make
  true, and `settleTurns` is that case and says so.
- **An ambient value is NAMED, not spelled**, and a scratch directory is per
  RUN (`specRoot`), never a fixed path under `/tmp` — D551's rule, which the
  recorder's eight spec roots had escaped. Inspected on `ci-runner`:
  `/tmp/rec-controller-spec` and siblings dated **2026-08-20**, a month of
  accumulated staging directories every recorder test read through.

And the product rule the fourth failure exposed: **a store whose contract is
"persistence is a bonus" must BOUND what it costs the caller.** A refusal and a
hang are the same answer from the caller's side, and only one of them is
catchable, so the deadline lives in the store — with the filesystem injected
(`GridFrameFs`, defaulting to `node:fs/promises`) so the spec can hand it one
that refuses and one that never answers, and with the drop named per camera
(`tags: { deviceId }`).

## Consequences

- `GridLastFrameFileStore` takes a `logger` — it now has a branch that drops
  work, and a branch that drops work is never silent. Its one production
  construction site passes `ctx.logger.child('snapshot')`.
- The TCP cluster tests now RUN on every developer machine, and cost ~13 s.
  That is the price of a test that is green somewhere real.
- Four tests came back from the comments they were buried in. A commented-out
  test that describes the right behaviour is worse than no test: it reads as
  coverage.
- Anything that spells a platform constant (`Buffer.poolSize`, a pool size, a
  page size, a default timeout) is suspect. The next Node release moves one.

## Enforcement

Behavioural, in the specs themselves:

- `moleculer-tcp-parser.spec.ts` asserts the remainder's backing store is not
  the wire buffer's and is within `Buffer.poolSize`. Red against the spelled
  `65_536` under Node v24.19.0 — verified by restoring it.
- `tcp.cluster.spec.ts` carries its own `CLUSTER_BUDGET_MS` and asks the OS for
  its ports. Red against the 5 s default — verified by restoring it.
- `grid-last-frame-store.spec.ts` hands the store a filesystem that never
  settles and requires `put`/`get` to answer anyway. Red against the
  unbounded await, with the runner's exact `Test timed out in 5000ms` —
  verified by removing the deadline.
- `settle.spec.ts` states the property directly: a counted drain of 5 turns
  misses work that needs real threadpool turns, `settleUntil` does not, and it
  is bounded. That spec is machine-independent, which is the point — this Mac
  cannot be made slow enough to reproduce the runner's particular miss, and it
  does not have to be.

Nothing yet catches a NEW `skipIf(process.env.CI)` or a new fixed `/tmp` root.
A `scripts/` guard over `packages/*/src/**/__tests__/**` is the obvious next
step and is not in this change.
