/**
 * The stop -> rebuild -> start cycle of the agent's broker, guarded by a GENERATION.
 *
 * The queue (`serial-queue.ts`) abandons a job that passes its deadline and starts the next
 * one. The abandoned job is not cancelled - JavaScript cannot - so it may resume later (its
 * old `broker.stop()` finally returns) and carry on to build and start a broker: a second
 * broker with the same node id as the one the NEXT job just assigned. Every run therefore
 * takes a generation number, and after each await it checks that it is still the newest;
 * a superseded run builds nothing, assigns nothing, starts nothing, and destroys anything it
 * had already half-built.
 */
export interface ReconnectDeps<B> {
  readonly current: () => B
  readonly assign: (broker: B) => void
  readonly stop: (broker: B) => Promise<void>
  /** Reload config and return how to build the next broker (side effects on process state go here). */
  readonly prepare: () => void
  readonly build: () => B
  readonly start: (broker: B) => Promise<void>
  readonly onSuperseded?: (stage: 'before-build' | 'after-build' | 'after-start') => void
}

export function createReconnectRunner<B>(deps: ReconnectDeps<B>): () => Promise<void> {
  let generation = 0
  return async () => {
    const mine = ++generation
    const superseded = (): boolean => mine !== generation
    try {
      await deps.stop(deps.current())
    } catch {
      /* already stopped */
    }
    if (superseded()) {
      deps.onSuperseded?.('before-build')
      return
    }
    deps.prepare()
    const next = deps.build()
    if (superseded()) {
      deps.onSuperseded?.('after-build')
      await deps.stop(next).catch(() => undefined)
      return
    }
    deps.assign(next)
    await deps.start(next)
    if (superseded()) {
      // A newer run replaced `next` while it was starting: do not leave it running.
      deps.onSuperseded?.('after-start')
      await deps.stop(next).catch(() => undefined)
    }
  }
}
