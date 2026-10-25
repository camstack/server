/**
 * The SCENE tile — R2's missing half, and the rung a FULL-FRAME native request
 * lands on after the hold has ended.
 *
 * ## The gap this closes
 *
 * The two-tier redesign (2026-08-13) made a held raster live from delivery until
 * its `FrameResult`, and made a compressed subject TILE what survives it. Every
 * late consumer was moved onto tiles — except the ones that ask for the whole
 * frame, because `selectTileForRect` is STRICT CONTAINMENT (and must be: a
 * clamped rectangle enriches a different part of the scene and errors nowhere).
 * A subject tile can never contain the full-frame rectangle, so those consumers
 * had no rung at all below the hold:
 *
 *  - the native `keyFrame` capture (then `getNativeKeyFrameRgb`, bbox
 *    `{0,0,1,1}`, `maxWidth 4096`) — the only image a semantic rebuild reads.
 *    Retired since D422: the key frame is a PARKED parcel, not a by-handle
 *    fetch;
 *  - the detail plane's `runDetailSubtree({ frameJpeg })` rung;
 *  - the display-crop full-frame fallback.
 *
 * Measured on the live cluster over 24 h: 874 of 3 750 key-frame captures
 * (23.3%) ended `native-miss`, and 855 of the 893 corresponding runner-side
 * `native full-frame miss` lines carried `nativeMissReason: worker-lease-gone`
 * — 95.7%. Only 38 (4.3%) were `no-registry-entry`, i.e. an actually recycled
 * handle. The requests were not late in any exotic sense either: the handle age
 * at the miss was p50 367 ms, p75 1.0 s, p90 4.3 s. The pixels were simply gone
 * one frame-time after delivery, and nothing below the hold could answer.
 *
 * ## Why a tile and not a longer hold
 *
 * Because of what the numbers cost. A held 4K raster is 23.75 MB (measured:
 * `leaseMb:190, leaseFrames:8`), the admitted rate is ~2.1 frames/s per camera,
 * and concurrency is 4.3 sessions typical / 12 at peak. Holding rasters for the
 * operator's 10 s window is 21 frames × 23.75 MB ≈ 498 MB PER CAMERA, ~6 GB at
 * peak — precisely the OOM that [D9](../../../../docs/decisions/adr-0009.md) and
 * [D18](../../../../docs/decisions/adr-0018.md) exist to prevent.
 *
 * A scene tile is the same pixels, JPEG-encoded once at the instant the subject
 * tiles are cut: ~1.5-2.5 MB at 4K, and only on a frame that actually detected
 * something (measured ~0.4 such frames/s per camera, not 2.1). The same 10 s
 * costs ~10-25 MB per camera instead of 498 MB, and the existing tile TTL
 * (30 s) already covers p99 (15 s).
 *
 * ## Why its own store
 *
 * The scene tile gets a SEPARATE {@link NativeTileStore} instance with its own
 * budget rather than riding in the subject store. A scene tile is 20× a subject
 * tile, so sharing one budget would mean a busy camera's key frames evict the
 * face/plate tiles the recognisers depend on — starving a working tier to feed
 * a new one. Two stores make that structurally impossible; the arithmetic that
 * exhausts one cannot reach the other.
 */
import type { ResolvedRegion } from './crop-geometry.js'
import { selectTileForRect } from './native-tile-geometry.js'
import type { NativeTile } from './native-tile-store.js'
import type { NormalizedBbox } from './worker-protocol.js'

/**
 * The whole frame, in the same normalized space every other cut uses. Identical
 * to the bbox `getNativeCrop`'s full-frame callers send, which is the point —
 * the rectangle asked for and the rectangle retained are the same one.
 */
export const SCENE_TILE_BBOX: NormalizedBbox = { x: 0, y: 0, w: 1, h: 1 }

/** What one frame's cut should read, and whether a scene tile is among it. */
export interface FrameCutPlan {
  /** Every rectangle to copy out of the frame, in ONE synchronous read phase. */
  readonly bboxes: readonly NormalizedBbox[]
  /** True when {@link SCENE_TILE_BBOX} was appended. */
  readonly scene: boolean
}

/** The two independent conditions under which a frame gets a scene tile. */
export interface SceneCutConditions {
  /** The scene rung is on (`sceneBudgetMb > 0`). */
  readonly sceneEnabled: boolean
  /**
   * This frame carried at least one detection.
   *
   * Kept SEPARATE from the subject list, which is what the SUBJECT store wants
   * and is empty whenever that store is disabled. Collapsing the two would make
   * `tileBudgetMb: 0` silently switch off the scene rung as well — two
   * independent operator knobs, one of them secretly gating the other.
   */
  readonly hasDetections: boolean
}

