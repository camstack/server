/**
 * Per-runner serialization of the WHOLE converge sequence.
 *
 * ## Why the lock one level down was not enough
 *
 * `process-service`'s `withRunnerLock` makes each of `$process.stop` and
 * `$process.spawnRunner` atomic on its own, and its docblock describes exactly
 * the leak it exists to stop. But `ensureForkedRunner` is not one action: it
 * READS the running processes, STOPS the stale ones, then SPAWNS the roster —
 * three awaits, and the unit that has to be atomic is all three together.
 *
 * Two concurrent converges of one runner both read "not running", both stop,
 * and both spawn. Two children, one map entry, and the one nobody tracks keeps
 * running: it answers HomeKit, it holds its ffmpeg grandchildren, and only a
 * signal sent by hand removes it.
 *
 * Measured twice on the live hub:
 *
 *  - 2026-09-16 — a deploy plus an operator `restartAddon`: one "shutting
 *    down" and THREE runners started within five seconds.
 *  - 2026-09-17 — no manual restart at all. A container reboot's own spawn met
 *    the restart a deploy fires for itself; two runners started in the same
 *    second and every camera was published to HomeKit twice.
 *
 * The first diagnosis blamed the operator restart. The second episode disproved
 * it: any two lifecycle operations racing on one runner do this, and the
 * deploy alone supplies both.
 *
 * ## Shape
 *
 * A FIFO promise chain per runner id — the same shape as `withRunnerLock`,
 * applied at the level where the composite operation lives. Different runners
 * never wait on each other: a deploy touches many, and serializing them
 * globally would turn a parallel reconcile serial for no safety gained.
 *
 * The tail never rejects, so a converge that throws does not wedge every later
 * one for that runner — the runner is already in a bad state and refusing to
 * converge it again would make that permanent.
 */
export type RunnerSerializer = <T>(runnerId: string, converge: () => Promise<T>) => Promise<T>

export function createRunnerSerializer(): RunnerSerializer {
  const tails = new Map<string, Promise<unknown>>()

  return <T>(runnerId: string, converge: () => Promise<T>): Promise<T> => {
    const previous = tails.get(runnerId) ?? Promise.resolve()
    // `then(fn, fn)` so a rejected predecessor still lets the next one run.
    const result = previous.then(converge, converge)
    tails.set(
      runnerId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    )
    return result
  }
}
