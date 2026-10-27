/**
 * Smaller than the history deadband of the lifetime counters (0.01 kWh): float noise from
 * rounding or a unit conversion, never a real drop.
 */
const NOISE = 0.01

/**
 * Keeps a lifetime counter monotonic before it reaches a `counter` history series, where a
 * drop means "the meter was reset" and re-bases every later total.
 *
 * The box occasionally reports 0 or a stale lower figure for one poll (a restart, a partly
 * written window). One such reading is held back: the previous value is published instead.
 * A lower reading that is then followed by a value at or above it is a genuine reset or a
 * replaced meter, and is accepted.
 */
export class LifetimeCounterGuard {
  #published: number | null = null
  #suspect: number | null = null

  /** The value to publish for the reading `next`. */
  accept(next: number): number {
    const published = this.#published
    if (published === null || next >= published - NOISE) {
      this.#published = next
      this.#suspect = null
      return next
    }
    const suspect = this.#suspect
    if (suspect !== null && next >= suspect - NOISE) {
      this.#published = next
      this.#suspect = null
      return next
    }
    this.#suspect = next
    return published
  }
}
