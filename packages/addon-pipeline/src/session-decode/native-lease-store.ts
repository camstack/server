/**
 * Bounded RAM **hold** store for native detection frames — the window in which
 * a delivered frame is still cuttable, replacing the tiny GPU-surface ring as
 * the default.
 *
 * ## Why this exists (vs `native-frame-ring.ts`)
 *
 * The native-crop request for a detection frame arrives CROSS-PROCESS from the
 * detection-pipeline executor ~2-5 frames after the frame shipped (after
 * detection inference ~40-160ms). The original `NativeFrameRing` retained the
 * frame as a **GPU/VAAPI surface**, which pins a slot out of the decoder's
 * surface pool — the historic leak site — so it was hard-capped at depth 2. By
 * the time the crop arrived the surface was almost always evicted (~85% miss),
 * and face embeddings fell back to the downscaled crop.
 *
 * This store instead holds a **RAM copy** of the native frame (the decode
 * worker downloads it out of the GPU pool ONCE per shipped detection frame,
 * then the GPU surface follows its normal lifecycle). RAM retention has no
 * VAAPI-pool starvation risk, so the survival window can be sized by a RAM
 * BUDGET plus a hold COUNT rather than a 2-frame ring — the crop reliably
 * hits while the frame is still awaited.
 *
 * ## Lifetime — an EVENT, not a clock (2026-08-13)
 *
 * A held frame lives from {@link put} until the FIRST of:
 *  - {@link release} — the runner has this frame's `FrameResult`, has cut the
 *    subject tiles it wanted, and is done with the raster. This is the ordinary
 *    exit and it is the whole design: the frame was waiting for one specific
 *    event, so that event is what ends the wait.
 *  - the **hold bound** (`maxFrames`) evicts the OLDEST when a newer frame
 *    arrives — the backstop for a runner that stopped answering;
 *  - the **RAM budget** evicts oldest-first past `budgetBytes` — the OOM guard;
 *  - {@link clear} on re-dial / teardown.
 *
 * There is deliberately NO TTL. A time window was never related to the event
 * the pixels were waiting for: measured on this cluster the late crop arrived
 * 2.2-9.9 s after the frame, so any TTL small enough to bound RAM was already
 * too small to hit, and the 1024 MB ceiling bound first anyway
 * (`leaseMb:1020, leaseFrames:43` on every 4K camera). What survives the frame
 * now is the compressed subject tile, not the raster — see
 * `native-tile-store.ts` and
 * `docs/design/2026-08-13-native-lease-two-tier-redesign.md`.
 *
 * ## Budget 0 = disabled
 *
 * `budgetBytes <= 0` turns the store OFF: {@link put} frees the frame
 * immediately and returns `false` (caller-declined ownership, exactly like
 * `NativeFrameRing.retain` when disabled) so the worker falls back to today's
 * GPU-surface ring. This is the "keep the lease off" knob
 * (`CAMSTACK_SESSION_NATIVE_LEASE_BUDGET_MB=0`).
 *
 * Generic over the minimal {@link LeasedNativeFrame} shape (a byte size + a
 * `free()`), so it is unit-testable without node-av.
 */

/** The minimal shape the lease store retains — a byte size + a disposer. */
export interface LeasedNativeFrame {
  /** Approximate resident size in bytes — the RAM budget is measured in these. */
  readonly byteLength: number
  /** Release the underlying resource (free a node-av frame; a no-op for a plain buffer). */
  free(): void
}

/** Options for {@link NativeLeaseStore}. */
export interface NativeLeaseStoreOptions {
  /** Hard RAM budget in bytes; `<= 0` disables the store (see class doc). */
  readonly budgetBytes: number
  /**
   * Hard bound on how many frames are held at once. Above it the OLDEST held
   * frame is dropped — the backstop for a runner that never releases, never
   * the ordinary path.
   */
  readonly maxFrames: number
  /** Injectable clock (tests). Defaults to `Date.now` — used only for age reporting. */
  readonly now?: () => number
  /**
   * Told the frameId of every frame a BOUND evicted (never a release). The
   * owner uses it to say which of those were frames inference had not read
   * yet — the pre-roll `preRollEvicted` count (D652).
   */
  readonly onEvict?: (frameId: number) => void
}

