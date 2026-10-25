/**
 * Node-level registry that maps a retention-ring {@link FrameHandle} to the
 * best-effort {@link NativeCropRequester} bound to the decode worker still
 * holding that frame's NATIVE surface.
 *
 * ## Why
 *
 * The retention-ring handle that rides the inference-result event to hub-side
 * post-analysis is a `csr.` shm reference to the DOWNSCALED detection frame.
 * The NATIVE surface for the same frame lives (briefly) in the per-session
 * decode worker, keyed by an IPC-only frameId post-analysis never sees. This
 * registry is the correlation: when a native crop is requested for a handle,
 * the runner looks the handle up here and calls the requester, which round-trips
 * to the worker for a native-res crop of just the ROI. A miss (handle not
 * registered, or the worker's tiny native ring already evicted the frame)
 * yields `null` and the caller falls back to the detection-frame crop.
 *
 * Bounded LRU (insertion-ordered `Map`): stale entries for torn-down sessions
 * are harmless — their requester returns `null` (worker exited) — and evict
 * naturally. Each entry is a tiny closure; the actual native-frame RAM lives in
 * the worker's TTL+budget-bounded lease store, so a generous cap costs almost
 * nothing here.
 *
 * ## Cap sized to the TILE window (2026-09-05), not the lease window (2026-07-19)
 *
 * This is a NODE-LEVEL registry shared by every camera. A native-crop request
 * arrives LATE (cross-process from hub post-analysis, after inference and
 * tracking — 150-500 ms typically, seconds when the hub is busy). The entry is
 * the ONLY way that request reaches the worker: the worker serves the held
 * frame while the hold lasts (~1 s), and its retained TILES for 30 s after
 * (`NATIVE_TILE_TTL_MS`). So the cap must hold the handles registered within
 * the TILE window, on the busiest node.
 *
 * The 2026-07-19 fix raised 64 → 256 against the LEASE window (~1 s). That
 * was right for the hold and wrong for the tiles: at ~80 handles/s on
 * `hub/detection` (ten cameras × ~8 delivered fps) 256 entries are 3.2 s, and
 * on 2026-09-05 7 579 `no-registry-entry` misses a day were requests for
 * frames whose tiles were still retained and unreachable. 4096 covers 30 s at
 * 136 handles/s. Each entry is one closure; the pixels live in the worker's
 * own TTL+budget-bounded stores, so the cap costs nothing there.
 *
 * ## The AGE bound is what actually decides retention now (2026-09-09, ADR-0419)
 *
 * The cap above is no longer the binding constraint and must not be treated as
 * one. An entry is refused and released at
 * {@link NATIVE_CROP_LEASE_MAX_AGE_MS} (10 s) — see `native-crop-lease-age.ts`
 * for the measurement (332 `worker-lease-gone` misses in 54 minutes at a median
 * handle age of 30 099 ms, with this registry pinned at 4096/4096) and for why
 * the bound is enforced HERE and not at the requester or the worker. The
 * capacity remains as a safety ceiling for a node that registers faster than
 * 409 handles/s; if it ever binds again, the answer is still not a bigger
 * number.
 */
import type { FrameHandle } from '@camstack/types'
import {
  classifyNativeCropLeaseAge,
  NATIVE_CROP_LEASE_MAX_AGE_MS,
} from './native-crop-lease-age.js'
import type { NativeCropRequester } from './session-decode-pump.js'

/** How long a worker keeps a frame's tiles — the window the registry must outlive. */
export const NATIVE_CROP_REGISTRY_WINDOW_MS = 30_000
/** Handles registered per second on the busiest node measured (hub, 2026-09-05: ~80). */
export const NATIVE_CROP_REGISTRY_BUSIEST_NODE_HANDLES_PER_S = 120

/**
 * Default max entries retained across all active decode sessions on a node
 * (64 → 256 → 4096; see the class doc for the two windows the cap has been
 * sized to).
 */
export const DEFAULT_NATIVE_CROP_REGISTRY_CAP = 4096

/** Invoke a requester's best-effort `release()`, swallowing any transport error. */
function safeRelease(request: NativeCropRequester): void {
  try {
    request.release()
  } catch {
    // Best-effort: the worker may already be gone — the lease self-expires anyway.
  }
}

