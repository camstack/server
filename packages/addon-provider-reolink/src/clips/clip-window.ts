/**
 * clip-window — narrowing a DAY's rows to the window that was ASKED for.
 *
 * ## What was wrong
 *
 * `listClips` takes `since` and `until` and the Reolink provider ignored them.
 * It walked the camera's day calendar, listed each day the window touches, and
 * returned every row of every one of those days. The cap's own schema declares
 * both as required, and every surface that renders the answer believes it.
 *
 * Measured on the live hub, device 107, 2026-09-22: a ONE-HOUR window answered
 * **195 rows, 173 of them outside it**. The recorder's own videoclips provider
 * honours the window in the same call, so one camera with two sources answered
 * the same question two different ways — and the app's date label, built from
 * the rows it got back, drifted away from the window it had asked for.
 *
 * ## Why the day stays the cache unit
 *
 * A day is what the camera indexes and what `clip-catalog-cache.ts` stores and
 * revalidates; narrowing the FETCH would make the cache unit depend on the
 * caller's window and destroy its reuse. So the day remains the unit of work
 * and this is the unit of ANSWER. The two are different questions and the
 * expensive one is unchanged.
 *
 * ## Overlap, not containment
 *
 * A clip that begins before the window and runs into it is IN the window: the
 * operator asking for 15:00–16:00 wants the clip that started at 14:59 and was
 * still recording at 15:00, and `Clip` is documented as purely time-based,
 * resolved by temporal overlap. Containment would silently drop exactly the
 * clips that straddle the edges — which, on a camera whose clips are minutes
 * long, is every boundary of every window.
 *
 * Pure: no camera, no cache, no logger.
 */

/** The two stamps a row must carry to be placed on the axis at all. */
export interface ClipWindowRow {
  readonly startMs: number
  readonly endMs: number
}

export interface ClipWindow {
  readonly since: number
  readonly until: number
}

/**
 * Does this row overlap the window?
 *
 * Half-open on both ends (`start < until`, `end > since`), so a clip that ends
 * exactly when the window begins is OUT and a clip that begins exactly when it
 * ends is OUT — otherwise two adjacent windows both claim the same boundary
 * clip and a surface paging through them renders it twice.
 *
 * A row whose `endMs` is not after its `startMs` is treated as an INSTANT at
 * `startMs`. That is not defensive padding: a clip still being written carries
 * a frozen `endMs` from the camera's index (D563), and on this fleet that has
 * been observed equal to — and once behind — its own start. Judging such a row
 * by a bad end would drop a recording that is happening right now.
 */
export function clipOverlapsWindow(row: ClipWindowRow, window: ClipWindow): boolean {
  const end = row.endMs > row.startMs ? row.endMs : row.startMs
  return row.startMs < window.until && end > window.since
}

export interface ClipWindowNarrowing<T extends ClipWindowRow> {
  readonly kept: readonly T[]
  /** How many rows the day held that the window did not ask for. Reported, not
   *  discarded quietly: a branch that drops work and says nothing reads as
   *  "there was nothing there". */
  readonly dropped: number
}

/** The rows of the listed days, narrowed to the window the caller asked for. */
export function narrowClipsToWindow<T extends ClipWindowRow>(
  rows: readonly T[],
  window: ClipWindow,
): ClipWindowNarrowing<T> {
  const kept = rows.filter((row) => clipOverlapsWindow(row, window))
  return { kept, dropped: rows.length - kept.length }
}

/** A row the camera is STILL WRITING. */
export interface ClipListableRow extends ClipWindowRow {
  readonly inProgress?: boolean
}

export interface ClipListing<T extends ClipListableRow> {
  readonly kept: readonly T[]
  /** Outside the window the caller asked for. */
  readonly outOfWindow: number
  /** Still being written by the camera. */
  readonly inProgress: number
}

/**
 * What the provider ANSWERS with — the one gate, so there is a single place
 * that decides what leaves this listing and a single line that reports it.
 *
 * ## Why a clip still being written is not listed
 *
 * The operator, 2026-09-22: *"Niente clips in preparazione, non ha senso
 * visualizzarle."* He is right, and the reasons had been accumulating:
 *
 * - its `endMs` is a frozen guess — the camera's index keeps whatever it held
 *   when the file was opened, measured on 592 as the same `endTime` for eight
 *   minutes (D563) — so the row's duration, its position on the axis and its
 *   height are all wrong and all move;
 * - `readClipBytes` already refuses it by name (`clip-in-progress`): it has no
 *   end to export against, so the completion rule has nothing to prove the
 *   fetch finished (D568);
 * - it cannot be looped, and the surface has to explain why (`resolveClipLoop`);
 * - the player route would file a TRUNCATED copy under an immutable key, so
 *   the first seconds become permanently what that clip is.
 *
 * Four different places bending around a row that cannot be played properly.
 * Not listing it deletes all four questions instead of answering them: the
 * clip appears, whole, on the next listing after the camera closes the file.
 */
export function listableClips<T extends ClipListableRow>(
  rows: readonly T[],
  window: ClipWindow,
): ClipListing<T> {
  const inWindow = rows.filter((row) => clipOverlapsWindow(row, window))
  const kept = inWindow.filter((row) => row.inProgress !== true)
  return {
    kept,
    outOfWindow: rows.length - inWindow.length,
    inProgress: inWindow.length - kept.length,
  }
}
