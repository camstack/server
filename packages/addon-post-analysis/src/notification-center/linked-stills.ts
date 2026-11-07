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
 * A SLEEPING battery camera is woken by one forced capture when the rule leaves
 * it allowed (D998) — bounded, once per gap per camera, never by a poll.
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

/**
 * D998 — the one forced capture that wakes a sleeping battery camera for a
 * sensor notification: the bound it may take, the pause between re-polls of a
 * camera another wake already started, and the gap per camera before it is
 * woken again (a flapping contact must not drain a battery).
 */
export const NC_LINKED_WAKE_CAPTURE_TIMEOUT_MS = 15_000
const NC_LINKED_WAKE_POLL_MS = 1_000
export const NC_LINKED_WAKE_MIN_GAP_MS = 60_000

/**
 * D60 — a tile the freshness read calls stale is RE-POLLED, unforced, until the
 * wrapper hands back a frame from the event or this bound is spent. The wrapper
 * settles a soft miss with its old cached hit; one more ask, a moment later,
 * usually finds the refreshed one. The bound sits inside the dispatcher's still
 * deadline (`NC_STILL_WAIT_MS`, 3 s): the row waits for it through `pendingUntil`.
 */
const NC_LINKED_STALE_POLL_MS = 500
const NC_LINKED_STALE_MAX_POLLS = 5

/** Per camera — the marker's own bound (`SENSOR_MARKER_SNAPSHOT_TIMEOUT_MS`). */
const SENSOR_LINKED_CAPTURE_TIMEOUT_MS = 2_500

/** The capture-free wrapper-state read, per camera. It runs IN PARALLEL with
 *  the capture and under the capture's own bound, so it costs no extra time and
 *  a slow-but-honest answer is still heard: a blocking reason EXCLUDES the tile
 *  even when the capture returned bytes (they are a state card, not a
 *  photograph). A read that misses the bound or fails is UNKNOWN and keeps the
 *  tile (D49). */
const SENSOR_LINKED_STATE_READ_TIMEOUT_MS = SENSOR_LINKED_CAPTURE_TIMEOUT_MS

/** The battery-slice read behind the unknown-state wake: cheap, and bounded. */
const SENSOR_LINKED_BATTERY_READ_TIMEOUT_MS = 1_000

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

export type NcLinkedExclusionReason =
  | 'offline'
  | 'disabled'
  | 'sleeping'
  | 'unreachable'
  | 'waking'
  | 'wake-skipped:policy'
  | 'wake-skipped:recent-wake'
  | 'wake-skipped:unreachable'
/** Why a wrapper-state read said nothing: too slow, threw, or answered empty. */
export type NcLinkedStateUnknown = 'timeout' | 'error' | 'empty'
export type NcLinkedTileOutcome =
  | 'landed'
  | 'excluded'
  | 'timeout'
  | 'empty'
  | 'error'
  | 'stale'
  | 'wake-timeout'
  | 'wake-refused'

/** What a set may do about a sleeping camera (D998). Absent = no wake. */
export interface NcLinkedCaptureOptions {
  readonly wakeSleeping: boolean
  /** The rules that wanted the picture, named on the wake line. */
  readonly ruleIds?: readonly string[]
}

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
  /**
   * `force` is a demand with a named principal: here, only a rule that left
   * the camera's wake allowed (D998), and only for a camera the wrapper
   * called `sleeping`. Never for a poll.
   */
  readonly getSnapshot: (
    deviceId: number,
    opts?: { readonly force?: boolean },
  ) => Promise<NcLinkedSnapshot | null>
  /** Capture-free wrapper state; null reason = capturable. Throws/undefined when unknown. */
  readonly getSnapshotState?: (deviceId: number) => Promise<NcLinkedSnapshotState | undefined>
  /** Cache-only: when each camera's cached frame was captured (null = none). */
  readonly getFrameCapturedAt?: (
    deviceIds: readonly number[],
  ) => Promise<ReadonlyMap<number, number | null>>
  /**
   * Whether the camera is a battery camera, off its `battery` slice. Asked ONLY
   * when the wrapper's state could not be read and the unforced capture came
   * back empty (D49): a sleeping battery camera answers exactly that way, and
   * the failed read must not cost it its D998 wake. Throws/undefined = not known
   * to be a battery camera.
   */
  readonly isBatteryCamera?: (deviceId: number) => Promise<boolean | undefined>
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
  /** This camera was woken by a forced capture. */
  readonly woken?: true
  readonly tookMs: number
}

/** What one set's capture of one camera knows about its own set. */
interface SetContext {
  readonly setId: string
  readonly sensorId: number
  readonly startedAt: number
  readonly options: NcLinkedCaptureOptions
}

