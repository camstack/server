/**
 * `RetainedFrameStore` — the RAM replacement for the `csr.` shm retention ring
 * (shm-ring removal, 2026-07-16). See
 * `docs/design/2026-07-16-shm-removal-one-process-design.md`.
 *
 * ## Why RAM, not `/dev/shm`
 *
 * The old retention path copied every decoded rgb detection frame into a
 * per-session `DecoderFrameRingSink` (a `/dev/shm` ring), shipped the resulting
 * zero-pixel `FrameHandle` on the inference-result event, and let hub-side
 * post-analysis read the pixels back — co-located via a shm reader, cross-node
 * via `decoder.getFrame`. That made `@camstack/shm-ring` (the last NATIVE
 * host-external) a hard dependency of the detection data plane, which broke the
 * Electron/Mac runners and blocked npm publishes.
 *
 * This store keeps the SAME contract — retain a decoded rgb frame, hand back a
 * `FrameHandle`, resolve pixels by handle later — but the pixels live in the
 * Node heap and are served over tRPC (`pipelineRunner.getNativeCrop`, routed by
 * `handle.nodeId`). Same-node that call is in-process / UDS; cross-node it is
 * Moleculer. No native module, no `/dev/shm`, no orphan-segment purge.
 *
 * ## Node-level, per-device-fair, budget-bounded
 *
 * ONE store per runner node (like {@link NativeCropRegistry}) so `getNativeCrop`
 * can resolve a handle produced by ANY session. The `FrameHandle` schema is
 * UNCHANGED (wire-compat with old addons); `shmId` is repurposed from a
 * `/dev/shm` segment name to an opaque RAM key.
 *
 * ## Why a per-device floor (the busy-node starvation fix, 2026-07-19)
 *
 * The frame a track's media capture references is resolved LATE — after
 * detection inference, the cross-process inference-result event hop to hub-side
 * post-analysis, tracking, and a tRPC round-trip back to `getNativeCrop`
 * (typically 150-500 ms end to end). A pure global latest-wins FIFO shares ONE
 * byte budget across EVERY camera on the node, so a busy neighbour's frame
 * stream evicts an in-flight frame before its own late capture runs. On a
 * multi-camera node this drops event/thumbnail media entirely (resolve → null →
 * `kinds:[]`), concentrated on the busiest outdoor cameras — they add the most
 * eviction pressure AND take the longest to enrich (most concurrent tracks).
 *
 * The store therefore guarantees each device its {@link perDeviceFloor} MOST
 * RECENT frames regardless of how many frames other cameras push: budget
 * eviction drops the globally-oldest frame whose device still holds MORE than
 * its floor first, and only falls back to evicting a floor-protected frame when
 * the hard byte ceiling is genuinely exhausted (OOM guard wins over fairness).
 * `perDeviceFloor === 0` restores the pure global-FIFO behaviour. Memory stays
 * bounded by `budgetBytes` — the floor never grows retention past the ceiling.
 */
import type { DecodedFrame, FrameHandle, IScopedLogger } from '@camstack/types'

/**
 * Retained-frame RAM budget (MB): 160. A lazy contain ≤640 slot reserves the aspect-agnostic
 * worst case (640×640 RGB, ~1.23 MB) so 4:3/square never overflow; a 16:9
 * hydrate later settles to 640×360. At that worst-case slot the 160 MB budget
 * is ~130 frames — enough for a ~15-camera node to keep each camera's
 * {@link RETAINED_FRAME_PER_DEVICE_FLOOR} recent frames alive through the
 * end-to-end enrichment horizon (was 32 MB / ~46 frames, which starved the
 * busiest cameras under multi-camera load — see class doc).
 *
 * The docblock said 96 MB until 2026-08-07 while the literal read 160 — a
 * leftover that reads as verification. The number matters now that this store,
 * not the decode worker's 1.2 s native lease, is what a detail dispatch falls
 * back to (`runDetailSubtree({ frameJpeg })`).
 */
export const RETAINED_FRAME_BUDGET_MB = 160

/** {@link RETAINED_FRAME_BUDGET_MB} in bytes. */
export const RETAINED_FRAME_BUDGET_BYTES = RETAINED_FRAME_BUDGET_MB * 1024 * 1024

