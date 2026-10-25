/**
 * Waiting for the controller's async work under FAKE timers.
 *
 * ## What went wrong with counting turns
 *
 * `RecordingController` does real filesystem work between a trigger and its
 * observable effect: an attach `mkdir`s the staging directory, a detach reads
 * the watcher's playlist. Under fake timers the clock does not move on its
 * own, so the specs drained the event loop by hand — `for (let i = 0; i < 20;
 * i++) await vi.advanceTimersByTimeAsync(0)` — and then asserted.
 *
 * A fixed turn count is a bet on how fast the machine's disk and libuv
 * threadpool are. The self-hosted runner carries 4 400 other tests beside
 * these, and it lost the bet twice in two consecutive runs:
 *
 * - 35497173489 — `a fresher trigger RE-ARMS the window`:
 *   *expected "spy" to be called 1 times, but got 0 times* (the detach had not
 *   landed yet).
 * - 35501079112 — `recovers a dead high writer without unpinning a healthy
 *   low`: the re-attach had not landed yet.
 *
 * Four more tests in this directory were commented out on 2026-09-14 as
 * "flaky under host load" for the same reason. Tuning the constant upward is
 * not a fix — it is the same bet at longer odds, and it slows every green run.
 *
 * ## The rule
 *
 * Wait for the work to LAND, under a bound (D58) — never for a number of
 * turns. `settleUntil` spins the loop until the effect is observable and fails
 * with what it was waiting for if it never is. A fixed drain survives only
 * where the assertion is an ABSENCE, which no amount of extra waiting can make
 * true: `settleTurns` is that case, and it says so.
 */
import { vi } from 'vitest'

/**
 * The bound. Reached only by work that is never going to land — the loop does
 * not move the clock, so a healthy settle costs a handful of turns.
 */
const MAX_TURNS = 10_000

/** Turns drained before an assertion that something did NOT happen. */
const ABSENCE_TURNS = 50

/**
 * Drain the event loop until `landed()` holds, or fail saying what never did.
 *
 * `advanceTimersByTimeAsync(0)` fires nothing and moves no clock; it yields to
 * the event loop so a pending `fs` completion can be delivered. That is the
 * whole mechanism, and it is why an unbounded-but-capped loop is correct where
 * a counted one is a race.
 */
async function settleUntil(landed: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (landed()) return
    await vi.advanceTimersByTimeAsync(0)
  }
  throw new Error(`settle: ${what} never landed within ${String(MAX_TURNS)} event-loop turns`)
}

/**
 * Drain a fixed number of turns.
 *
 * ONLY for an assertion that something did not happen. Draining too few turns
 * makes an absence pass for the wrong reason; draining too many cannot make it
 * fail, so the count is safe in that one direction and in no other.
 */
async function settleTurns(turns: number = ABSENCE_TURNS): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await vi.advanceTimersByTimeAsync(0)
}

export { settleUntil, settleTurns }
