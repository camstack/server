/**
 * Pure geometry for the **native subject tile** — the compressed, subject-sized
 * container that replaces retaining a whole native frame.
 *
 * > **NOT WIRED YET.** This module is Phase 1 of
 * > `docs/design/2026-08-13-native-lease-two-tier-redesign.md` and nothing
 * > imports it. It landed with the design because it is the piece whose failure
 * > is SILENT. If you find it still unimported after the next structural train,
 * > delete it — a helper nobody calls reads as verification of a design that
 * > was never built.
 *
 * ## What a tile is, and what it is emphatically not
 *
 * A tile is a **container**: the detection's box, padded generously, clamped
 * inside the frame and even-aligned, cut from the native surface at the one
 * instant the frame is still alive and kept as compressed bytes long after it
 * is gone.
 *
 * It is NOT a model input and it is NOT a crop convention. The rectangle a
 * model is fed is still derived in exactly one place — `deriveDetailCropRect`,
 * reached only through `pipeline-runner/detail-subtree.ts`'s `cutFromFullFrame`
 * ([D52](../../../../docs/decisions/adr-0052.md)) — and is then cut FROM the
 * tile raster instead of from a frame that no longer exists. Two paddings are
 * therefore never composed: the tile's padding decides only how much scene is
 * kept available, and the convention's padding decides the rectangle, exactly
 * as it does today against a full frame.
 *
 * ## The one rule this file exists to enforce
 *
 * **A tile serves a request only when it strictly CONTAINS the requested
 * rectangle.** Not clamps it, not stretches it, not re-pads it — contains it.
 * A rectangle clamped to fit inside a tile would enrich a *different* part of
 * the scene, land in the same vector index as correctly-cut neighbours, and
 * error nowhere: the exact shape of the defect D52 was written for. A
 * non-contained rectangle is a MISS, and the caller falls to the next rung
 * (re-decode from the recorded GOP).
 *
 * Geometry only: no pixels, no node-av, no process state.
 */
import { clampEven, type ResolvedRegion } from './crop-geometry.js'
import type { NormalizedBbox } from './video-frame-generator.js'

/**
 * How much scene is kept around the detection box, as a fraction of the box's
 * own width/height, applied on every side.
 *
 * Sized to sit comfortably above the detail-crop convention's own padding
 * (0.15 today, `DEFAULT_DETAIL_CROP_CONVENTION`) so the derived model rectangle
 * lands INSIDE the tile even after a track's box has drifted for a second or
 * two — which is precisely the interval a tile has to survive. Raising it costs
 * bytes quadratically; lowering it converts hits into misses. It is a default,
 * not a convention: nothing about a vector's meaning depends on it, because
 * nothing is ever encoded from the tile's own rectangle.
 */
export const NATIVE_TILE_PADDING_RATIO = 0.35

/** A tile's placement in the SOURCE frame, plus the padding it was cut with. */
export interface NativeTileRegion {
  /** Even-aligned region in source-frame pixels. */
  readonly region: ResolvedRegion
  /** The padding ratio actually applied (echoed for diagnostics/metrics). */
  readonly paddingRatio: number
}

/**
 * Resolve the tile container for one detection box.
 *
 * The box arrives NORMALISED against the analysis frame; the tile is expressed
 * in NATIVE frame pixels, because that is the raster the worker cuts from. Both
 * are the same scene at different scales, so the normalised box maps directly.
 *
 * Degenerate and out-of-frame inputs are handled by clamping to the frame — a
 * detection touching the edge yields a smaller tile, never a read past the
 * plane. A zero-area box widens to the 2px chroma minimum.
 */