/**
 * How many of each device's MOST RECENT frames are protected from a busy
 * neighbour's budget eviction. Sized to cover the late two-plane / cross-process
 * enrichment horizon (~150-500 ms) at the REAL delivered rate: the store writes
 * every DELIVERED rgb frame, and a high-fps camera delivers ~25 fps (observed on
 * the 4K outdoor cams), so the old floor of 6 protected only ~240 ms there and
 * its late captures hit "frame recycled before resolve" (2026-07-22 triage —
 * missing thumbnails/firstFrames concentrated on exactly those cameras).
 * 16 frames ≈ 0.64 s @25 fps (1.6 s @10 fps). Only ACTIVE cameras hold frames,
 * so the worst-case protected footprint stays well inside the byte budget for
 * realistic concurrency (4 active cams ≈ 44 MB of 160); the hard ceiling always
 * overrides the floor regardless.
 */
export const RETAINED_FRAME_PER_DEVICE_FLOOR = 16

/**
 * TIME-based per-device protection (2026-07-23 cold-window fix): a frame
 * YOUNGER than this survives budget eviction regardless of how many frames
 * its device holds. The COUNT floor above protects a fixed number of frames —
 * but the wall-clock window that buys depends on the delivered fps (16 frames
 * = 1.6 s @10 fps but only 0.64 s @25 fps, and the 4K street cams deliver
 * ~25). The late-capture horizon is TIME (session attach + enrichment +
 * round-trip ≈ 0.5–1.5 s, worst on cold on-motion dials), so the guarantee
 * must be time-denominated: 12/13 of the zero-media/missing-firstFrame tracks
 * in the 2026-07-23 audit were ≤6 s cold-session subjects whose handles were
 * recycled before their first captures ran. Bounded by the hard byte ceiling
 * (pass 2) exactly like the count floor — worst case ~26 MB per ACTIVE camera
 * @25 fps.
 */
export const RETAINED_FRAME_TIME_FLOOR_MS = 3_000

/** Opaque RAM-key prefix stamped into a retained frame's `FrameHandle.shmId`. */
export const RETAINED_FRAME_KEY_PREFIX = 'ram:' as const

/** A normalized [0,1] crop rectangle — mirrors the `getNativeCrop` bbox shape. */
export interface NormalizedCropBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Raw-RGB crop result — mirrors the `getNativeCrop` cap return shape. */
export interface RetainedCropResult {
  readonly bytes: Uint8Array
  readonly width: number
  readonly height: number
}

/**
 * On-demand content-sized pixels for a handle written from a pixel-free
 * `frameRef`. Must not invent a cross-process ref; Task 3 decides whether
 * this ram-fullframe rung remains after telemetry.
 */
export interface RetainedContentFallback {
  materialize(): Promise<DecodedFrame | null>
  release?(): void
  /**
   * Hold the frame as a CONSUMER for a read about to happen (D656): a parked
   * frame does not keep its decode worker alive, a reader does. Returns the
   * release, or `null` when there is nothing left to hold.
   */
  holdReader?(): (() => void) | null
}

export interface RetainedFrameStoreOptions {
  /** Cluster node id of the runner owning this store — stamped into every handle. */
  readonly nodeId: string
  readonly logger: IScopedLogger
  /** Byte budget override (tests); defaults to {@link RETAINED_FRAME_BUDGET_BYTES}. */
  readonly budgetBytes?: number
  /**
   * Per-device retention floor override (tests); defaults to
   * {@link RETAINED_FRAME_PER_DEVICE_FLOOR}. `0` = pure global FIFO.
   */
  readonly perDeviceFloor?: number
  /** Time-floor override (tests); defaults to {@link RETAINED_FRAME_TIME_FLOOR_MS}.
   *  `0` disables the time guarantee (count floor only). */
  readonly timeFloorMs?: number
  /** Clock override (tests). */
  readonly now?: () => number
  /** Fired when budget eviction drops an entry (not an explicit `drop`). */
  readonly onEvict?: (deviceId: number) => void
}

