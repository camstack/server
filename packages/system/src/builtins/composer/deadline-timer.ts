import type { DeadlineTimer } from './composition-runtime.js'

/** Node's largest `setTimeout` delay; anything longer is clamped to 1 ms (`TimeoutOverflowWarning`). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** One pending wake-up per composition, at its earliest expression deadline. Never a poll. */
export class NodeDeadlineTimer implements DeadlineTimer {
  private handle: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly now: () => number) {}

  arm(at: number, fire: () => void): void {
    this.disarm()
    this.schedule(at, fire)
  }

  /**
   * A deadline further away than the largest delay is reached in legs: the
   * clamped wake-up is NOT the deadline, so it re-arms the remainder instead of
   * firing — firing early would re-arm the same deadline and, unclamped, Node
   * turns it into a 1 ms spin (D3).
   */
  private schedule(at: number, fire: () => void): void {
    const remaining = Math.max(0, at - this.now())
    const clamped = remaining > MAX_TIMER_DELAY_MS
    this.handle = setTimeout(
      () => {
        this.handle = null
        if (clamped) this.schedule(at, fire)
        else fire()
      },
      clamped ? MAX_TIMER_DELAY_MS : remaining,
    )
    this.handle.unref?.()
  }

  disarm(): void {
    if (this.handle === null) return
    clearTimeout(this.handle)
    this.handle = null
  }
}
