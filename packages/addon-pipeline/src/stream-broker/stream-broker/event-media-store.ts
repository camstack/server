/**
 * Where a produced event artifact waits to be fetched.
 *
 * `produceEventMedia` returns HANDLES, never bytes
 * ([D9](../../../../../docs/decisions/adr-0009.md),
 * [D18](../../../../../docs/decisions/adr-0018.md)): every consumer of that
 * method is in another runner, and a 2 MB payload riding the reply of a method
 * whose useful answer is "here is what I cut, and it covers these seconds" is
 * exactly the shape that OOM'd hub-main. So the producing runner keeps the
 * artifact for a few minutes and the consumer redeems what it actually wants.
 *
 * Three rules, each of which is a failure mode rather than a preference:
 *
 *  - **It EXPIRES.** A consumer that crashed between producing and fetching must
 *    not pin megabytes forever. A handle is minutes-lived and a late fetch
 *    returns `null` — visibly nothing, never a zero-length file.
 *  - **It is BOUNDED IN BYTES, and evicts oldest-first.** A burst of
 *    notifications on eight cameras must not become a heap the broker never
 *    gives back. The bound is what makes this store's cost a constant.
 *  - **A fetch does NOT consume it.** A retry after a transport hiccup is the
 *    commonest thing that happens to a cross-runner fetch, and a single-use
 *    handle turns that into "the media vanished".
 */

/** How long a produced artifact stays fetchable. */
export const EVENT_MEDIA_TTL_MS = 5 * 60_000

/**
 * The store's whole footprint.
 *
 * A 10 s copy clip at 720p measures ~220 KB on this fleet and its gif ~330 KB,
 * so 64 MB is well over a hundred outstanding productions — far more than a
 * fleet could produce inside one TTL, and a number the broker can hold without
 * anybody noticing.
 */
export const EVENT_MEDIA_MAX_BYTES = 64 * 1024 * 1024

export interface StoredEventMedia {
  readonly handle: string
  readonly deviceId: number
  readonly kind: string
  readonly mime: string
  readonly bytes: Uint8Array
  readonly storedAt: number
}

export interface EventMediaStoreDeps {
  readonly now?: () => number
  readonly ttlMs?: number
  readonly maxBytes?: number
  /** Injected so a test does not need `node:crypto`'s randomness to assert. */
  readonly makeId?: () => string
}

export class EventMediaStore {
  /** Insertion-ordered — `Map` iteration order IS the eviction order. */
  private readonly items = new Map<string, StoredEventMedia>()
  private totalBytes = 0

  constructor(private readonly deps: EventMediaStoreDeps = {}) {}

  get size(): number {
    return this.items.size
  }

  get bytes(): number {
    return this.totalBytes
  }

  /** Store one artifact and return its handle. */
  put(input: {
    readonly deviceId: number
    readonly kind: string
    readonly mime: string
    readonly bytes: Uint8Array
  }): string {
    const now = this.deps.now ?? Date.now
    this.sweep()
    const handle = `evm_${input.deviceId}_${(this.deps.makeId ?? defaultId)()}`
    this.items.set(handle, { handle, storedAt: now(), ...input })
    this.totalBytes += input.bytes.length
    const maxBytes = this.deps.maxBytes ?? EVENT_MEDIA_MAX_BYTES
    // Oldest-first, and NEVER down to zero: `size > 1` is the whole protection
    // for the artifact just stored. A producer whose own artifact is evicted to
    // make room for itself would return a handle that was dead on arrival —
    // which is the one failure mode a byte cap can invent, and it happens
    // exactly when a single artifact is larger than the cap.
    while (this.totalBytes > maxBytes && this.items.size > 1) {
      const oldest = this.items.keys().next().value
      if (oldest === undefined) break
      this.drop(oldest)
    }
    return handle
  }

  /** Redeem a handle. `null` when it never existed or has expired. */
  get(handle: string): StoredEventMedia | null {
    this.sweep()
    return this.items.get(handle) ?? null
  }

  /** Drop everything — shutdown. */
  clear(): void {
    this.items.clear()
    this.totalBytes = 0
  }

  private sweep(): void {
    const now = (this.deps.now ?? Date.now)()
    const ttl = this.deps.ttlMs ?? EVENT_MEDIA_TTL_MS
    for (const [handle, item] of this.items) {
      // Insertion-ordered, so the first non-expired entry ends the sweep.
      if (now - item.storedAt < ttl) break
      this.drop(handle)
    }
  }

  private drop(handle: string): void {
    const item = this.items.get(handle)
    if (item === undefined) return
    this.items.delete(handle)
    this.totalBytes -= item.bytes.length
  }
}

let counter = 0
function defaultId(): string {
  counter += 1
  return `${Date.now().toString(36)}${counter.toString(36)}`
}