/** A retention frame is uniquely identified by its key + slot + committed seq. */
function keyOf(handle: Pick<FrameHandle, 'shmId' | 'slot' | 'seq'>): string {
  return `${handle.shmId}#${handle.slot}#${handle.seq}`
}

/**
 * Node-level RAM store of retained rgb detection frames, keyed by
 * `FrameHandle` identity. Latest-wins with a byte budget.
 */
/** One retained frame plus the device it belongs to (for the per-device floor). */
/**
 * Reserved footprint of a lazy contain ≤640 RGB view. Worst-case square
 * 640×640×3 so 4:3 and portrait never exceed the reservation; 16:9 hydrates
 * later settle to 640×360.
 */
export const CONTENT_SIZED_RESERVE_BYTES = 640 * 640 * 3

interface RetainedEntry {
  frame: DecodedFrame
  readonly deviceId: number
  /** Wall-clock at write — drives the TIME floor (cold-window fix). */
  readonly writtenAt: number
  reservedBytes: number
  fallback?: RetainedContentFallback
  hydrating?: Promise<DecodedFrame | null>
}

export class RetainedFrameStore {
  private readonly nodeId: string
  private readonly budgetBytes: number
  private readonly perDeviceFloor: number
  private readonly timeFloorMs: number
  private readonly now: () => number
  private readonly onEvict?: (deviceId: number) => void
  /** Insertion-ordered (Map) → globally oldest is `keys().next()`. */
  private readonly entries = new Map<string, RetainedEntry>()
  /**
   * Per-device insertion-ordered keys (oldest→newest). Mirrors {@link entries}
   * so the floor can be enforced in O(1) per eviction candidate without scanning
   * the global map for a device's frame count.
   */
  private readonly perDeviceKeys = new Map<number, string[]>()
  private bytes = 0
  private seq = 0
  /** Ring width used only to spread the `slot` field; the map key is authoritative. */
  private static readonly SLOT_SPREAD = 1024

  constructor(options: RetainedFrameStoreOptions) {
    this.nodeId = options.nodeId
    this.budgetBytes = options.budgetBytes ?? RETAINED_FRAME_BUDGET_BYTES
    this.perDeviceFloor = options.perDeviceFloor ?? RETAINED_FRAME_PER_DEVICE_FLOOR
    this.timeFloorMs = options.timeFloorMs ?? RETAINED_FRAME_TIME_FLOOR_MS
    this.now = options.now ?? Date.now
    this.onEvict = options.onEvict
  }

  /** Number of retained frames (tests / metrics). */
  get size(): number {
    return this.entries.size
  }

  /** Total retained bytes (tests / metrics). */
  get retainedBytes(): number {
    return this.bytes
  }

  /**
   * Retain one decoded rgb frame and return its `FrameHandle`. Returns `null`
   * for a non-rgb frame (motion gray is never retained — post-analysis crops
   * from the rgb frame). The frame buffer is retained by reference: the
   * decode-worker IPC delivers a fresh Buffer per frame, so no defensive copy
   * is needed.
   */
  write(
    deviceId: number,
    frame: DecodedFrame,
    fallback?: RetainedContentFallback,
  ): FrameHandle | null {
    if (frame.format !== 'rgb') return null
    const pixelFree = frame.data.byteLength === 0
    const handle = this.mintHandle(deviceId, frame)
    const reservedBytes = pixelFree ? CONTENT_SIZED_RESERVE_BYTES : handle.byteLength
    this.insert(handle, {
      frame,
      deviceId,
      writtenAt: this.now(),
      reservedBytes,
      ...(pixelFree && fallback ? { fallback } : {}),
    })
    return handle
  }

  /**
   * Identity-only handle for native hold/tile. Does not retain pixels or
   * reserve the content-sized worst-case slot — Task 3 continuous path.
   */
  allocateHandle(deviceId: number, frame: DecodedFrame): FrameHandle | null {
    if (frame.format !== 'rgb') return null
    return this.mintHandle(deviceId, frame)
  }