export function resolveNativeTileRegion(
  frameWidth: number,
  frameHeight: number,
  bbox: NormalizedBbox,
  paddingRatio: number = NATIVE_TILE_PADDING_RATIO,
): NativeTileRegion {
  const pad = Number.isFinite(paddingRatio) && paddingRatio > 0 ? paddingRatio : 0
  const boxLeft = bbox.x * frameWidth
  const boxTop = bbox.y * frameHeight
  const boxWidth = bbox.w * frameWidth
  const boxHeight = bbox.h * frameHeight
  const padX = boxWidth * pad
  const padY = boxHeight * pad

  const rawLeft = Math.max(0, boxLeft - padX)
  const rawTop = Math.max(0, boxTop - padY)
  const rawRight = Math.min(frameWidth, boxLeft + boxWidth + padX)
  const rawBottom = Math.min(frameHeight, boxTop + boxHeight + padY)

  const left = clampEven(Math.floor(rawLeft), 0, Math.max(0, frameWidth - 2))
  const top = clampEven(Math.floor(rawTop), 0, Math.max(0, frameHeight - 2))
  const width = clampEven(Math.ceil(rawRight) - left, 2, frameWidth - left)
  const height = clampEven(Math.ceil(rawBottom) - top, 2, frameHeight - top)

  return { region: { left, top, width, height }, paddingRatio: pad }
}

/**
 * Whether `rect` lies wholly inside `tile` — the serve gate.
 *
 * Deliberately strict and deliberately boolean: there is no "close enough"
 * verdict, because the caller's only two honest options are to cut the exact
 * rectangle or to report a miss. Touching the tile's edge counts as inside; a
 * single pixel past it does not.
 */
export function tileContains(tile: ResolvedRegion, rect: ResolvedRegion): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false
  return (
    rect.left >= tile.left &&
    rect.top >= tile.top &&
    rect.left + rect.width <= tile.left + tile.width &&
    rect.top + rect.height <= tile.top + tile.height
  )
}

/**
 * Translate a FRAME-space rectangle into TILE-space, or `null` when the tile
 * does not contain it.
 *
 * `null` is the miss the caller reports; it must never be turned into a clamp.
 * The returned rectangle is a pure translation — no scaling, no re-alignment —
 * so a caller that cut `rect` from the full frame and a caller that cuts the
 * translated rectangle from the tile obtain the same pixels.
 */
export function rectWithinTile(tile: ResolvedRegion, rect: ResolvedRegion): ResolvedRegion | null {
  if (!tileContains(tile, rect)) return null
  return {
    left: rect.left - tile.left,
    top: rect.top - tile.top,
    width: rect.width,
    height: rect.height,
  }
}

/** A tile that can serve a request, and the request's rectangle inside it. */
export interface TileServe<T extends { readonly region: ResolvedRegion }> {
  readonly tile: T
  /** `rect` translated into the tile's own raster coordinates. */
  readonly local: ResolvedRegion
}

/**
 * Pick the tile that can serve `rect`, or `null` when none contains it.
 *
 * Smallest containing tile wins: a tighter container means less scene around
 * the subject and therefore a smaller decode, and among tiles that all satisfy
 * the containment rule the choice cannot affect the pixels — every one of them
 * would yield the same rectangle of the same frame.
 *
 * `null` is a MISS the caller reports and falls through on. It must never
 * become "use the closest tile and clamp": see this module's header.
 */
export function selectTileForRect<T extends { readonly region: ResolvedRegion }>(
  tiles: readonly T[],
  rect: ResolvedRegion,
): TileServe<T> | null {
  let best: TileServe<T> | null = null
  let bestArea = Number.POSITIVE_INFINITY
  for (const tile of tiles) {
    const local = rectWithinTile(tile.region, rect)
    if (local === null) continue
    const area = tile.region.width * tile.region.height
    if (area >= bestArea) continue
    bestArea = area
    best = { tile, local }
  }
  return best
}

/**
 * Approximate RESIDENT bytes of a tile once encoded, for the store's budget.
 *
 * A rough bits-per-pixel estimate rather than a measurement, because the budget
 * has to be applied BEFORE the encode decides the real size — the same reason
 * the frame lease sizes itself from `width × height × bytesPerPixel` rather
 * than from what it later observes. `bitsPerPixel` defaults to a conservative
 * JPEG q85 figure for photographic content; the store should correct its tally
 * with the real length once the encode returns.
 */
export function estimateTileBytes(region: ResolvedRegion, bitsPerPixel = 1.2): number {
  const pixels = Math.max(0, region.width) * Math.max(0, region.height)
  return Math.ceil((pixels * bitsPerPixel) / 8)
}
