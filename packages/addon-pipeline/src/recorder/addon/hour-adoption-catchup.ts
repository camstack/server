/**
 * Keep adopting while there is something to adopt.
 *
 * `HourAdoptionSweeper.sweep()` is deliberately bounded: at most
 * {@link WALK_HOUR_BATCH} hour listings per call, with a cursor to resume from,
 * so one pass cannot walk a four-terabyte array in a single breath. The
 * recorder then called it ONCE per location per day, which turned the bound
 * into a speed limit: the first real pass on this hub adopted 29 037 segments
 * from one location and returned `bounded: true` — there was more, and the next
 * look was twenty-four hours away. The cursor lives in RAM, so a restart in
 * between sent it back to the start.
 *
 * So the daily interval stays the cadence for a QUIET archive, and this is what
 * happens when the archive is not quiet: sweep again while the last pass said
 * it stopped at the cap, pacing between passes, until the work runs out or the
 * budget does. A pass that gives up on the budget has lost nothing — the next
 * one resumes from the cursor.
 *
 * The budget is what keeps this off the array's throat: every listing is a
 * `readdir` on a spinning disk, and the pacing between them is already the
 * sweeper's own. This only decides how many bounded passes may follow one
 * another.
 */

export interface AdoptionCatchUpDeps<TReport extends { readonly bounded: boolean }> {
  /** Every location this node can READ — a damaged hour lives on its own disk. */
  readonly locationIds: readonly string[]
  readonly sweep: (input: { locationId: string }) => Promise<TReport>
  /** Wall-clock ceiling for the whole catch-up, across every location. */
  readonly budgetMs: number
  /** Injectable clock (ms). */
  readonly now: () => number
  /** Breathing room between passes — the sweeper paces WITHIN a pass. */
  readonly pace: () => Promise<void>
  /**
   * A location that cannot be swept. Absent = silence, which is wrong for a
   * repair: a location that never adopts and never complains looks repaired.
   */
  readonly onError?: (locationId: string, error: unknown) => void
}

/**
 * @returns true when the run stopped with work still to do — the caller should
 *   come back SOON rather than at the next daily tick. A repair that knows it
 *   is unfinished and waits a day is how an archive stays short for months.
 */
export async function runAdoptionCatchUp<TReport extends { readonly bounded: boolean }>(
  deps: AdoptionCatchUpDeps<TReport>,
): Promise<boolean> {
  const startedAt = deps.now()
  const spent = (): number => deps.now() - startedAt

  for (const locationId of deps.locationIds) {
    for (;;) {
      if (spent() >= deps.budgetMs) return true
      let report: TReport
      try {
        report = await deps.sweep({ locationId })
      } catch (error) {
        // One unreadable location must not cost the others their repair.
        deps.onError?.(locationId, error)
        break
      }
      if (!report.bounded) break
      if (spent() >= deps.budgetMs) return true
      await deps.pace()
    }
  }
  return false
}
