/**
 * Per-key promise-chain mutex for retrain frame commits.
 * Same ordering idea as device-manager `createWriteLock`, keyed by mediaKey.
 */
export class KeyedCommitLock<TKey> {
  private readonly tails = new Map<TKey, Promise<unknown>>()

  run<T>(key: TKey, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve()
    const result = prior
      .catch(() => {
        /* keep the chain alive for waiters behind a rejected section */
      })
      .then(() => fn())
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key)
      }
    })
    return result
  }
}
