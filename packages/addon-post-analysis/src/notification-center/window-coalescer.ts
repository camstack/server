/**
 * One window over a stream of items, keyed.
 *
 * `sliding` resets the deadline on every item — the addon-update batch, which
 * stays one notification however long the job keeps finishing packages.
 * `fixed` opens at the first item and flushes at first + delay, so a later
 * item does not keep the window open forever.
 *
 * The class owns its buckets. Callers pass items; nothing here writes them back.
 */

export type WindowCoalesceMode = 'sliding' | 'fixed'

export interface WindowSlot {
  readonly openedAt: number
  readonly releaseAt: number
}

export interface WindowCoalescerOptions<T> {
  readonly mode: WindowCoalesceMode
  readonly delayMs: number
  /** When set, a later item with the same identity replaces the earlier one. */
  readonly identityOf?: (item: T) => string
  readonly onFlush: (key: string, items: readonly T[]) => void
  readonly schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly cancel?: (id: ReturnType<typeof setTimeout>) => void
  readonly now?: () => number
}

interface Bucket<T> {
  openedAt: number
  releaseAt: number
  items: T[]
  timer: ReturnType<typeof setTimeout> | null
}

export interface WindowBatch<T> {
  readonly key: string
  readonly openedAt: number
  readonly items: readonly T[]
}

export class WindowCoalescer<T> {
  private readonly buckets = new Map<string, Bucket<T>>()
  private readonly mode: WindowCoalesceMode
  private readonly delayMs: number
  private readonly identityOf: ((item: T) => string) | undefined
  private readonly onFlush: (key: string, items: readonly T[]) => void
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly cancel: (id: ReturnType<typeof setTimeout>) => void
  private readonly now: () => number

  constructor(options: WindowCoalescerOptions<T>) {
    this.mode = options.mode
    this.delayMs = options.delayMs
    this.identityOf = options.identityOf
    this.onFlush = options.onFlush
    this.schedule = options.schedule ?? setTimeout
    this.cancel = options.cancel ?? clearTimeout
    this.now = options.now ?? ((): number => Date.now())
  }

  /** Add an item. The slot's `openedAt` is the first item's, and stays that in `fixed` mode. */
  observe(key: string, item: T, delayMs?: number): WindowSlot {
    const now = this.now()
    const delay = delayMs ?? this.delayMs
    const existing = this.buckets.get(key)
    if (existing === undefined) {
      const bucket: Bucket<T> = {
        openedAt: now,
        releaseAt: now + delay,
        items: [],
        timer: null,
      }
      this.remember(bucket, item)
      this.buckets.set(key, bucket)
      this.arm(key, bucket, delay)
      return { openedAt: bucket.openedAt, releaseAt: bucket.releaseAt }
    }
    this.remember(existing, item)
    if (this.mode === 'sliding') {
      this.rearm(key, existing, now + delay, delay)
    }
    return { openedAt: existing.openedAt, releaseAt: existing.releaseAt }
  }

  /**
   * Put an item into a window that already has a deadline (a restart reloads
   * rows the previous process was holding). A fixed window keeps the original
   * deadline. A second adopt of the same key only appends.
   */
  adopt(key: string, item: T, openedAt: number, releaseAt: number): void {
    const existing = this.buckets.get(key)
    if (existing !== undefined) {
      this.remember(existing, item)
      return
    }
    const bucket: Bucket<T> = { openedAt, releaseAt, items: [], timer: null }
    this.remember(bucket, item)
    this.buckets.set(key, bucket)
    this.arm(key, bucket, Math.max(0, releaseAt - this.now()))
  }

  /** Remove one bucket and return what it held. `undefined` when it was already taken. */
  take(key: string): WindowBatch<T> | undefined {
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return undefined
    this.disarm(bucket)
    this.buckets.delete(key)
    return { key, openedAt: bucket.openedAt, items: bucket.items }
  }

  /** Every bucket whose deadline has arrived, removed. */
  takeDue(now: number): readonly WindowBatch<T>[] {
    const due: WindowBatch<T>[] = []
    for (const key of [...this.buckets.keys()]) {
      const bucket = this.buckets.get(key)
      if (bucket === undefined || bucket.releaseAt > now) continue
      const batch = this.take(key)
      if (batch !== undefined && batch.items.length > 0) due.push(batch)
    }
    return due
  }

  /** Every open bucket, removed. A stop flushes these; {@link dispose} does not. */
  takeAll(): readonly WindowBatch<T>[] {
    const all: WindowBatch<T>[] = []
    for (const key of [...this.buckets.keys()]) {
      const batch = this.take(key)
      if (batch !== undefined && batch.items.length > 0) all.push(batch)
    }
    return all
  }

  /** Cancel every timer and drop what was held. A crash, or the addon-update dispose. */
  dispose(): void {
    for (const bucket of this.buckets.values()) this.disarm(bucket)
    this.buckets.clear()
  }

  private remember(bucket: Bucket<T>, item: T): void {
    const identity = this.identityOf?.(item)
    if (identity === undefined) {
      bucket.items.push(item)
      return
    }
    const index = bucket.items.findIndex((existing) => this.identityOf?.(existing) === identity)
    if (index < 0) bucket.items.push(item)
    else bucket.items[index] = item
  }

  private rearm(key: string, bucket: Bucket<T>, releaseAt: number, delay: number): void {
    this.disarm(bucket)
    bucket.releaseAt = releaseAt
    this.arm(key, bucket, delay)
  }

  private arm(key: string, bucket: Bucket<T>, ms: number): void {
    bucket.timer = this.schedule(() => {
      const batch = this.take(key)
      if (batch !== undefined && batch.items.length > 0) this.onFlush(key, batch.items)
    }, ms)
  }

  private disarm(bucket: Bucket<T>): void {
    if (bucket.timer === null) return
    this.cancel(bucket.timer)
    bucket.timer = null
  }
}
