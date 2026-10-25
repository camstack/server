---
id: D624
title: A spec poses what it reads of the REAL process, and a timing control outlasts the scheduler — the CI runner is one throttled core, and a test that reads the machine grades the machine
status: proposed
date: 2026-09-24
supersedes:
applies-to:
  - packages/system/src/kernel/__tests__/heap-watch-sink.spec.ts
  - packages/system/src/builtins/sqlite-storage/__tests__/event-loop-churn.spec.ts
---

## Context

Two `@camstack/system` specs were red on `main` after the batch of 2026-09-23
(D622) had cleared everything else, and neither was flaky in the sense the word
usually carries. Each was reading the machine it ran on and asserting the
result.

**`heap-watch-sink.spec` › "carries every field a runner line carries".** The
test starts two heap watches under fake timers — hub-main at 60 s, a runner at
300 s — and compares the field names of their due lines. Since D469 a line
ends in `procCpu=` and, conditionally, `v8WorkerCpu=`: the per-thread census
reads `/proc/self/task` and prints the worker share only when the window's
thread ticks moved, because a share of zero ticks is no measurement (D393).
Fake timers advance `Date.now()`; they do not advance `/proc`. A 60 s hub
window costs ~0.2 ms of real CPU and a 300 s runner window ~1.5 ms, against
10 ms jiffies (`CLK_TCK=100` on the runner). On macOS `/proc` does not exist,
the reader answers `null`, both lines lack the field, and two absences compare
equal — the test had never once seen `v8WorkerCpu` on a developer machine. On
the runner, a slower core shared with a second vitest worker whose ticks land
in the same `/proc/self`, the runner window crossed a jiffy and the hub window
did not: red at 23:01 and 23:45, green at 21:02 and 21:39, on the same code.
Forcing the same jiffy-to-window ratio on the Mac (a 1 ms jiffy over process
CPU) reproduces the CI diff six runs out of six.

**`event-loop-churn.spec` › "sees a timer as many short pauses".** The control
proves the `setImmediate` probe can see yielding work: a 40 ms timer must show
more than five pings and no pause over 40 % of the window. It failed three of
the four runs that reached it, twice as a 26–31 ms longest pause and once as
four pings in 40 ms. Locally the same window shows ~3 000 pings and a longest
pause under 0.5 ms, and 24 busy-loop processes on 12 cores do not change the
verdict. The runner is different in kind, not degree: each self-hosted runner
container is `--cpus=1` (`cpu.max 100000 100000`) on a 4-core N100 that also
hosts a second runner and the CamStack agent, and its cgroup had been
throttled in **224 526 of 402 955** periods (56 %; 383 613 of 703 983 on the
other, 54 %). A throttled cgroup freezes every thread until the 100 ms period
ends. `ci.yml` calls that machine "a 4-core N100" — `nproc` inside the
container says 4, its quota says 1 — and nothing in the repo said so.

The rejected alternatives: skipping either test off Linux or on a slow runner
(a test that passes by not running is the D622 shape again); retrying the
control until a clean window appears (a bounded search for luck on a 55 %-
throttled core, and it would still be grading the scheduler); and printing
`v8WorkerCpu=?` when the share is unknown, which reverses D469's rule that
absence IS the reading.

## Decision

A spec that compares two lines built from readings of the real process poses
every such reading through the probes the code already injects for that
purpose (`HeapWatchProbes.processCpu`, `readSpaces`), from the fake clock, so
that a window is a window on every machine — and it asserts the conditional
fields are PRESENT, so equality is never two absences. A timing control that
proves an instrument can see yielding work uses a window longer than the
scheduler's longest freeze: four CFS periods (400 ms), stated in the constant's
name and reason. The disease burst it guards stays short, because a
synchronous stall only looks more like a stall when the machine is starved.

## Consequences

- The vocabulary test now also fails when `v8WorkerCpu` or `procCpu` stops
  being printed at all, which it could not before on any developer machine.
- The churn control costs 400 ms instead of 40. Its assertion message carries
  the reading, so the next red on a shared runner says what the machine did.
- The runner's one-core cap is a fact CI comments must stop contradicting;
  a timing spec added later has to be read against a 100 ms freeze, not
  against `nproc`.
- Whether the control still fails under a freeze longer than 160 ms on that
  runner is not measured here — the first push after this record is the
  measurement, and its message will carry the numbers.

## Enforcement

The specs themselves, each disarmed and restored on 2026-09-24: un-posing
either watch, removing the `procCpu` append, and printing `v8WorkerCpu` never
each fail the vocabulary test; neutralising the ping chain, replacing the
sqlite burst with a timer, and a 250 ms stall inside the control window each
fail the churn spec. Nothing guards the rule for the next spec that reads the
real process under fake timers — review only.