  /**
   * Remember a detection-only on-demand fallback. Reserves the content-sized
   * worst case until hydrate replaces it with the real JPEG/RGB bytes so the
   * budget can evict unrequested detections. A no-detection frame must never
   * call this.
   */
  rememberOnDemand(deviceId: number, handle: FrameHandle, fallback: RetainedContentFallback): void {
    const key = keyOf(handle)
    if (this.entries.has(key)) return
    this.insert(handle, {
      frame: {
        data: Buffer.alloc(0),
        width: handle.width,
        height: handle.height,
        format: 'rgb',
        timestamp: 0,
      },
      deviceId,
      writtenAt: this.now(),
      reservedBytes: CONTENT_SIZED_RESERVE_BYTES,
      fallback,
    })
  }

  has(handle: Pick<FrameHandle, 'shmId' | 'slot' | 'seq'>): boolean {
    return this.entries.has(keyOf(handle))
  }

  getDeviceId(handle: Pick<FrameHandle, 'shmId' | 'slot' | 'seq'>): number | undefined {
    return this.entries.get(keyOf(handle))?.deviceId
  }

  statsByDevice(deviceId: number): { readonly entries: number; readonly bytes: number } {
    const keys = this.perDeviceKeys.get(deviceId) ?? []
    let bytes = 0
    for (const key of keys) bytes += this.entries.get(key)?.reservedBytes ?? 0
    return { entries: keys.length, bytes }
  }

  deviceStats(): ReadonlyArray<{
    readonly deviceId: number
    readonly entries: number
    readonly bytes: number
  }> {
    return [...this.perDeviceKeys.keys()].map((deviceId) => ({
      deviceId,
      ...this.statsByDevice(deviceId),
    }))
  }

  /** Drop one handle (success/error/drop/detach). Idempotent. */
  drop(handle: Pick<FrameHandle, 'shmId' | 'slot' | 'seq'>): void {
    this.dropKey(keyOf(handle))
  }

  /** The retained frame for `handle`, or `null` if never retained / already evicted. */
  getFrame(handle: Pick<FrameHandle, 'shmId' | 'slot' | 'seq'>): DecodedFrame | null {
    return this.entries.get(keyOf(handle))?.frame ?? null
  }

  /**
   * Crop (and optionally downscale) the retained rgb frame for `handle` to the
   * normalized `bbox`. A full-frame `bbox` ({x:0,y:0,w:1,h:1}) with no
   * `maxWidth` returns the whole frame. Returns `null` when the frame is no
   * longer retained. Nearest-neighbour scale — this is the best-effort
   * post-analysis fallback path; native-resolution ROI crops come from the
   * decode worker's surface (`getNativeCrop`), not here.
   */
  crop(
    handle: Pick<FrameHandle, 'shmId' | 'slot' | 'seq'>,
    bbox: NormalizedCropBbox,
    maxWidth?: number,
  ): RetainedCropResult | null {
    const entry = this.entries.get(keyOf(handle))
    if (!entry || entry.frame.data.byteLength === 0) return null
    if (entry.frame.format === 'jpeg') {
      const isFullFrame = bbox.x <= 0.001 && bbox.y <= 0.001 && bbox.w >= 0.999 && bbox.h >= 0.999
      if (!isFullFrame) return null
      return { bytes: entry.frame.data, width: entry.frame.width, height: entry.frame.height }
    }
    if (entry.frame.format !== 'rgb') return null
    return cropRgb(entry.frame, bbox, maxWidth)
  }

  /**
   * Full-frame / ROI crop that hydrates a pixel-free handle on demand.
   * A missing fallback or failed materialize is an explicit miss — never a
   * 0-byte raster.
   */
  async cropAsync(
    handle: Pick<FrameHandle, 'shmId' | 'slot' | 'seq'>,
    bbox: NormalizedCropBbox,
    maxWidth?: number,
  ): Promise<RetainedCropResult | null> {
    await this.ensureContent(handle)
    return this.crop(handle, bbox, maxWidth)
  }