/**
 * What a registry entry knows beyond the requester closure. `FrameHandle`
 * carries neither a deviceId nor a wall-clock stamp (its `pts` is explicitly
 * process-local and non-correlatable), so the ONLY place these two facts exist
 * together is registration time — captured here so a miss can be logged
 * per-camera and with the request latency that decides which window is too
 * small.
 */
interface NativeCropEntry {
  readonly request: NativeCropRequester
  readonly deviceId: number
  /** Local `Date.now()` at registration — same clock as the miss log. */
  readonly registeredAt: number
}

/**
 * What a lookup answers. THREE outcomes, not two, because they have three
 * different fixes and a `null` collapsed the last two into one:
 *
 * - `live` — the handle is registered and inside
 *   {@link NATIVE_CROP_LEASE_MAX_AGE_MS}. The only outcome that may reach the
 *   decode worker.
 * - `expired` — registered, but older than the bound. REFUSED here, in
 *   process, in front of the round trip: 332 of these paid a cross-process
 *   fetch to be told a 30-second-old frame is gone. The entry is dropped and
 *   its worker-side lease released on the way out — it can never be served
 *   again, so keeping it is pure retention.
 * - `unknown` — never registered, or already evicted/swept. The window was too
 *   small, or the handle is foreign.
 */
export type NativeCropLookup =
  | {
      readonly kind: 'live'
      readonly request: NativeCropRequester
      readonly deviceId: number
      readonly ageMs: number
    }
  | { readonly kind: 'expired'; readonly deviceId: number; readonly ageMs: number }
  | { readonly kind: 'unknown' }

export class NativeCropRegistry {
  private readonly entries = new Map<string, NativeCropEntry>()

  constructor(
    private readonly capacity: number = DEFAULT_NATIVE_CROP_REGISTRY_CAP,
    /** The age bound. Injectable for the spec that pins the boundary, never
     *  for tuning — see `native-crop-lease-age.ts` on why it is not a knob. */
    private readonly maxAgeMs: number = NATIVE_CROP_LEASE_MAX_AGE_MS,
  ) {}

  /** Number of registered handles (tests / metrics). */
  get size(): number {
    return this.entries.size
  }

  /** A retention frame is uniquely identified by its segment + slot + committed seq. */
  private key(handle: FrameHandle): string {
    return `${handle.shmId}#${handle.slot}#${handle.seq}`
  }

