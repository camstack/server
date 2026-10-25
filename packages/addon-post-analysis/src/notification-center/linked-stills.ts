/**
 * The linked-camera shelf — the photographs a SENSOR notification carries of
 * every camera that links the sensor (ADR 0632).
 *
 * Same three properties as the still shelf (`still-shelf.ts`), for the same
 * reasons: not a record (RAM, TTL, no timeline track), the capture starts at the
 * trigger and is never awaited (owner ids minted synchronously), and nothing is
 * silent (one line per camera with its outcome, one per event on the sensor).
 * A separate module because the unit is a SET: exclusion, freshness and the
 * one composition are decisions about the set, and none of them belongs in a
 * shelf that photographs one camera for an absence.
 *
 * Two reads can only ever ADD a camera back, never take one away on their own
 * failure (D49): a wrapper-state read (run in parallel with the capture) that
 * misses or throws keeps the tile, and a freshness read that misses or throws
 * keeps every tile. Only a read that ANSWERED
 * `sleeping` / `disabled` / … or a capture time older than
 * {@link SENSOR_LINKED_MAX_FRAME_AGE_MS} removes a tile — and says so, on that
 * camera.
 */
import { randomUUID } from 'node:crypto'
import type { IScopedLogger, MediaFileBytes } from '@camstack/types'
import sharp from 'sharp'
import {
  downscaleFullFrameJpeg,
  SYNTHETIC_SNAPSHOT_MAX_HEIGHT,
  SYNTHETIC_SNAPSHOT_MAX_WIDTH,
} from '../shared/frame/downscale-full-frame.js'
import { NC_STILL_SHELF_TTL_MS, stillShelfMedia } from './still-shelf.js'
import { renderMosaic } from './summary/mosaic-renderer.js'

const NC_LINKED_MOSAIC_PREFIX = 'nc-mosaic:'
const NC_LINKED_CAMERA_PREFIX = 'nc-linked:'

export function isLinkedStillId(id: string): boolean {
  return id.startsWith(NC_LINKED_MOSAIC_PREFIX) || id.startsWith(NC_LINKED_CAMERA_PREFIX)
}

/** Per camera — the marker's own bound (`SENSOR_MARKER_SNAPSHOT_TIMEOUT_MS`). */
const SENSOR_LINKED_CAPTURE_TIMEOUT_MS = 2_500

/** The capture-free wrapper-state read, per camera. It runs IN PARALLEL with
 *  the capture and under the capture's own bound, so it costs no extra time and
 *  a slow-but-honest answer is still heard: a blocking reason EXCLUDES the tile
 *  even when the capture returned bytes (they are a state card, not a
 *  photograph). A read that misses the bound or fails is UNKNOWN and keeps the
 *  tile (D49). */
const SENSOR_LINKED_STATE_READ_TIMEOUT_MS = SENSOR_LINKED_CAPTURE_TIMEOUT_MS

/** The one cache-only freshness read for the set — one hop, after the
 *  captures. A read that misses it keeps every tile and says `freshness
 *  unverified` (D49). */
const SENSOR_LINKED_FRESHNESS_READ_TIMEOUT_MS = 400

/** The worst case before composition starts: (state read ∥ capture) → freshness
 *  read. The dispatcher's still-wait (`NC_STILL_WAIT_MS`, 3 s) starts at
 *  DISPATCH — after the evaluation that follows `captureSet` — not at
 *  `captureSet`, so the downscale and the one composition run in that slack
 *  plus what is left under 3 s; neither is measured here. */
export const SENSOR_LINKED_READ_BUDGET_MS =
  Math.max(SENSOR_LINKED_STATE_READ_TIMEOUT_MS, SENSOR_LINKED_CAPTURE_TIMEOUT_MS) +
  SENSOR_LINKED_FRESHNESS_READ_TIMEOUT_MS

/** A cached frame older than this before the event is not "at the trigger". The
 *  mains cache max age (`snapshot.addon.ts`), so a healthy camera always passes. */
const SENSOR_LINKED_MAX_FRAME_AGE_MS = 10_000

/** Hard bound on sets held at once, on top of the TTL. */
const MAX_SETS = 32

export type NcLinkedExclusionReason = 'offline' | 'disabled' | 'sleeping' | 'unreachable' | 'waking'
/** Why a wrapper-state read said nothing: too slow, threw, or answered empty. */
export type NcLinkedStateUnknown = 'timeout' | 'error' | 'empty'
export type NcLinkedTileOutcome = 'landed' | 'excluded' | 'timeout' | 'empty' | 'error' | 'stale'

export interface NcLinkedStills {
  readonly sensorId: number
  /** Tile order; [0] is the primary camera. */
  readonly cameraIds: readonly number[]
  readonly mosaicOwnerId: string
  /** Same order as {@link cameraIds}. */
  readonly cameraOwnerIds: readonly string[]
}

