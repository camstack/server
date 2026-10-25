/**
 * Node-side generations a caller can still stop, by `requestId`.
 *
 * The hub's `llm.cancel` forwards here over the same nodePin the generation
 * took. Two orderings exist and both must stop the work:
 *   - cancel after the generation registered → abort its controller;
 *   - cancel BEFORE it registered (the node was still booting llama-server,
 *     or the two calls crossed on the wire) → a short-lived tombstone makes
 *     the generation start already-aborted.
 * Tombstones are bounded in count and age: an id nobody ever generates must
 * not grow this map for the life of the runner.
 */
const TOMBSTONE_TTL_MS = 60_000
const TOMBSTONE_MAX = 256

export interface CancelHandle {
  readonly signal: AbortSignal
  /** Always call, in a `finally`. */
  end(): void
}

export class CancelRegistry {
  private readonly live = new Map<string, AbortController>()
  private readonly tombstones = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  begin(requestId: string | undefined): CancelHandle {
    const controller = new AbortController()
    if (requestId === undefined) return { signal: controller.signal, end: () => undefined }
    this.prune()
    if (this.tombstones.delete(requestId)) controller.abort()
    this.live.set(requestId, controller)
    return {
      signal: controller.signal,
      end: () => {
        if (this.live.get(requestId) === controller) this.live.delete(requestId)
      },
    }
  }

  /** `true` when a running generation was aborted; `false` = tombstoned. */
  cancel(requestId: string): boolean {
    const controller = this.live.get(requestId)
    if (controller !== undefined) {
      controller.abort()
      return true
    }
    this.prune()
    if (this.tombstones.size >= TOMBSTONE_MAX) {
      const oldest = this.tombstones.keys().next().value
      if (oldest !== undefined) this.tombstones.delete(oldest)
    }
    this.tombstones.set(requestId, this.now() + TOMBSTONE_TTL_MS)
    return false
  }

  /** Consume a tombstone for an id that is about to start; `true` = stop it. */
  takeTombstone(requestId: string): boolean {
    this.prune()
    return this.tombstones.delete(requestId)
  }

  private prune(): void {
    const now = this.now()
    for (const [id, expiresAt] of this.tombstones) {
      if (expiresAt <= now) this.tombstones.delete(id)
    }
  }
}