  /**
   * Bind `request` to `handle`; evicts the oldest entry past the cap, releasing
   * its worker-side RAM lease so a lease never outlives its registry entry.
   */
  register(handle: FrameHandle, request: NativeCropRequester, deviceId: number): void {
    this.sweepExpired()
    const k = this.key(handle)
    // Re-insert to move to newest (Map keeps insertion order).
    this.entries.delete(k)
    this.entries.set(k, { request, deviceId, registeredAt: Date.now() })
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.releaseEntry(oldest, 'capacity')
    }
  }

  /**
   * Resolve `handle`, applying the age bound (ADR-0419).
   *
   * The bound is applied HERE and not at the caller or the worker because this
   * is the only place `registeredAt` exists — see `native-crop-lease-age.ts`.
   * An expired handle is refused and released without the requester ever being
   * invoked, so the doomed cross-process fetch does not happen at all.
   */
  lookup(handle: FrameHandle): NativeCropLookup {
    const key = this.key(handle)
    const entry = this.entries.get(key)
    if (entry === undefined) {
      // Swept by age before this ask arrived (or refused by an earlier ask):
      // still a REFUSAL, with the age the refusal line needs. Returning
      // `unknown` here is how 20 980 refusals in two hours logged as an
      // ageless `no-registry-entry` miss while the refusal counter read 79
      // (2026-09-09, ADR-0420).
      const swept = this.sweptByAge.get(key)
      if (swept === undefined) return { kind: 'unknown' }
      return { kind: 'expired', deviceId: swept.deviceId, ageMs: Date.now() - swept.registeredAt }
    }
    const ageMs = Date.now() - entry.registeredAt
    if (classifyNativeCropLeaseAge(ageMs, this.maxAgeMs) === 'expired') {
      this.releaseEntry(key, 'age')
      return { kind: 'expired', deviceId: entry.deviceId, ageMs }
    }
    return { kind: 'live', request: entry.request, deviceId: entry.deviceId, ageMs }
  }

  /**
   * Drop every entry past the age bound, oldest first.
   *
   * The map is insertion-ordered and insertion order IS registration order, so
   * the head is the oldest and the walk stops at the first live entry. Run on
   * every `register`, which is the only path that reliably ticks on a busy
   * node — a timer here would be a second owner of the same lifetime.
   *
   * It can never drop an entry a request would have been served from: anything
   * it releases would have been refused by {@link lookup} in the same instant.
   * What it buys is that the worker's lease is released when it stops being
   * useful (10 s) instead of when 4 095 later handles have pushed it out of a
   * capacity eviction (~30 s on this cluster) — the reason the registry sat
   * pinned at `4096/4096`.
   */
  private sweepExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.entries) {
      if (classifyNativeCropLeaseAge(now - entry.registeredAt, this.maxAgeMs) === 'live') return
      this.releaseEntry(key, 'age')
    }
  }

  /**
   * The deviceId a handle was registered under, even AFTER its entry was
   * evicted — kept in a small parallel ring so a `no-registry-entry` miss can
   * still be attributed to a camera (a miss line without `deviceId` cannot
   * answer "why is 102 worse than 101?").
   */
  deviceIdFor(handle: FrameHandle): number | null {
    const key = this.key(handle)
    return (
      this.evictedDeviceIds.get(key) ??
      this.sweptByAge.get(key)?.deviceId ??
      this.entries.get(key)?.deviceId ??
      null
    )
  }

  /**
   * Release the worker-side RAM native lease for `handle` and drop its entry —
   * the caller is done cutting native crops from that frame. Best-effort +
   * idempotent (an unknown handle is a no-op; the lease also self-expires).
   */
  release(handle: FrameHandle): void {
    this.releaseEntry(this.key(handle))
  }

  /** Drop every entry, releasing each frame's worker-side lease (node/addon shutdown). */
  clear(): void {
    for (const entry of this.entries.values()) safeRelease(entry.request)
    this.entries.clear()
    this.evictedDeviceIds.clear()
    this.sweptByAge.clear()
  }

  /**
   * Release + drop one entry by its map key, remembering WHY it left.
   *
   * `age` — past the lease bound (a `lookup` refusal or a `register` sweep):
   * remembered with its registration clock, so a later ask for the same
   * handle is still answered `expired` with a real age. `capacity` — the cap
   * bound and pushed it out; `released` — the caller was done with it. Those
   * two stay `unknown` on a later ask: neither is a late ask, and folding
   * them into the refusal count would make the bound look tighter than it is.
   */
  private releaseEntry(key: string, cause: NativeCropDropCause = 'released'): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    if (cause === 'age') {
      this.rememberSweptByAge(key, entry)
    } else {
      this.rememberEvicted(key, entry.deviceId)
    }
    safeRelease(entry.request)
  }

  /** Bounded memory of evicted handles → deviceId, for miss attribution. */
  private readonly evictedDeviceIds = new Map<string, number>()

  private rememberEvicted(key: string, deviceId: number): void {
    this.evictedDeviceIds.set(key, deviceId)
    while (this.evictedDeviceIds.size > this.capacity) {
      const oldest = this.evictedDeviceIds.keys().next().value
      if (oldest === undefined) break
      this.evictedDeviceIds.delete(oldest)
    }
  }

  /**
   * Bounded memory of handles the AGE bound dropped, with the clock the
   * refusal is measured from. Same capacity as the live map: at the busiest
   * node's rate that is one more lease window of memory, after which a
   * refusal degrades to `unknown` — an ask that late is not a bound question.
   */
  private readonly sweptByAge = new Map<string, SweptEntry>()

  private rememberSweptByAge(key: string, entry: NativeCropEntry): void {
    this.sweptByAge.set(key, { deviceId: entry.deviceId, registeredAt: entry.registeredAt })
    while (this.sweptByAge.size > this.capacity) {
      const oldest = this.sweptByAge.keys().next().value
      if (oldest === undefined) break
      this.sweptByAge.delete(oldest)
    }
  }
}

/** Why an entry left the live map — see {@link NativeCropRegistry.releaseEntry}. */
type NativeCropDropCause = 'age' | 'capacity' | 'released'

/** What the registry keeps of a handle the age bound dropped. */
interface SweptEntry {
  readonly deviceId: number
  readonly registeredAt: number
}
