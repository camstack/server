/** Internal crop source from the decode worker. Public cap cannot name `tile`. */
export type NativeCropPixelSource = 'lease' | 'tile'

/**
 * Raw rgb24 pixels resolved by {@link ../pipeline-runner/index.PipelineRunner.getNativeCrop}.
 */
export interface NativeCropPixels {
  bytes: Uint8Array
  width: number
  height: number
  /** Worker source. Absent/lease → nativeHits; tile → tileHits. */
  source?: NativeCropPixelSource
}

/**
 * Which source `getNativeCrop` may serve for a `(isFullFrame, nativeHit)` pair.
 * - `native`  — the native-resolution surface HIT (the quality path; always wins).
 * - `ram-fullframe` — native missed BUT the request is a full-frame resolve, so the
 *   ≤640 RAM `RetainedFrameStore` is a legitimate lower-RES fallback (blank-frame
 *   guard / 640-snapshot resolve).
 * - `miss` — native missed on an ROI (subject-crop). The caller MUST report the
 *   miss and retry; it must NEVER be handed a ≤640 crop masquerading as a native
 *   subject crop (Task S1 — removes the RC-2 floor's reason to exist).
 */
export type NativeCropTier = 'native' | 'ram-fullframe' | 'miss'

/**
 * Pure tier decision for `getNativeCrop`. A native HIT always resolves to the
 * native surface. On a native MISS, only a full-frame request falls back to the
 * ≤640 RAM store; an ROI miss is reported as `miss` (no quality masquerade).
 */
export function resolveNativeCropSource(isFullFrame: boolean, nativeHit: boolean): NativeCropTier {
  if (nativeHit) return 'native'
  return isFullFrame ? 'ram-fullframe' : 'miss'
}

/**
 * Runtime hit kind for telemetry. A worker tile is native-resolution quality
 * (public wire `tier` stays `native`) but must not increment `nativeHits`.
 */
export function resolveNativeCropHitKind(source?: NativeCropPixelSource): 'native' | 'tile' {
  return source === 'tile' ? 'tile' : 'native'
}

export type NativeCropRuntimeSource = 'native' | 'tile' | 'ram-fullframe' | 'miss'

/**
 * Public cap `tier` is `native | ram-fullframe`. Tile is native-res, so it
 * maps to `native` on the wire. Documented Task 3 review constraint.
 */
export function toPublicNativeCropTier(
  source: NativeCropRuntimeSource,
): 'native' | 'ram-fullframe' | undefined {
  if (source === 'miss') return undefined
  if (source === 'ram-fullframe') return 'ram-fullframe'
  return 'native'
}

/**
 * WHY a native-lease resolve produced nothing. There are FOUR failures behind
 * one `null` and they have four different fixes:
 *
 * - `no-registry-entry` — the node-wide handle registry never held (or has
 *   already LRU-evicted) this handle. The window is too small, or the request
 *   arrived long after the frame.
 * - `handle-expired` — the registry HELD the handle and REFUSED it: the ask
 *   arrived past `NATIVE_CROP_LEASE_MAX_AGE_MS` (ADR-0419), so no round trip
 *   was made. Distinct from `worker-lease-gone` on purpose — that one is
 *   "the frame was gone when we asked", this one is "we declined to ask,
 *   because the answer could only have been that". 332 lines in 54 minutes
 *   read as the former and were the latter; sharing a word is how the next
 *   person re-measures the same number. The fix for this one is never a
 *   bigger cap, it is whoever is asking that late.
 * - `worker-lease-gone` — the registry still knows the handle, but the decode
 *   worker no longer holds the frame AND no retained subject tile contains the
 *   requested rectangle, so the ROI can no longer be cut at native resolution.
 * - `jpeg-encode-failed` — pixels were resolved and the in-process encode threw.
 *   Distinct because it is the only one that is NOT a timing problem.
 *
 * Returned to the caller rather than logged and dropped: the runner knows the
 * reason and the caller knows the round-trip, and until 2026-08-07 the two
 * halves of that pair were never visible at the same log level.
 */
export type NativeCropMissReason =
  | 'no-registry-entry'
  | 'handle-expired'
  | 'worker-lease-gone'
  | 'jpeg-encode-failed'

/** A native-lease resolve that produced no pixels, with the reason. */
export interface NativeCropMiss {
  readonly miss: NativeCropMissReason
  /** How long the handle had been REGISTERED when the crop was asked for
   *  (same process, same clock). `null` when there was no registry entry. */
  readonly handleAgeMs: number | null
  /**
   * The WORKER's own sentence, when it answered at all.
   *
   * `worker-lease-gone` is one word over four failures with four different
   * fixes: nothing retained for the frame, a rectangle no retained tile
   * contains, retention switched off, and a cut that outran its encode. The
   * worker has always named them precisely and the string has always been
   * dropped on the floor — it reached only an untagged `debug` line, so a
   * `deviceId`-scoped query returned misses and no reasons and every miss in a
   * 3 h window read identical. Diagnostic only: nothing branches on this text,
   * and it is absent when the registry itself had no entry (no worker was
   * reached to have an opinion).
   */
  readonly workerReason?: string
}
