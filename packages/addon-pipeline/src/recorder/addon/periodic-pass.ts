/**
 * A periodic pass that never overlaps itself and never goes quiet.
 *
 * The recorder's convergence loop was a bare `setInterval(() => void tick())`.
 * Two failure modes followed from that, and both cost footage on 2026-08-13:
 *
 * - **Overlap.** A pass that awaited a 60 s broker RPC per device did not stop
 *   the next pass from starting, so wedged passes piled up — dozens of
 *   concurrent detach/attach attempts against an already-degraded broker.
 * - **Silence.** A wedged pass logged nothing at all. The recorder produced no
 *   line for 27 minutes (04:44:33Z → 05:11:22Z) while four cameras recorded
 *   nothing, and the first evidence was a watchdog reporting `idleMs=546335`
 *   against a `boundMs=90000` — a bound it had been past for 9 minutes.
 *
 * So: one run at a time, a named line when a fire is skipped, and a named line
 * when a run outlives its budget. A pass that drops its turn says why (the
 * silent-drop rule); a pass that runs long is attributable without correlating
 * timestamps by hand.
 */
import type { IScopedLogger } from '@camstack/types'
import type { HeapDeltaTracker } from './heap-delta.js'

export interface PeriodicPassDeps {
  /** Appears in every line this pass emits, so two passes are never confused. */
  readonly name: string
  readonly intervalMs: number
  /** A completed run longer than this is reported with its duration. */
  readonly slowAfterMs: number
  readonly run: () => Promise<void>
  readonly logger: IScopedLogger
  /** Injectable clock (ms) — defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * Run once this many ms after start, BEFORE the first interval tick.
   *
   * For a pass whose interval is shorter than the time between restarts this
   * changes nothing worth having. For a DAILY pass it is the difference between
   * running and never running: `hour-adoption` repairs sealed-but-short hours
   * every 24 h, and a hub that restarts more often than that had armed the
   * timer and never reached it — five restarts in one morning, with the hole it
   * exists to repair still on disk (2026-09-18).
   *
   * Absent = the old behaviour, one full interval before the first run.
   */
  readonly firstRunDelayMs?: number
  /**
   * Measures each run's effect on the heap and names the pass when it grew
   * the heap or the large-object space past a threshold (see `heap-delta.ts`).
   * Instrumentation only: the run is awaited exactly as without it.
   * Absent = unmeasured.
   */
  readonly heapProbe?: HeapDeltaTracker
}

export interface PeriodicPassHandle {
  stop(): void
  /** True while a run is in flight — for tests and for shutdown ordering. */
  isRunning(): boolean
  /**
   * Run NOW, unless a run is already in flight.
   *
   * For a pass that discovers mid-run that it is unfinished: hour adoption
   * stops on a wall-clock budget with a cursor to resume from, and waiting a
   * full day to resume is how an archive stays short for months. It goes
   * through the same overlap guard as a scheduled fire — a caller cannot make
   * two runs race by asking twice.
   */
  fireNow(): void
}

export function startPeriodicPass(deps: PeriodicPassDeps): PeriodicPassHandle {
  const now = (): number => deps.now?.() ?? Date.now()
  let startedAt: number | null = null
  let stopped = false

  const fire = (): void => {
    if (stopped) return
    if (startedAt !== null) {
      // Never run two at once. Say so — a skipped turn that logs nothing is
      // indistinguishable from a healthy loop with nothing to do.
      deps.logger.warn('recorder: pass skipped — the previous pass is still running', {
        meta: { pass: deps.name, inFlightMs: now() - startedAt, intervalMs: deps.intervalMs },
      })
      return
    }
    const began = now()
    startedAt = began
    const probe = deps.heapProbe
    const run =
      probe === undefined ? deps.run() : probe.track({ kind: 'pass', name: deps.name }, deps.run)
    void run
      .catch((err: unknown) => {
        deps.logger.warn('recorder: pass failed', {
          meta: { pass: deps.name, error: err instanceof Error ? err.message : String(err) },
        })
      })
      .finally(() => {
        const durationMs = now() - began
        startedAt = null
        if (durationMs > deps.slowAfterMs) {
          deps.logger.warn('recorder: pass exceeded its budget', {
            meta: { pass: deps.name, durationMs, budgetMs: deps.slowAfterMs },
          })
        }
      })
  }

  const timer = setInterval(fire, deps.intervalMs)
  timer.unref?.()

  // A separate one-shot rather than a leading edge on the interval: the
  // interval keeps its own phase, so a pass asked to run at boot still runs at
  // the cadence it declared and not at boot-plus-cadence.
  const firstRun =
    deps.firstRunDelayMs === undefined ? null : setTimeout(fire, deps.firstRunDelayMs)
  firstRun?.unref?.()

  return {
    stop(): void {
      stopped = true
      clearInterval(timer)
      if (firstRun !== null) clearTimeout(firstRun)
    },
    isRunning: () => startedAt !== null,
    fireNow: fire,
  }
}