/** What the wrapper said: a reason to exclude, or nothing — and whether it said at all. */
interface WrapperVerdict {
  readonly reason: NcLinkedExclusionReason | null
  readonly unknown: NcLinkedStateUnknown | null
}

/** One capture's result before the wrapper's verdict is applied. */
interface CaptureResult {
  readonly outcome: 'landed' | 'timeout' | 'empty' | 'error' | 'wake-timeout' | 'wake-refused'
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
  /** setId → when its in-flight wake gives up (the dispatcher waits that long). */
  private readonly pendingWakes = new Map<string, number>()
  private readonly lastWakeAt = new Map<number, number>()

  constructor(deps: NcLinkedStillShelfDeps) {
    this.deps = deps
  }

  /** SYNCHRONOUS: the evaluation that follows names these owners. */
  captureSet(
    sensorId: number,
    cameraIds: readonly number[],
    atMs: number,
    options: NcLinkedCaptureOptions = { wakeSleeping: false },
  ): NcLinkedStills {
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
    this.run(setId, stills, atMs, now, options).catch((err: unknown) => {
      this.deps.logger.warn('sensor notification pictures failed — it ships text-only', {
        tags: { deviceId: sensorId },
        meta: { error: String(err) },
      })
    })
    return stills
  }

  /**
   * While a wake of one of this owner's cameras is in flight: the instant it
   * gives up (its bound plus one poll). `undefined` otherwise — the dispatcher
   * then keeps its ordinary still-wait.
   */
  pendingUntil(ownerId: string): number | undefined {
    const ref = this.owners.get(ownerId)
    return ref === undefined ? undefined : this.pendingWakes.get(ref.setId)
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
    this.pendingWakes.clear()
  }

