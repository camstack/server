/**
 * Saves on ONE record are serialised (D1098): the stamp check and the write that follows it are
 * one step, so two saves that read the same stamp cannot both pass the check. Tasks under one key
 * run one after another in call order; different keys do not wait for each other. A failing task
 * rejects its own caller and never blocks the next one.
 */
export class KeyedSerialiser {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(() => task())
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}

/** The one serialiser of per-device settings-blob saves (linked devices and their backfill). */
export const DEVICE_BLOB_SAVES = new KeyedSerialiser()
