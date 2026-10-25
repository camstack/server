/**
 * The promise-chain mutex the device-manager orders its read-modify-writes
 * with.
 *
 * One owner at a time, FIFO, no timers and no timeout: a waiter is parked on
 * the previous holder's completion, so nothing is delayed that was not already
 * waiting for a store round trip. A rejected holder still releases the chain —
 * a failed write must not wedge every writer behind it.
 *
 * Extracted from `DeviceMetaStore.withMetaWriteLock`, which was the only
 * instance until the addon's OWN settings row set needed the same ordering.
 * Two subtly different copies of a mutex is not a thing this file wants to
 * exist.
 */

/** Run `fn` with exclusive ownership of one lock. */
export type WriteLock = <T>(fn: () => Promise<T>) => Promise<T>

export function createWriteLock(): WriteLock {
  let chain: Promise<unknown> = Promise.resolve()
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = chain
    let release: () => void = () => {}
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    chain = next
    try {
      await previous.catch(() => {
        /* swallow — keep the chain alive for everyone queued behind it */
      })
      return await fn()
    } finally {
      release()
    }
  }
}
