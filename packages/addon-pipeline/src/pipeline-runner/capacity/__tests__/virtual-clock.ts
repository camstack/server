/**
 * Deterministic virtual clock for the capacity pacer tests.
 *
 * `now`/`sleepUntil` mirror the injected pair `runCapacityStep` consumes.
 * Time advances ONLY through `run(until)`: the earliest pending sleeper is
 * resolved, microtasks are flushed so continuations (dispatch chains, loop
 * iterations) settle, then the next sleeper is picked. `block(ms)` emulates
 * an event-loop stall: the clock jumps forward instantly, so sleepers
 * scheduled inside the blocked span resolve LATE — exactly what the pacer's
 * absolute schedule must survive without losing offered ticks.
 */
export class VirtualClock {
  private t = 0
  private sleepers: Array<{ readonly at: number; readonly resolve: () => void }> = []

  readonly now = (): number => this.t

  readonly sleepUntil = (at: number): Promise<void> => {
    if (at <= this.t) return Promise.resolve()
    return new Promise((resolve) => {
      this.sleepers.push({ at, resolve })
    })
  }

  /** Simulate a synchronous block: time leaps forward with no sleeper fired. */
  block(ms: number): void {
    this.t += ms
  }

  /** Advance virtual time to `until`, resolving every due sleeper in order. */
  async run(until: number): Promise<void> {
    for (;;) {
      await flushMicrotasks()
      const due = this.sleepers.filter((s) => s.at <= until).toSorted((a, b) => a.at - b.at)[0]
      if (!due) break
      this.t = Math.max(this.t, due.at)
      this.sleepers = this.sleepers.filter((s) => s !== due)
      due.resolve()
    }
    await flushMicrotasks()
    if (until > this.t) this.t = until
  }
}

/** Drain chained thenables — enough rounds for the pacer's finally chains. */
export async function flushMicrotasks(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}