  private async run(
    setId: string,
    stills: NcLinkedStills,
    atMs: number,
    startedAt: number,
    options: NcLinkedCaptureOptions,
  ): Promise<void> {
    const ctx: SetContext = {
      setId,
      sensorId: stills.sensorId,
      startedAt,
      options,
    }
    let judged: readonly TileResult[]
    try {
      const results = await Promise.all(stills.cameraIds.map((id) => this.captureOne(id, ctx)))
      judged = await this.repollStale(
        ctx,
        atMs,
        await this.wakeStaleBattery(ctx, await this.judgeFreshness(stills.sensorId, results, atMs)),
      )
    } finally {
      this.pendingWakes.delete(setId)
    }
    for (const r of judged) this.logTile(stills.sensorId, r)
    const landed = judged.filter(isLandedTile)
    const composed = await this.compose(stills.sensorId, landed, atMs)
    const undrawable = landed.length - composed.drawn
    const woken = judged.filter((r) => r.woken === true).map((r) => r.cameraId)
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
          ...(woken.length > 0 ? { woken, waitedMs: this.deps.now() - startedAt } : {}),
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

  private async captureOne(cameraId: number, ctx: SetContext): Promise<TileResult> {
    const took = (): number => this.deps.now() - ctx.startedAt
    if (this.deps.isOnline(cameraId) === false) {
      return {
        cameraId,
        outcome: 'excluded',
        reason: 'offline',
        tookMs: took(),
      }
    }
    // In parallel: the state read costs no time of its own, and its answer is
    // applied to whatever the capture brought back.
    const [verdict, capture] = await Promise.all([
      this.wrapperVerdict(cameraId),
      this.captureStill(cameraId, false, SENSOR_LINKED_CAPTURE_TIMEOUT_MS),
    ])
    const excluded = (reason: NcLinkedExclusionReason): TileResult => ({
      cameraId,
      outcome: 'excluded',
      reason,
      tookMs: took(),
    })
    if (verdict.reason === 'sleeping') return this.wakeOne(cameraId, ctx)
    if (verdict.reason === 'waking' && ctx.options.wakeSleeping)
      return this.awaitWaking(cameraId, ctx)
    if (verdict.reason === 'unreachable' && ctx.options.wakeSleeping) {
      return excluded('wake-skipped:unreachable')
    }
    if (verdict.reason !== null) {
      // The bytes, if any, are the wrapper's state card — never a photograph.
      return excluded(verdict.reason)
    }
    // D49: a state that could not be read must not destroy the wake. A sleeping
    // battery camera answers an unforced capture with nothing, and the wrapper
    // that would have said `sleeping` is the very read that failed.
    //
    // The same holds when the read ANSWERED awake: the state is the fallible
    // side (a hub-summary sleep flip refused inside its grace left a sleeping
    // camera reading awake while the provider served `cached-snapshot,
    // sleeping`). So on a battery camera an unforced capture that came back
    // nothing — `timeout` or `empty` — is followed by ONE forced wake whatever
    // the verdict said. A mains camera has nothing to wake: it keeps its tile.
    const brought = capture.outcome === 'timeout' || capture.outcome === 'empty'
    if (brought && ctx.options.wakeSleeping && (await this.isBatteryCamera(cameraId))) {
      this.deps.logger.info(
        verdict.unknown !== null
          ? 'linked camera state unknown and capture empty — waking as a battery camera'
          : 'linked battery camera answered awake with no picture — waking it',
        {
          tags: { deviceId: cameraId },
          meta: {
            sensorId: ctx.sensorId,
            capture: capture.outcome,
            ...(verdict.unknown !== null ? { stateUnknown: verdict.unknown } : {}),
          },
        },
      )
      return this.wakeOne(cameraId, ctx)
    }
    return {
      cameraId,
      ...capture,
      ...(verdict.unknown !== null ? { stateUnknown: verdict.unknown } : {}),
      tookMs: took(),
    }
  }

  /** Only a camera KNOWN to be a battery camera is woken on an unknown state. */
  private async isBatteryCamera(cameraId: number): Promise<boolean> {
    const read = this.deps.isBatteryCamera
    if (read === undefined) return false
    try {
      const isBattery = await withTimeout(
        read(cameraId),
        SENSOR_LINKED_BATTERY_READ_TIMEOUT_MS,
        'battery read',
      )
      return isBattery === true
    } catch (err: unknown) {
      this.deps.logger.warn('linked camera battery read failed — not woken on an unknown state', {
        tags: { deviceId: cameraId },
        meta: { error: String(err) },
      })
      return false
    }
  }

  /** D998: one forced capture, by the rule's leave, at most once per gap per camera. */
  private async wakeOne(cameraId: number, ctx: SetContext): Promise<TileResult> {
    const took = (): number => this.deps.now() - ctx.startedAt
    const skipped = (reason: NcLinkedExclusionReason): TileResult => ({
      cameraId,
      outcome: 'excluded',
      reason,
      tookMs: took(),
    })
    if (!ctx.options.wakeSleeping) return skipped('wake-skipped:policy')
    const last = this.lastWakeAt.get(cameraId)
    if (last !== undefined && ctx.startedAt - last < NC_LINKED_WAKE_MIN_GAP_MS) {
      return skipped('wake-skipped:recent-wake')
    }
    this.lastWakeAt.set(cameraId, ctx.startedAt)
    this.markPending(ctx)
    this.deps.logger.info('linked battery camera woken for the sensor notification', {
      tags: { deviceId: cameraId },
      meta: {
        sensorId: ctx.sensorId,
        ruleIds: ctx.options.ruleIds ?? [],
        boundMs: NC_LINKED_WAKE_CAPTURE_TIMEOUT_MS,
      },
    })
    const capture = await this.captureStill(cameraId, true, NC_LINKED_WAKE_CAPTURE_TIMEOUT_MS)
    return {
      cameraId,
      ...this.asWakeResult(capture),
      woken: true,
      tookMs: took(),
    }
  }

  /**
   * A battery camera whose unforced frame came back OLD is asleep behind a
   * cached picture: ask it once, forced, instead of re-polling a camera that
   * will not freshen on its own. One wake per camera per set — a tile already
   * woken is never woken again — and a mains camera keeps the D60 re-poll.
   */
  private async wakeStaleBattery(
    ctx: SetContext,
    judged: readonly TileResult[],
  ): Promise<readonly TileResult[]> {
    if (!ctx.options.wakeSleeping) return judged
    return Promise.all(
      judged.map(async (r): Promise<TileResult> => {
        if (r.outcome !== 'stale' || r.woken === true) return r
        if (!(await this.isBatteryCamera(r.cameraId))) return r
        this.deps.logger.info('linked battery camera frame is stale — waking it', {
          tags: { deviceId: r.cameraId },
          meta: { sensorId: ctx.sensorId, capture: 'stale', reason: r.reason ?? null },
        })
        return this.wakeOne(r.cameraId, ctx)
      }),
    )
  }

  /** A camera another wake already started: never forced, re-polled within the bound. */
  private async awaitWaking(cameraId: number, ctx: SetContext): Promise<TileResult> {
    const took = (): number => this.deps.now() - ctx.startedAt
    this.markPending(ctx)
    const polls = Math.floor(NC_LINKED_WAKE_CAPTURE_TIMEOUT_MS / NC_LINKED_WAKE_POLL_MS)
    for (let i = 0; i < polls; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, NC_LINKED_WAKE_POLL_MS))
      const verdict = await this.wrapperVerdict(cameraId)
      if (verdict.reason === 'waking') continue
      if (verdict.reason !== null) {
        return {
          cameraId,
          outcome: 'excluded',
          reason: verdict.reason,
          tookMs: took(),
        }
      }
      const capture = await this.captureStill(cameraId, false, SENSOR_LINKED_CAPTURE_TIMEOUT_MS)
      return {
        cameraId,
        ...this.asWakeResult(capture),
        woken: true,
        tookMs: took(),
      }
    }
    return { cameraId, outcome: 'wake-timeout', woken: true, tookMs: took() }
  }

  private markPending(ctx: SetContext): void {
    this.markPendingUntil(
      ctx.setId,
      ctx.startedAt + NC_LINKED_WAKE_CAPTURE_TIMEOUT_MS + NC_LINKED_WAKE_POLL_MS,
    )
  }

  private markPendingUntil(setId: string, until: number): void {
    this.pendingWakes.set(setId, Math.max(this.pendingWakes.get(setId) ?? 0, until))
  }

  /**
   * D60: a `stale` tile asks again (unforced — a poll never wakes) until its
   * frame is from the event or the bound is spent; the row's still-wait is held
   * open meanwhile. A camera that never freshens stays `stale`, said on its line.
   */
  private async repollStale(
    ctx: SetContext,
    atMs: number,
    judged: readonly TileResult[],
  ): Promise<readonly TileResult[]> {
    let current = judged
    if (!current.some((r) => r.outcome === 'stale')) return current
    this.markPendingUntil(
      ctx.setId,
      this.deps.now() + NC_LINKED_STALE_POLL_MS * (NC_LINKED_STALE_MAX_POLLS + 1),
    )
    for (let i = 0; i < NC_LINKED_STALE_MAX_POLLS; i++) {
      const waiting = current.filter((r) => r.outcome === 'stale').map((r) => r.cameraId)
      if (waiting.length === 0) break
      await new Promise<void>((resolve) => setTimeout(resolve, NC_LINKED_STALE_POLL_MS))
      const recaptured = await Promise.all(
        waiting.map(async (cameraId): Promise<TileResult | null> => {
          const capture = await this.captureStill(cameraId, false, SENSOR_LINKED_CAPTURE_TIMEOUT_MS)
          return capture.outcome === 'landed' && capture.jpeg !== undefined
            ? {
                cameraId,
                outcome: 'landed',
                jpeg: capture.jpeg,
                tookMs: this.deps.now() - ctx.startedAt,
              }
            : null
        }),
      )
      const landedAgain = recaptured.filter((r): r is TileResult => r !== null)
      if (landedAgain.length === 0) continue
      const rejudged = await this.judgeFreshness(ctx.sensorId, landedAgain, atMs)
      const fresh = new Map(
        rejudged.filter((r) => r.outcome === 'landed').map((r) => [r.cameraId, r]),
      )
      current = current.map((r) => fresh.get(r.cameraId) ?? r)
      for (const cameraId of fresh.keys()) {
        this.deps.logger.info(
          'linked camera frame was stale — a re-poll brought one from the event',
          {
            tags: { deviceId: cameraId },
            meta: { sensorId: ctx.sensorId, polls: i + 1 },
          },
        )
      }
    }
    return current
  }

  /** A wake that brought nothing back names itself, not the generic `empty`. */
  private asWakeResult(capture: CaptureResult): CaptureResult {
    if (capture.outcome === 'timeout') return { ...capture, outcome: 'wake-timeout' }
    const refused =
      capture.outcome === 'empty' ||
      (capture.outcome === 'error' && capture.reason !== 'undecodable')
    return refused ? { ...capture, outcome: 'wake-refused' } : capture
  }

  private async captureStill(
    cameraId: number,
    force: boolean,
    timeoutMs: number,
  ): Promise<CaptureResult> {
    try {
      const shot = await withTimeout(
        force ? this.deps.getSnapshot(cameraId, { force: true }) : this.deps.getSnapshot(cameraId),
        timeoutMs,
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
      const timedOut = err instanceof LinkedReadTimeout
      // D391: a read that failed names why, on the camera — the verdict alone
      // (`stateUnknown: error`) lost the cause.
      this.deps.logger.warn('linked camera snapshot state read failed — state unknown', {
        tags: { deviceId: cameraId },
        meta: { error: String(err), timedOut },
      })
      return { reason: null, unknown: timedOut ? 'timeout' : 'error' }
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
        ...(r.woken === true ? { woken: true as const } : {}),
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
      return {
        mosaic: stillShelfMedia(first.jpeg, atMs),
        servable: landed,
        drawn: 1,
      }
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
        meta: {
          error: String(err),
          offered: landed.length,
          shipped: first.cameraId,
        },
      })
      return {
        mosaic: stillShelfMedia(first.jpeg, atMs),
        servable: landed,
        drawn: 1,
      }
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
