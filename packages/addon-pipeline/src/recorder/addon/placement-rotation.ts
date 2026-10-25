/**
 * The tie re-ranker the placement planner defers to (D37).
 *
 * `planPlacement` is pure and must stay that way, so the fair choice between
 * two locations the capacity signal cannot separate lives here instead: a
 * round-robin cursor keyed by the TIED SET itself. D37 is the record of what
 * happens without it — a `localeCompare` tie-break decided every single
 * dispatch on a cluster where the load signal was almost always zero, and one
 * accelerator was never used at all. Two equal-capacity recordings disks would
 * starve exactly the same way: `recordings:a` < `recordings:b`, forever.
 *
 * The cursor is advisory. A lost cursor (a restart) costs at most one unfair
 * choice, and it is consulted ONLY for a genuine tie — a location the capacity
 * signal separates never reaches it.
 */
export class PlacementRotation {
  /** `<tied ids joined>` → the index to hand out next. */
  private readonly cursors = new Map<string, number>()

  /**
   * Pick fairly among a tied set. The set itself is the key, so adding a third
   * disk starts a new rotation rather than inheriting a two-disk cursor.
   */
  next(tied: readonly string[]): string {
    if (tied.length === 0) throw new Error('placement rotation: empty tied set')
    const first = tied[0]!
    if (tied.length === 1) return first
    const key = [...tied].toSorted().join('|')
    const cursor = this.cursors.get(key) ?? 0
    this.cursors.set(key, (cursor + 1) % tied.length)
    return tied[cursor % tied.length] ?? first
  }
}