/** One held frame plus the wall time it was inserted (diagnostics only). */
interface LeaseEntry<F extends LeasedNativeFrame> {
  readonly frame: F
  readonly insertedAt: number
}

/**
 * A count- and byte-bounded, release-driven map from worker frameId → held RAM
 * frame. Insertion-ordered (`Map`), so every eviction is FIFO by age.
 */
export class NativeLeaseStore<F extends LeasedNativeFrame> {
  private readonly entries = new Map<number, LeaseEntry<F>>()
  private readonly budgetBytes: number
  private readonly maxFrames: number
  private readonly now: () => number
  private readonly onEvict: ((frameId: number) => void) | undefined
  private bytes = 0
  /**
   * Frames dropped because the hold bound or the byte ceiling was reached
   * before their release arrived. Non-zero means the runner is not keeping up —
   * a different sentence from "the crop was late", and the reason this is a
   * counter and not a silent eviction.
   */
  private overflowed = 0

  constructor(options: NativeLeaseStoreOptions) {
    this.budgetBytes = options.budgetBytes
    this.maxFrames = Math.max(1, options.maxFrames)
    this.now = options.now ?? Date.now
    this.onEvict = options.onEvict
  }

  /** Frames dropped by a bound rather than released (tests / metrics). */
  get overflowCount(): number {
    return this.overflowed
  }

  /** `false` when the store is disabled (`budgetBytes <= 0`). */
  get enabled(): boolean {
    return this.budgetBytes > 0
  }

  /** Number of retained leases (tests / metrics). */
  get size(): number {
    return this.entries.size
  }

  /** Total resident bytes across all retained leases (tests / metrics). */
  get totalBytes(): number {
    return this.bytes
  }

  /**
   * Take ownership of `frame` under `frameId`. Returns `true` when the store
   * took ownership (caller MUST NOT free), `false` when the store is disabled
   * (`budgetBytes <= 0`) and the frame was freed here — the caller then keeps
   * today's GPU-surface-ring path. Sweeps expired leases first, then evicts the
   * oldest while the total exceeds the budget.
   */
  put(frameId: number, frame: F): boolean {
    if (!this.enabled) {
      frame.free()
      return false
    }
    // A duplicate frameId should never occur (frameIds are monotonic), but free
    // the prior holder defensively rather than leak it.
    this.drop(frameId)
    this.entries.set(frameId, { frame, insertedAt: this.now() })
    this.bytes += frame.byteLength
    // Both bounds evict the OLDEST, and both are counted: an eviction here is
    // always a frame whose result never came back, which is the one thing this
    // store can say about the runner's health.
    while (
      (this.entries.size > this.maxFrames || this.bytes > this.budgetBytes) &&
      this.entries.size > 0
    ) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      if (oldest === frameId) break // never evict the frame just admitted
      this.overflowed += 1
      this.drop(oldest)
      this.onEvict?.(oldest)
    }
    return true
  }

  /**
   * The held frame for `frameId`, or `null` if never held or already
   * released/evicted. No age check: a frame is held until an EVENT ends the
   * hold, and a store that also expired on a clock would reintroduce the
   * unreachable window this design removed.
   */
  get(frameId: number): F | null {
    return this.entries.get(frameId)?.frame ?? null
  }

  /** How long `frameId` has been held, or `null` when it is not held. */
  ageMs(frameId: number): number | null {
    const entry = this.entries.get(frameId)
    return entry ? this.now() - entry.insertedAt : null
  }

  /**
   * Free + drop the hold for `frameId` — the runner has this frame's result and
   * has taken what it wanted. Idempotent, and the ORDINARY exit.
   */
  release(frameId: number): boolean {
    const held = this.entries.has(frameId)
    this.drop(frameId)
    return held
  }

  /** Free + drop every held frame. Idempotent (re-dial + teardown call it). */
  clear(): void {
    for (const entry of this.entries.values()) entry.frame.free()
    this.entries.clear()
    this.bytes = 0
  }

  /** Free + remove one entry, keeping the byte tally exact. */
  private drop(frameId: number): void {
    const entry = this.entries.get(frameId)
    if (!entry) return
    this.entries.delete(frameId)
    this.bytes -= entry.frame.byteLength
    entry.frame.free()
  }
}