/** One compressed still as the snapshot cap returns it. */
export interface NcLinkedSnapshot {
  readonly base64: string
  readonly contentType: string
}

/** Capture-free wrapper state; `null` reason = capturable. */
export interface NcLinkedSnapshotState {
  readonly reason: NcLinkedExclusionReason | null
}

export interface NcLinkedStillShelfDeps {
  /** Never `force` — a forced capture wakes a battery camera. */
  readonly getSnapshot: (deviceId: number) => Promise<NcLinkedSnapshot | null>
  /** Capture-free wrapper state; null reason = capturable. Throws/undefined when unknown. */
  readonly getSnapshotState?: (deviceId: number) => Promise<NcLinkedSnapshotState | undefined>
  /** Cache-only: when each camera's cached frame was captured (null = none). */
  readonly getFrameCapturedAt?: (
    deviceIds: readonly number[],
  ) => Promise<ReadonlyMap<number, number | null>>
  /** The NC directory's liveness mirror; false = offline, undefined = unknown. */
  readonly isOnline: (deviceId: number) => boolean | undefined
  readonly logger: IScopedLogger
  readonly now: () => number
}

interface HeldSet {
  readonly stills: NcLinkedStills
  readonly expiresAt: number
  readonly atMs: number
  /** cameraId → its still, minted ONCE when the set is composed. */
  readonly tiles: ReadonlyMap<number, readonly MediaFileBytes[]>
  /** The composed (or single-tile) picture; empty until composed, forever if none. */
  readonly mosaic: readonly MediaFileBytes[]
}

interface OwnerRef {
  readonly setId: string
  readonly camera: number | 'mosaic'
}

interface TileResult {
  readonly cameraId: number
  readonly outcome: NcLinkedTileOutcome
  readonly jpeg?: Buffer
  readonly reason?: string
  /** Why the wrapper-state read gave no answer; the tile was kept anyway (D49). */
  readonly stateUnknown?: NcLinkedStateUnknown
  readonly tookMs: number
}

/** What the wrapper said: a reason to exclude, or nothing — and whether it said at all. */
interface WrapperVerdict {
  readonly reason: NcLinkedExclusionReason | null
  readonly unknown: NcLinkedStateUnknown | null
}

/** One capture's result before the wrapper's verdict is applied. */
interface CaptureResult {
  readonly outcome: 'landed' | 'timeout' | 'empty' | 'error'
  readonly jpeg?: Buffer
  readonly reason?: string
}

/** The set's pictures after composition: the mosaic, and the tiles each camera serves. */
interface ComposedSet {
  readonly mosaic: readonly MediaFileBytes[]
  readonly servable: readonly LandedTile[]
  /** Tiles the picture actually shows. */
  readonly drawn: number
}

interface LandedTile extends TileResult {
  readonly jpeg: Buffer
}

function isLandedTile(r: TileResult): r is LandedTile {
  return r.outcome === 'landed' && r.jpeg !== undefined
}

class LinkedReadTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${String(ms)}ms`)
    this.name = 'LinkedReadTimeout'
  }
}

export class NcLinkedStillShelf {
  private readonly deps: NcLinkedStillShelfDeps
  private readonly sets = new Map<string, HeldSet>()
  private readonly owners = new Map<string, OwnerRef>()

  constructor(deps: NcLinkedStillShelfDeps) {
    this.deps = deps
  }

  /** SYNCHRONOUS: the evaluation that follows names these owners. */
  captureSet(sensorId: number, cameraIds: readonly number[], atMs: number): NcLinkedStills {
    const now = this.deps.now()
    this.prune(now)
    const setId = randomUUID()
    const stills: NcLinkedStills = {
      sensorId,
      cameraIds: [...cameraIds],
      mosaicOwnerId: `${NC_LINKED_MOSAIC_PREFIX}${randomUUID()}`,
      cameraOwnerIds: cameraIds.map(() => `${NC_LINKED_CAMERA_PREFIX}${randomUUID()}`),
    }
    this.sets.set(setId, {
      stills,
      expiresAt: now + NC_STILL_SHELF_TTL_MS,
      atMs,
      tiles: new Map(),
      mosaic: [],
    })
    this.owners.set(stills.mosaicOwnerId, { setId, camera: 'mosaic' })
    stills.cameraOwnerIds.forEach((ownerId, i) => {
      const cameraId = cameraIds[i]
      if (cameraId !== undefined) this.owners.set(ownerId, { setId, camera: cameraId })
    })
    this.run(setId, stills, atMs, now).catch((err: unknown) => {
      this.deps.logger.warn('sensor notification pictures failed — it ships text-only', {
        tags: { deviceId: sensorId },
        meta: { error: String(err) },
      })
    })
    return stills
  }

  /** `undefined` = not an owner this shelf minted (or pruned); `[]` = nothing (yet). */
  get(ownerId: string): readonly MediaFileBytes[] | undefined {
    const ref = this.owners.get(ownerId)
    if (ref === undefined) return undefined
    const held = this.sets.get(ref.setId)
    if (held === undefined) return []
    if (ref.camera === 'mosaic') return held.mosaic
    return held.tiles.get(ref.camera) ?? []
  }

  prune(now: number): void {
    for (const [setId, held] of this.sets) if (held.expiresAt <= now) this.sets.delete(setId)
    while (this.sets.size > MAX_SETS) {
      const oldest = this.sets.keys().next()
      if (oldest.done === true) break
      this.sets.delete(oldest.value)
    }
    for (const [ownerId, ref] of this.owners) {
      if (!this.sets.has(ref.setId)) this.owners.delete(ownerId)
    }
  }

  clear(): void {
    this.sets.clear()
    this.owners.clear()
  }

  private async run(
    setId: string,
    stills: NcLinkedStills,
    atMs: number,
    startedAt: number,
  ): Promise<void> {
    const results = await Promise.all(stills.cameraIds.map((id) => this.captureOne(id, startedAt)))
    const judged = await this.judgeFreshness(stills.sensorId, results, atMs)
    for (const r of judged) this.logTile(stills.sensorId, r)
    const landed = judged.filter(isLandedTile)
    const composed = await this.compose(stills.sensorId, landed, atMs)
    const undrawable = landed.length - composed.drawn
    this.deps.logger.info(
      composed.mosaic.length === 0
        ? 'sensor notification has no linked picture — it ships text-only'
        : 'sensor notification pictures ready',
      {
        tags: { deviceId: stills.sensorId },
        meta: {
          cameras: stills.cameraIds.length,
          landed: composed.drawn,
          ...(undrawable > 0 ? { undrawable } : {}),
          dropped: Object.fromEntries(
            judged
              .filter((r) => r.outcome !== 'landed')
              .map((r) => [String(r.cameraId), r.outcome]),
          ),
          tookMs: this.deps.now() - startedAt,
        },
      },
    )
    const held = this.sets.get(setId)
    // Pruned while capturing: the notification that named it is long gone.
    if (held === undefined) return
    this.sets.set(setId, {
      ...held,
      tiles: new Map(composed.servable.map((r) => [r.cameraId, stillShelfMedia(r.jpeg, atMs)])),
      mosaic: composed.mosaic,
    })
  }

  private async captureOne(cameraId: number, startedAt: number): Promise<TileResult> {
    const took = (): number => this.deps.now() - startedAt
    if (this.deps.isOnline(cameraId) === false) {
      return { cameraId, outcome: 'excluded', reason: 'offline', tookMs: took() }
    }
    // In parallel: the state read costs no time of its own, and its answer is
    // applied to whatever the capture brought back.
    const [verdict, capture] = await Promise.all([
      this.wrapperVerdict(cameraId),
      this.captureStill(cameraId),
    ])
    if (verdict.reason !== null) {
      // The bytes, if any, are the wrapper's state card — never a photograph.
      return {
        cameraId,
        outcome: 'excluded',
        reason: verdict.reason,
        tookMs: took(),
      }
    }
    return {
      cameraId,
      ...capture,
      ...(verdict.unknown !== null ? { stateUnknown: verdict.unknown } : {}),
      tookMs: took(),
    }
  }

  private async captureStill(cameraId: number): Promise<CaptureResult> {
    try {
      const shot = await withTimeout(
        this.deps.getSnapshot(cameraId),
        SENSOR_LINKED_CAPTURE_TIMEOUT_MS,
        'snapshot cap',
      )
      if (shot === null || shot.base64.length === 0) return { outcome: 'empty' }
      const jpeg = await this.decodableStill(Buffer.from(shot.base64, 'base64'))
      if (jpeg === null) return { outcome: 'error', reason: 'undecodable' }
      return { outcome: 'landed', jpeg }
    } catch (err: unknown) {
      return {
        outcome: err instanceof LinkedReadTimeout ? 'timeout' : 'error',
        reason: String(err),
      }
    }
  }

  /**
   * The downscaled still, or null when the bytes are not a picture. A resize
   * that fails on bytes sharp can still READ keeps them raw (a worse picture,
   * never a missing one); bytes it cannot read never ship — a decode failure is
   * a fact about the bytes, not a failed read.
   */
  private async decodableStill(raw: Buffer): Promise<Buffer | null> {
    try {
      return await downscaleFullFrameJpeg(
        raw,
        SYNTHETIC_SNAPSHOT_MAX_WIDTH,
        SYNTHETIC_SNAPSHOT_MAX_HEIGHT,
      )
    } catch {
      try {
        await sharp(raw).metadata()
        return raw
      } catch {
        return null
      }
    }
  }

  /** A failed, slow or empty read is UNKNOWN and never excludes (D49); the
   *  camera's own outcome line then carries `stateUnknown` with the cause. */
  private async wrapperVerdict(cameraId: number): Promise<WrapperVerdict> {
    const read = this.deps.getSnapshotState
    if (read === undefined) return { reason: null, unknown: null }
    try {
      const state = await withTimeout(
        read(cameraId),
        SENSOR_LINKED_STATE_READ_TIMEOUT_MS,
        'snapshot state read',
      )
      return state === undefined
        ? { reason: null, unknown: 'empty' }
        : { reason: state.reason, unknown: null }
    } catch (err: unknown) {
      return { reason: null, unknown: err instanceof LinkedReadTimeout ? 'timeout' : 'error' }
    }
  }

  private async judgeFreshness(
    sensorId: number,
    results: readonly TileResult[],
    atMs: number,
  ): Promise<readonly TileResult[]> {
    const read = this.deps.getFrameCapturedAt
    const landedIds = results.filter((r) => r.outcome === 'landed').map((r) => r.cameraId)
    if (read === undefined || landedIds.length === 0) return results
    let capturedAt: ReadonlyMap<number, number | null>
    try {
      capturedAt = await withTimeout(
        read(landedIds),
        SENSOR_LINKED_FRESHNESS_READ_TIMEOUT_MS,
        'frame freshness read',
      )
    } catch (err: unknown) {
      this.deps.logger.warn('linked pictures freshness unverified — keeping every tile', {
        tags: { deviceId: sensorId },
        meta: { error: String(err) },
      })
      return results
    }
    return results.map((r): TileResult => {
      if (r.outcome !== 'landed') return r
      const at = capturedAt.get(r.cameraId)
      // Unknown (no row / null) keeps the tile: absence of a date is not proof of age.
      if (at === undefined || at === null) return r
      if (at >= atMs - SENSOR_LINKED_MAX_FRAME_AGE_MS) return r
      return {
        cameraId: r.cameraId,
        outcome: 'stale',
        reason: `frame ${String(atMs - at)} ms older than the event`,
        tookMs: r.tookMs,
      }
    })
  }

  private async compose(
    sensorId: number,
    landed: readonly LandedTile[],
    atMs: number,
  ): Promise<ComposedSet> {
    const first = landed[0]
    if (first === undefined) return { mosaic: [], servable: [], drawn: 0 }
    // One tile ships as the plain still — a mosaic of one is a picture with a border.
    if (landed.length === 1) {
      return { mosaic: stillShelfMedia(first.jpeg, atMs), servable: landed, drawn: 1 }
    }
    try {
      const { jpeg, droppedTiles } = await renderMosaic(
        {
          purpose: 'sensor',
          tiles: landed.map((r) => ({
            jpeg: r.jpeg,
            deviceId: r.cameraId,
            sourceId: String(r.cameraId),
          })),
        },
        this.deps.logger,
      )
      return {
        mosaic: stillShelfMedia(jpeg, atMs),
        servable: landed,
        drawn: landed.length - droppedTiles,
      }
    } catch (err: unknown) {
      // Every tile here already passed the decode probe (`decodableStill`), so a
      // failure is the COMPOSITION's, not the bytes': ship the primary camera's
      // own still rather than nothing, and let each camera keep its own.
      this.deps.logger.warn('sensor mosaic could not be composed — shipping the first camera', {
        tags: { deviceId: sensorId },
        meta: { error: String(err), offered: landed.length, shipped: first.cameraId },
      })
      return { mosaic: stillShelfMedia(first.jpeg, atMs), servable: landed, drawn: 1 }
    }
  }

  private logTile(sensorId: number, r: TileResult): void {
    const extras = {
      tags: { deviceId: r.cameraId },
      meta: {
        sensorId,
        outcome: r.outcome,
        tookMs: r.tookMs,
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
        ...(r.stateUnknown !== undefined ? { stateUnknown: r.stateUnknown } : {}),
      },
    }
    if (r.outcome === 'excluded') {
      this.deps.logger.info('linked camera excluded from the sensor notification', extras)
    } else if (r.outcome === 'landed' && r.stateUnknown !== undefined) {
      this.deps.logger.info(
        'linked camera photographed for the sensor notification — state unknown, tile kept',
        extras,
      )
    } else if (r.outcome === 'landed') {
      this.deps.logger.debug('linked camera photographed for the sensor notification', extras)
    } else {
      this.deps.logger.warn(
        'linked camera gave no usable picture for the sensor notification',
        extras,
      )
    }
  }
}

/** Reject with {@link LinkedReadTimeout} if `promise` does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LinkedReadTimeout(what, ms)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}