  /** Materialize a content-sized RGB view once, if the handle still has a fallback. */
  async ensureContent(
    handle: Pick<FrameHandle, 'shmId' | 'slot' | 'seq'>,
  ): Promise<DecodedFrame | null> {
    const key = keyOf(handle)
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.frame.data.byteLength > 0) return entry.frame
    if (entry.hydrating) return entry.hydrating
    if (!entry.fallback) return null
    entry.hydrating = this.hydrate(key, entry)
    try {
      return await entry.hydrating
    } finally {
      const current = this.entries.get(key)
      if (current) current.hydrating = undefined
    }
  }

  /**
   * Hold `handle`'s parked frame as a reader until the returned release runs
   * (D656). `null` when the handle has no un-hydrated fallback — bytes already
   * in RAM need no worker.
   */
  holdReader(handle: Pick<FrameHandle, 'shmId' | 'slot' | 'seq'>): (() => void) | null {
    return this.entries.get(keyOf(handle))?.fallback?.holdReader?.() ?? null
  }

  /** Drop every retained frame (node/addon shutdown). */
  clear(): void {
    for (const entry of this.entries.values()) entry.fallback?.release?.()
    this.entries.clear()
    this.perDeviceKeys.clear()
    this.bytes = 0
  }

  /**
   * Evict frames until the retained bytes fit the budget (keep ≥1).
   *
   * Pass 1 (fairness): walk globally oldest→newest and drop only frames whose
   * device still holds MORE than {@link perDeviceFloor} frames — so a busy
   * camera's excess is reclaimed before any camera's protected recent window.
   * Pass 2 (OOM guard): if still over budget (every remaining frame is
   * floor-protected yet the ceiling is exhausted), drop globally oldest-first
   * regardless of the floor. The ceiling ALWAYS wins over fairness.
   */
  private evictToBudget(): void {
    if (this.bytes <= this.budgetBytes) return
    // Snapshot the global-oldest order once; both passes consume from it and
    // skip keys already dropped (deletes during Map iteration are otherwise fine,
    // but a stable snapshot keeps the two-pass logic obvious).
    const oldestFirst = [...this.entries.keys()]
    // Pass 1 — reclaim frames outside BOTH floors (always keep ≥1): the COUNT
    // floor (device's N most recent) and the TIME floor (frames younger than
    // the late-capture horizon survive regardless of fps — 2026-07-23
    // cold-window fix: a 25 fps camera burned the 16-frame count floor in
    // 0.64 s, under the enrichment round-trip on cold on-motion sessions).
    const nowMs = this.now()
    for (const key of oldestFirst) {
      if (this.bytes <= this.budgetBytes || this.entries.size <= 1) break
      const entry = this.entries.get(key)
      if (!entry) continue
      if (this.timeFloorMs > 0 && nowMs - entry.writtenAt < this.timeFloorMs) continue
      const deviceKeys = this.perDeviceKeys.get(entry.deviceId)
      if (deviceKeys && deviceKeys.length > this.perDeviceFloor) this.dropKey(key, 'evict')
    }
    if (this.bytes <= this.budgetBytes) return
    // Pass 1b — still over budget: the TIME floor yields to COUNT-floor
    // FAIRNESS. Reclaim young-but-beyond-count-floor frames (a flooding
    // camera's excess) before ever touching another device's protected
    // window — the time floor guards against NEIGHBOUR pressure only while
    // the budget allows it, never at the cost of per-device fairness.
    for (const key of oldestFirst) {
      if (this.bytes <= this.budgetBytes || this.entries.size <= 1) break
      const entry = this.entries.get(key)
      if (!entry) continue
      const deviceKeys = this.perDeviceKeys.get(entry.deviceId)
      if (deviceKeys && deviceKeys.length > this.perDeviceFloor) this.dropKey(key, 'evict')
    }
    if (this.bytes <= this.budgetBytes) return
    // Pass 2 — hard ceiling: drop oldest regardless of floor (keep ≥1).
    for (const key of oldestFirst) {
      if (this.bytes <= this.budgetBytes || this.entries.size <= 1) break
      this.dropKey(key, 'evict')
    }
    if (this.bytes < 0) this.bytes = 0
  }

  private async hydrate(key: string, entry: RetainedEntry): Promise<DecodedFrame | null> {
    const view = await entry.fallback?.materialize()
    const current = this.entries.get(key)
    if (!current) return null
    if (!view || view.data.byteLength === 0) return null
    if (view.format !== 'rgb' && view.format !== 'jpeg') return null
    current.frame = view
    current.fallback = undefined
    this.bytes -= current.reservedBytes
    current.reservedBytes = view.data.byteLength
    this.bytes += current.reservedBytes
    this.evictToBudget()
    return view
  }

  private mintHandle(deviceId: number, frame: DecodedFrame): FrameHandle {
    const seq = ++this.seq
    const pixelFree = frame.data.byteLength === 0
    return {
      shmId: `${RETAINED_FRAME_KEY_PREFIX}${this.nodeId}:${deviceId}`,
      slot: seq % RetainedFrameStore.SLOT_SPREAD,
      seq,
      width: frame.width,
      height: frame.height,
      format: 'rgb',
      pts: performance.now(),
      byteLength: pixelFree ? 0 : frame.data.byteLength,
      nodeId: this.nodeId,
      slotCount: RetainedFrameStore.SLOT_SPREAD,
    }
  }

  private insert(handle: FrameHandle, entry: RetainedEntry): void {
    const key = keyOf(handle)
    this.entries.set(key, entry)
    const deviceKeys = this.perDeviceKeys.get(entry.deviceId)
    if (deviceKeys) deviceKeys.push(key)
    else this.perDeviceKeys.set(entry.deviceId, [key])
    this.bytes += entry.reservedBytes
    this.evictToBudget()
  }

  /** Remove one frame by key, keeping the byte tally + per-device index exact. */
  private dropKey(key: string, reason: 'drop' | 'evict' = 'drop'): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    entry.fallback?.release?.()
    this.bytes -= entry.reservedBytes
    const deviceKeys = this.perDeviceKeys.get(entry.deviceId)
    if (deviceKeys) {
      const idx = deviceKeys.indexOf(key)
      if (idx >= 0) deviceKeys.splice(idx, 1)
      if (deviceKeys.length === 0) this.perDeviceKeys.delete(entry.deviceId)
    }
    if (reason === 'evict') this.onEvict?.(entry.deviceId)
  }
}