/**
 * Plan one frame's cut.
 *
 * The scene rectangle is appended to the SAME cut rather than taken separately,
 * because `subject-tile-cut.ts` reads every rectangle in one synchronous turn:
 * a second read after the first cut's encodes have awaited is exactly the
 * eviction window that once cut subject 1 of each frame and lost the rest.
 *
 * A frame that detected NOTHING gets nothing, scene tile included. That
 * asymmetry is what keeps this tier affordable — the frames a key-frame capture
 * can ever name are the frames that carried a best detection, and on this
 * cluster those are ~0.4/s per camera against ~2.1/s delivered.
 */
export function planFrameCuts(
  subjects: readonly NormalizedBbox[],
  conditions: SceneCutConditions,
): FrameCutPlan {
  if (!conditions.sceneEnabled || !conditions.hasDetections) {
    return { bboxes: subjects, scene: false }
  }
  return { bboxes: [...subjects, SCENE_TILE_BBOX], scene: true }
}

/**
 * Does this region cover the whole frame?
 *
 * Judged on the RESOLVED region rather than on the position in the cut list,
 * because `cutSubjectTiles` drops a rectangle whose read or encode failed and
 * positional identity does not survive that. Unknown frame dimensions (a freed
 * node-av frame reports 0×0) are `false` — classifying against those would file
 * every subject tile as the scene.
 */
export function isSceneRegion(
  region: ResolvedRegion,
  frameWidth: number,
  frameHeight: number,
): boolean {
  if (frameWidth <= 0 || frameHeight <= 0) return false
  return (
    region.left <= 0 &&
    region.top <= 0 &&
    region.width >= frameWidth &&
    region.height >= frameHeight
  )
}

/** One frame's cut result, split between the two stores that retain it. */
export interface PartitionedTiles {
  readonly subjects: readonly NativeTile[]
  readonly scene: NativeTile | null
}

/**
 * Route each cut tile to the store that owns it.
 *
 * The FIRST frame-spanning tile is the scene; any later one stays a subject. A
 * padded subject that already covers the frame genuinely IS the scene, and both
 * stores are consulted on a serve, so claiming one of them costs no hit and
 * keeps the two stores from holding the same pixels twice.
 */
export function partitionSceneTile(
  tiles: readonly NativeTile[],
  frameWidth: number,
  frameHeight: number,
): PartitionedTiles {
  const subjects: NativeTile[] = []
  let scene: NativeTile | null = null
  for (const tile of tiles) {
    if (scene === null && isSceneRegion(tile.region, frameWidth, frameHeight)) {
      scene = tile
      continue
    }
    subjects.push(tile)
  }
  return { subjects, scene }
}

/** Which retained rung answered a request. On the metrics line as `sceneHits`. */
export type RetainedTileSource = 'subject' | 'scene'

/** A served rectangle: the tile it came from, where inside it, and which rung. */
export interface RetainedTileServe {
  readonly tile: NativeTile
  readonly local: ResolvedRegion
  readonly source: RetainedTileSource
}

/**
 * Pick the retained tile that CONTAINS `rect`, subject tiles first.
 *
 * The order is the whole of the policy and it is not cosmetic. Both rungs are
 * native-resolution, so either would be honest — but a subject tile is
 * ~60-120 KB against a scene tile's ~1.5-2.5 MB, and the extract runs on
 * whatever it is handed. Asking the subject store first keeps an ordinary
 * face/plate crop off the 20×-larger raster; the scene tile is consulted only
 * for the rectangles no subject tile could ever contain, which is exactly the
 * set that had no rung at all before it existed.
 *
 * `null` means no retained rung contains the rectangle — a MISS, never a clamp
 * into the nearest tile ([D52](../../../../docs/decisions/adr-0052.md)).
 */
export function selectRetainedTile(
  subjects: readonly NativeTile[],
  scenes: readonly NativeTile[],
  rect: ResolvedRegion,
): RetainedTileServe | null {
  const fromSubject = selectTileForRect(subjects, rect)
  if (fromSubject) return { tile: fromSubject.tile, local: fromSubject.local, source: 'subject' }
  const fromScene = selectTileForRect(scenes, rect)
  if (fromScene) return { tile: fromScene.tile, local: fromScene.local, source: 'scene' }
  return null
}