/**
 * Nearest-neighbour crop + optional downscale of a packed RGB24 frame to a
 * normalized `bbox`. Exported for unit coverage. Clamps the bbox into the frame
 * and never allocates more than the output size.
 */
export function cropRgb(
  frame: DecodedFrame,
  bbox: NormalizedCropBbox,
  maxWidth?: number,
): RetainedCropResult {
  const srcW = frame.width
  const srcH = frame.height
  // Clamp the normalized rect into [0,1] and into at least one pixel.
  const nx = Math.min(Math.max(bbox.x, 0), 1)
  const ny = Math.min(Math.max(bbox.y, 0), 1)
  const nw = Math.min(Math.max(bbox.w, 0), 1 - nx)
  const nh = Math.min(Math.max(bbox.h, 0), 1 - ny)
  const cropX = Math.floor(nx * srcW)
  const cropY = Math.floor(ny * srcH)
  const cropW = Math.max(1, Math.round(nw * srcW))
  const cropH = Math.max(1, Math.round(nh * srcH))
  const clampedW = Math.min(cropW, srcW - cropX)
  const clampedH = Math.min(cropH, srcH - cropY)

  // Output size: downscale to maxWidth (aspect-preserving) when narrower.
  const outW = maxWidth && maxWidth > 0 && maxWidth < clampedW ? maxWidth : clampedW
  const outH = outW === clampedW ? clampedH : Math.max(1, Math.round((outW * clampedH) / clampedW))
  const src = frame.data
  const out = Buffer.allocUnsafe(outW * outH * 3)
  for (let oy = 0; oy < outH; oy += 1) {
    const sy = cropY + Math.min(clampedH - 1, Math.floor((oy * clampedH) / outH))
    const srcRow = sy * srcW * 3
    const outRow = oy * outW * 3
    for (let ox = 0; ox < outW; ox += 1) {
      const sx = cropX + Math.min(clampedW - 1, Math.floor((ox * clampedW) / outW))
      const s = srcRow + sx * 3
      const o = outRow + ox * 3
      out[o] = src[s]!
      out[o + 1] = src[s + 1]!
      out[o + 2] = src[s + 2]!
    }
  }
  return { bytes: out, width: outW, height: outH }
}
