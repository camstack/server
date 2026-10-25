/**
 * RetrainFrameStore — the COPIES the retrain dataset owns.
 *
 * Collection: `pipeline-analytics:retrain-frames`.
 * Blobs: `retrain/<deviceId>/<trackId>/<hash>.jpg` under the `artifacts`
 * class root — the dataset is that class's fourth tenant (D341), addressed
 * through the permanent row ref {@link RETRAIN_MEDIA_LOCATION}. Never the
 * footage volume: the 2026-08-17 recordings wipe took the whole dataset with
 * it while it lived on `eventMedia` (D197). See D781.
 *
 * ## Why a copy, and why at selection time
 *
 * [D81](../../../../../docs/decisions/adr-0081.md) makes a `trained` track
 * EVICTABLE again — retention stops holding it the moment the operator is done
 * with it. That is only sound because the dataset stopped depending on the
 * track's media before the status changed: the frame was copied when it was
 * selected, not referenced. A dataset whose entries can disappear when an
 * unrelated sweep runs is not a dataset.
 *
 * The copy is therefore taken EAGERLY, at selection, and everything downstream
 * addresses the copy. `RetrainAnnotation.mediaKey` is always a key in THIS
 * store — never a `pipeline-analytics:media` key.
 *
 * ## The gate that matters
 *
 * The picker offers only media that still exists, so a frame whose original has
 * evaporated blocks the selection OF THAT ORIGINAL — and never the copy that
 * was already taken. Those are two different reads and the order is
 * load-bearing: {@link copyFrame} answers from the copy index FIRST and only
 * touches the source when there is no copy. An operator who annotated a frame
 * last week can still see it, export it and finish the track today, whatever
 * retention did to the track's own media in between.
 */

import { createHash } from 'node:crypto'
import type {
  IScopedLogger,
  MediaFileKind,
  PreparedTransactOp,
  RetrainDismissed,
} from '@camstack/types'
import type { EventLedgerCollection } from '../store/event-ledger-collection.js'
import type { MediaBlobStorage } from '../location-aware-media-storage.js'
import type { MediaWriteGate } from '../media-write-gate.js'
import { readJpegSize } from './jpeg-dimensions.js'
import { corpusDeviceIds, takeCorpusPage } from './retrain-corpus-walk.js'
import { narrowDismissed } from './retrain-origin.js'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per frame the operator SELECTS into the retrain dataset, or adds
 *     from the recording at an instant (storeRecordingStill, origin 'recording', no
 *     track). The copy is taken eagerly at selection (copyFrame), not referenced, so
 *     the row records a blob the dataset owns outright; re-selecting the same source
 *     (or the same camera instant) reuses the existing copy rather than writing a
 *     second one."
 *   retention="none — the blobs sit in the 'retrain/' subtree of the artifacts class
 *     (D781), which no owner cascade and no age sweep walks, which is exactly what makes a 'trained' track evictable
 *     again (D81). Rows go only when the operator deselects the frame (deleteFrame,
 *     after its annotations). Bounded only by operator selection — nothing caps the
 *     table or the disk it consumes."
 */
export const RETRAIN_FRAMES_COLLECTION = 'pipeline-analytics:retrain-frames'

/**
 * The PERMANENT location ref every retrain copy is written under (D781).
 *
 * Not a declared storage class: it is the rows' `locationId`, which the
 * media-storage wiring maps onto the `artifacts` class root — exactly how the
 * enrolled gallery's `galleryMedia` ref works (D341). The copies are curation
 * work with NO retention, so they share the one durable class rather than the
 * footage class, which is quota-evicted, drained and wipeable per disk. Rows
 * are never restamped for a root move: the ref is remapped instead, and the
 * singleton repoint carries the whole `artifacts` tree, `retrain/` included.
 */
export const RETRAIN_MEDIA_LOCATION = 'retrainMedia'

/**
 * Where copies taken before D781 live: a NULL `locationId` meant "wherever
 * `eventMedia` points", and a concrete `eventMedia:*` id was stamped by the
 * seal or a relocate pass. The boot reconcile
 * ({@link RetrainFrameStore.relocateLegacyCopies}) moves them onto
 * {@link RETRAIN_MEDIA_LOCATION}; until it has, reads resolve them here.
 */
export const LEGACY_RETRAIN_MEDIA_LOCATION = 'eventMedia'

/** Is this row already on the durable retrain tenant? */
export function rowIsDurableRetrainCopy(data: Record<string, unknown> | undefined): boolean {
  return data?.['locationId'] === RETRAIN_MEDIA_LOCATION
}

/** What one reconcile pass did. `missing` rows keep their annotations. */
export interface RetrainRelocateResult {
  readonly relocated: number
  readonly missing: number
  readonly failed: number
}

/** Path prefix of every retrain copy. Never `<deviceId>/events/…`: the orphan
 *  audit resolves ownership from INDEX rows, but a future filesystem-side tool
 *  must be able to tell the two corpora apart by path alone. */
const RETRAIN_PATH_PREFIX = 'retrain'

/** Where a frame came from: a track's media, or the recording at an instant. */
export type RetrainFrameOrigin = 'track' | 'recording'

/** A frame the dataset owns outright. */
export interface RetrainFrame {
  readonly frameId: string
  readonly deviceId: number
  readonly origin: RetrainFrameOrigin
  /** The track the copy was taken from. `''` on a recording still, which has
   *  none — the wire says so by leaving the field out. */
  readonly trackId: string
  /** The media row id the copy was taken FROM — provenance only. It may already
   *  point at nothing; that is expected and must never be treated as an error.
   *  `0` on a recording still. */
  readonly sourceMediaId: number
  readonly sourceKind: MediaFileKind
  readonly sizeBytes: number
  readonly width: number
  readonly height: number
  readonly copiedAt: number
  readonly locationId: string | null
  /** When the camera captured the frame. Absent on a pre-D785 copy. */
  readonly capturedAt?: number
  /** Measured at copy time. Absent when it was not (or could not be). */
  readonly chromaSpread?: number
  /** Every subject in the frame is boxed — set by the operator only. */
  readonly complete: boolean
  /** A recording still: the instant it was asked for. */
  readonly epochMs?: number
  /** Annotation-save counter (absent reads as `0`). */
  readonly revision?: number
  /** Proposals the operator deleted (absent reads as none). */
  readonly dismissed?: readonly RetrainDismissed[]
}

/** Why a selection could not be honoured — a named cause, never a silent skip. */
export type RetrainCopyRefusal = 'source-missing' | 'unreadable-image' | 'write-failed'

/** Ids per `IN (…)` page in {@link RetrainFrameStore.getMany}. */
const GET_MANY_PAGE = 500

/** A recording still that could not be stored. */
export type RetrainStillResult =
  | { readonly kind: 'copied'; readonly frame: RetrainFrame; readonly reused: boolean }
  | { readonly kind: 'refused'; readonly reason: 'unreadable-image' | 'write-failed' }

export type RetrainCopyResult =
  | { readonly kind: 'copied'; readonly frame: RetrainFrame; readonly reused: boolean }
  | {
      readonly kind: 'refused'
      readonly sourceMediaId: number
      readonly reason: RetrainCopyRefusal
    }

/** The source side of a copy — injected so the engine is testable without a
 *  MediaStore, and so it reads exactly one blob per NEW selection. */
export interface RetrainFrameSource {
  /** The original's bytes, or `null` when the blob is gone. */
  readonly readSource: (mediaId: number) => Promise<Buffer | null>
}

export interface RetrainFrameStoreDeps extends RetrainFrameSource {
  readonly storage: MediaBlobStorage
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly writeGate?: MediaWriteGate
  /**
   * The copy's mean channel spread (`scene/scene-crop.ts` `chromaSpread`).
   * Absent, or throwing, leaves the value unmeasured: never zero, which would
   * read as an IR frame.
   */
  readonly measureChroma?: (bytes: Buffer) => Promise<number>
  readonly frameLedger: EventLedgerCollection
}

/**
 * The copy's id, derived from `(trackId, sourceMediaId)`.
 *
 * Deterministic so selecting the same frame twice reuses the one copy instead
 * of doubling the dataset's disk. Still hashed (rather than embedded raw)
 * even though a media row id no longer contains `:` or a path separator: the
 * id namespace is a row's OWN identity, not sanitised input, and the hash
 * keeps `retrainFrameId` agnostic to what the source id looks like.
 */
export function retrainFrameId(trackId: string, sourceMediaId: number): string {
  const digest = createHash('sha1').update(String(sourceMediaId)).digest('hex').slice(0, 16)
  return `retrain:${trackId}:${digest}`
}

/**
 * A recording still's id, derived from `(deviceId, epochMs)` — the same moment
 * of the same camera is one copy, however many times it is added.
 */
export function recordingFrameId(deviceId: number, epochMs: number): string {
  const digest = createHash('sha1').update(String(epochMs)).digest('hex').slice(0, 16)
  return `retrain:rec:${String(deviceId)}:${digest}`
}

/** The directory a recording still sits in, beside the track directories. */
export const RECORDING_STILL_DIR = 'recording'

function framePath(
  frame: Pick<RetrainFrame, 'deviceId' | 'trackId' | 'frameId' | 'origin'>,
): string {
  const leaf = frame.frameId.slice(frame.frameId.lastIndexOf(':') + 1)
  const dir = frame.origin === 'recording' ? RECORDING_STILL_DIR : frame.trackId
  return `${RETRAIN_PATH_PREFIX}/${frame.deviceId}/${dir}/${leaf}.jpg`
}

/** A stored number, or `undefined` for NULL / absent / junk. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export class RetrainFrameStore {
  private readonly storage: MediaBlobStorage
  private readonly logger: IScopedLogger
  private readonly readSource: (mediaId: number) => Promise<Buffer | null>
  private readonly now: () => number
  private readonly writeGate: MediaWriteGate | undefined
  private readonly measureChroma: ((bytes: Buffer) => Promise<number>) | undefined
  private readonly ledger: EventLedgerCollection

  constructor(deps: RetrainFrameStoreDeps) {
    this.storage = deps.storage
    this.logger = deps.logger
    this.readSource = deps.readSource
    this.now = deps.now
    this.writeGate = deps.writeGate
    this.measureChroma = deps.measureChroma
    this.ledger = deps.frameLedger
  }

  /** The copy's chroma, or `undefined` when it cannot be measured. */
  private async chromaOf(bytes: Buffer, deviceId: number): Promise<number | undefined> {
    if (!this.measureChroma) return undefined
    try {
      const value = await this.measureChroma(bytes)
      return Number.isFinite(value) ? value : undefined
    } catch (err) {
      this.logger.warn(
        'retrain copy chroma could not be measured — its day/night falls back to the sun',
        {
          tags: { deviceId },
          meta: { error: String(err) },
        },
      )
      return undefined
    }
  }

  private rowToFrame(id: string, data: Record<string, unknown>): RetrainFrame {
    const origin: RetrainFrameOrigin = data['origin'] === 'recording' ? 'recording' : 'track'
    return {
      frameId: id,
      deviceId: Number(data['deviceId'] ?? 0),
      origin,
      trackId: String(data['trackId'] ?? ''),
      sourceMediaId: Number(data['sourceMediaId'] ?? 0),
      sourceKind: String(data['sourceKind'] ?? 'keyFrame') as MediaFileKind,
      sizeBytes: Number(data['sizeBytes'] ?? 0),
      width: Number(data['width'] ?? 0),
      height: Number(data['height'] ?? 0),
      copiedAt: Number(data['copiedAt'] ?? 0),
      locationId:
        typeof data['locationId'] === 'string' && data['locationId'].length > 0
          ? data['locationId']
          : null,
      ...(finiteNumber(data['capturedAt']) !== undefined
        ? { capturedAt: finiteNumber(data['capturedAt']) }
        : {}),
      ...(finiteNumber(data['chromaSpread']) !== undefined
        ? { chromaSpread: finiteNumber(data['chromaSpread']) }
        : {}),
      complete: data['complete'] === true || data['complete'] === 1,
      ...(finiteNumber(data['epochMs']) !== undefined
        ? { epochMs: finiteNumber(data['epochMs']) }
        : {}),
      revision: finiteNumber(data['revision']) ?? 0,
      dismissed: narrowDismissed(data['dismissed']),
    }
  }

  /** The copies with these ids, in the order given; unknown ids are skipped. */
  async getMany(frameIds: readonly string[]): Promise<readonly RetrainFrame[]> {
    if (frameIds.length === 0) return []
    try {
      const byId = new Map<string, RetrainFrame>()
      // Paged: one `IN (…)` per page keeps the statement under SQLite's
      // bound-parameter ceiling whatever a dataset version names.
      for (let i = 0; i < frameIds.length; i += GET_MANY_PAGE) {
        const page = frameIds.slice(i, i + GET_MANY_PAGE)
        const rows = await this.ledger.query({ whereIn: { id: [...page] }, limit: page.length })
        for (const r of rows) {
          if (typeof r.id === 'string') {
            byId.set(r.id, this.rowToFrame(r.id, r.data as Record<string, unknown>))
          }
        }
      }
      return frameIds.flatMap((id) => {
        const frame = byId.get(id)
        return frame !== undefined ? [frame] : []
      })
    } catch (err) {
      this.logger.warn('RetrainFrameStore.getMany failed', {
        meta: { frames: frameIds.length, error: String(err) },
      })
      return []
    }
  }

  /** Every camera the dataset holds a copy of — a recording still can be the
   *  only thing a camera contributes, with no track anywhere. */
  async listDeviceIds(): Promise<readonly number[]> {
    try {
      const rows = await this.ledger.query({})
      const ids = new Set<number>()
      for (const r of rows) {
        const id = Number((r.data as Record<string, unknown>)['deviceId'])
        if (Number.isInteger(id) && id > 0) ids.add(id)
      }
      return [...ids].toSorted((a, b) => a - b)
    } catch (err) {
      this.logger.warn('RetrainFrameStore.listDeviceIds failed', {
        meta: { error: String(err) },
      })
      return []
    }
  }

  /**
   * One corpus page in {@link compareCorpusNewestFirst} order. Reads the clock
   * prefix of the page (`offset + limit`), not every copy. `keep` drops rows
   * before they count toward the page (an unannotated page skips annotated ids).
   */
  pageCorpus(input: {
    readonly deviceIds?: readonly number[]
    readonly offset: number
    readonly limit: number
    readonly keep: (frame: RetrainFrame) => boolean
  }): Promise<readonly RetrainFrame[]> {
    return takeCorpusPage(
      {
        pageByClock: (cursor, pageLimit, clockDeviceId) =>
          this.ledger.pageByClock(cursor, pageLimit, clockDeviceId),
        toFrame: (id, data) => this.rowToFrame(id, data),
      },
      {
        deviceIds: input.deviceIds,
        offset: input.offset,
        limit: input.limit,
        keep: input.keep,
      },
    )
  }

  /** How many copies the page's camera filter names. Omitted ids count the kind. */
  async countInDevices(deviceIds: readonly number[] | undefined): Promise<number> {
    const devices = corpusDeviceIds(deviceIds)
    if (devices === undefined) return this.ledger.count()
    let total = 0
    for (const deviceId of devices) {
      total += await this.ledger.count({ where: { deviceId } })
    }
    return total
  }

  /** Every corpus copy — index rows only, no blob. Newest-first is the caller's. */
  async listAll(): Promise<readonly RetrainFrame[]> {
    try {
      const rows = await this.ledger.query({})
      return rows
        .filter((r): r is typeof r & { id: string } => typeof r.id === 'string')
        .map((r) => this.rowToFrame(r.id, r.data as Record<string, unknown>))
    } catch (err) {
      this.logger.warn('RetrainFrameStore.listAll failed', {
        meta: { error: String(err) },
      })
      return []
    }
  }

  /** The copy with this id, or `null`. Index read only — no blob is touched. */
  async get(frameId: string): Promise<RetrainFrame | null> {
    try {
      const row = await this.ledger.get(frameId)
      return row ? this.rowToFrame(frameId, row.data) : null
    } catch (err) {
      this.logger.warn('RetrainFrameStore.get failed', {
        meta: { frameId, error: String(err) },
      })
      return null
    }
  }

  /** Every copy taken from this track, oldest first. A recording still has
   *  no track and is never answered here. */
  async listByTrack(trackId: string): Promise<readonly RetrainFrame[]> {
    if (trackId === '') return []
    try {
      const rows = await this.ledger.query({
        where: { trackId },
        orderBy: { field: 'copiedAt', direction: 'asc' },
      })
      return rows
        .filter((r): r is typeof r & { id: string } => typeof r.id === 'string')
        .map((r) => this.rowToFrame(r.id, r.data as Record<string, unknown>))
    } catch (err) {
      this.logger.warn('RetrainFrameStore.listByTrack failed', {
        meta: { trackId, error: String(err) },
      })
      return []
    }
  }

  /**
   * The copies of one camera the operator marked complete. A complete frame
   * with no box is a hard negative, so an export cannot find these through
   * the annotation table alone.
   */
  async listCompleteByDevice(deviceId: number, limit: number): Promise<readonly RetrainFrame[]> {
    try {
      const rows = await this.ledger.query({ where: { deviceId, complete: true }, limit })
      return rows
        .filter((r): r is typeof r & { id: string } => typeof r.id === 'string')
        .map((r) => this.rowToFrame(r.id, r.data as Record<string, unknown>))
    } catch (err) {
      this.logger.warn('RetrainFrameStore.listCompleteByDevice failed', {
        tags: { deviceId },
        meta: { error: String(err) },
      })
      return []
    }
  }

  /** How many copies each of these tracks already owns — one query, so the
   *  staging list can badge "worked / not worked" without N round trips. */
  async countsByTrack(trackIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>()
    if (trackIds.length === 0) return counts
    try {
      const rows = await this.ledger.query({ whereIn: { trackId: [...trackIds] } })
      for (const r of rows) {
        const trackId = String((r.data as Record<string, unknown>)['trackId'] ?? '')
        if (trackId === '') continue
        counts.set(trackId, (counts.get(trackId) ?? 0) + 1)
      }
    } catch (err) {
      this.logger.warn('RetrainFrameStore.countsByTrack failed', {
        meta: { tracks: trackIds.length, error: String(err) },
      })
    }
    return counts
  }

  /** The copy's bytes. `null` when the copy itself is gone — which, unlike a
   *  missing original, is a real fault and is logged by the caller. */
  async readFrame(frame: RetrainFrame): Promise<Buffer | null> {
    try {
      return await this.storage.read({
        location: frame.locationId ?? LEGACY_RETRAIN_MEDIA_LOCATION,
        relativePath: framePath(frame),
      })
    } catch (err) {
      this.logger.warn('retrain frame copy unreadable', {
        tags: { deviceId: frame.deviceId },
        meta: { frameId: frame.frameId, trackId: frame.trackId, error: String(err) },
      })
      return null
    }
  }

  /**
   * COPY-ON-SELECT. The one write that makes `trained` safe.
   *
   * Order is the contract:
   *
   * 1. **Is there already a copy?** If yes, return it and touch NOTHING else.
   *    The original may have evaporated in the meantime and it does not matter
   *    — the dataset already owns these pixels.
   * 2. Only then read the source. A source that is gone REFUSES this selection,
   *    with a named reason the caller surfaces; it never produces an empty copy
   *    and never removes an existing one.
   *
   * Inverting those two steps is the bug this docblock exists to prevent: it
   * would make an old annotation unopenable the day retention swept the track
   * it came from, and the failure would look like data loss with no cause.
   */
  async copyFrame(input: {
    readonly deviceId: number
    readonly trackId: string
    readonly sourceMediaId: number
    readonly sourceKind: MediaFileKind
    /** The source media row's timestamp — when the camera saw the frame. */
    readonly capturedAt?: number
  }): Promise<RetrainCopyResult> {
    const frameId = retrainFrameId(input.trackId, input.sourceMediaId)
    const existing = await this.get(frameId)
    if (existing !== null) return { kind: 'copied', frame: existing, reused: true }

    const bytes = await this.readSource(input.sourceMediaId)
    if (bytes === null || bytes.length === 0) {
      // A DROPPED selection always says so. Silence here reads as "the operator
      // never clicked it", and the frame quietly never enters the dataset.
      this.logger.warn('retrain copy refused — source media no longer exists', {
        tags: { deviceId: input.deviceId },
        meta: { trackId: input.trackId, sourceMediaId: input.sourceMediaId },
      })
      return { kind: 'refused', sourceMediaId: input.sourceMediaId, reason: 'source-missing' }
    }
    const size = readJpegSize(bytes)
    if (size === null) {
      this.logger.warn('retrain copy refused — source is not a readable JPEG', {
        tags: { deviceId: input.deviceId },
        meta: { trackId: input.trackId, sourceMediaId: input.sourceMediaId, bytes: bytes.length },
      })
      return { kind: 'refused', sourceMediaId: input.sourceMediaId, reason: 'unreadable-image' }
    }

    const path = framePath({ ...input, frameId, origin: 'track' })
    const locationId = RETRAIN_MEDIA_LOCATION
    const chromaSpread = await this.chromaOf(bytes, input.deviceId)
    const frame: RetrainFrame = {
      frameId,
      deviceId: input.deviceId,
      origin: 'track',
      trackId: input.trackId,
      sourceMediaId: input.sourceMediaId,
      sourceKind: input.sourceKind,
      sizeBytes: bytes.length,
      width: size.width,
      height: size.height,
      copiedAt: this.now(),
      locationId,
      ...(input.capturedAt !== undefined ? { capturedAt: input.capturedAt } : {}),
      ...(chromaSpread !== undefined ? { chromaSpread } : {}),
      complete: false,
    }
    const persist = async (): Promise<void> => {
      await this.storage.write({
        // The blob goes where the ROW says it is.
        location: locationId,
        relativePath: path,
        data: bytes,
      })
      // The blob lands BEFORE the row: a row with no blob is an entry the
      // dataset believes in and cannot produce, which is exactly the retroactive
      // loss the copy exists to prevent. A blob with no row is reclaimable junk.
      await this.ledger.upsertRow(frameId, {
        deviceId: frame.deviceId,
        trackId: frame.trackId,
        sourceMediaId: frame.sourceMediaId,
        sourceKind: frame.sourceKind,
        path,
        sizeBytes: frame.sizeBytes,
        width: frame.width,
        height: frame.height,
        copiedAt: frame.copiedAt,
        locationId: frame.locationId,
        capturedAt: frame.capturedAt ?? null,
        chromaSpread: frame.chromaSpread ?? null,
        complete: false,
      })
    }
    try {
      if (this.writeGate) await this.writeGate.run(persist)
      else await persist()
    } catch (err) {
      this.logger.error('retrain copy failed to persist', {
        tags: { deviceId: input.deviceId },
        meta: { trackId: input.trackId, frameId, error: String(err) },
      })
      return { kind: 'refused', sourceMediaId: input.sourceMediaId, reason: 'write-failed' }
    }
    this.logger.info('retrain frame copied into the dataset', {
      tags: { deviceId: input.deviceId },
      meta: {
        trackId: input.trackId,
        frameId,
        sourceKind: input.sourceKind,
        width: frame.width,
        height: frame.height,
        sizeBytes: frame.sizeBytes,
      },
    })
    return { kind: 'copied', frame, reused: false }
  }

  /**
   * Store a still decoded from the RECORDING at `epochMs` — a frame with no
   * track and no media row, usually the one the model saw nothing in.
   *
   * Same contract as {@link copyFrame}: an existing copy of that moment is
   * returned untouched; the blob lands before the row; a refusal is named.
   * `capturedAt` IS the instant — the camera saw this frame then.
   */
  async storeRecordingStill(
    input: {
      readonly deviceId: number
      readonly epochMs: number
      readonly bytes: Buffer
    },
    /** Ops that must land WITH the frame row (its collection membership). */
    withRow: readonly PreparedTransactOp[] = [],
  ): Promise<RetrainStillResult> {
    const frameId = recordingFrameId(input.deviceId, input.epochMs)
    const existing = await this.get(frameId)
    if (existing !== null) return { kind: 'copied', frame: existing, reused: true }
    const size = readJpegSize(input.bytes)
    if (size === null) {
      this.logger.warn('retrain recording still refused — not a readable JPEG', {
        tags: { deviceId: input.deviceId },
        meta: { epochMs: input.epochMs, bytes: input.bytes.length },
      })
      return { kind: 'refused', reason: 'unreadable-image' }
    }
    const chromaSpread = await this.chromaOf(input.bytes, input.deviceId)
    const frame: RetrainFrame = {
      frameId,
      deviceId: input.deviceId,
      origin: 'recording',
      trackId: '',
      sourceMediaId: 0,
      sourceKind: 'fullFrame',
      sizeBytes: input.bytes.length,
      width: size.width,
      height: size.height,
      copiedAt: this.now(),
      locationId: RETRAIN_MEDIA_LOCATION,
      capturedAt: input.epochMs,
      ...(chromaSpread !== undefined ? { chromaSpread } : {}),
      complete: false,
      epochMs: input.epochMs,
    }
    const path = framePath(frame)
    const persist = async (): Promise<void> => {
      await this.storage.write({
        location: RETRAIN_MEDIA_LOCATION,
        relativePath: path,
        data: input.bytes,
      })
      // One transaction: the row and whatever must exist with it (its membership).
      const row = await this.ledger.txUpsert(frameId, {
        deviceId: frame.deviceId,
        trackId: '',
        sourceMediaId: 0,
        sourceKind: frame.sourceKind,
        path,
        sizeBytes: frame.sizeBytes,
        width: frame.width,
        height: frame.height,
        copiedAt: frame.copiedAt,
        locationId: RETRAIN_MEDIA_LOCATION,
        capturedAt: input.epochMs,
        chromaSpread: frame.chromaSpread ?? null,
        complete: false,
        origin: 'recording',
        epochMs: input.epochMs,
      })
      await this.ledger.transact([row, ...withRow])
    }
    try {
      if (this.writeGate) await this.writeGate.run(persist)
      else await persist()
    } catch (err) {
      this.logger.error('retrain recording still failed to persist', {
        tags: { deviceId: input.deviceId },
        meta: { frameId, epochMs: input.epochMs, error: String(err) },
      })
      return { kind: 'refused', reason: 'write-failed' }
    }
    this.logger.info('retrain recording still stored in the dataset', {
      tags: { deviceId: input.deviceId },
      meta: { frameId, epochMs: input.epochMs, width: frame.width, height: frame.height },
    })
    return { kind: 'copied', frame, reused: false }
  }

  /**
   * The operator's "every subject in this frame is boxed" (D785 context: an
   * unboxed subject is a false positive to a detector evaluation). Only the
   * operator sets it; nothing derives it from the annotation count, because a
   * frame with zero boxes may be a complete hard negative.
   *
   * @returns the updated frame, or `null` when no such copy exists.
   */
  async setComplete(frameId: string, complete: boolean): Promise<RetrainFrame | null> {
    const existing = await this.get(frameId)
    if (existing === null) return null
    await this.ledger.update(frameId, { complete })
    return { ...existing, complete }
  }

  /**
   * Drop a copy and its blob — the operator un-selecting a frame.
   *
   * The ROW goes first, in one transaction with `withRow` (the frame's
   * annotations and collection memberships, which the caller builds): a failure
   * leaves the frame, its boxes and its memberships all in place, and throws.
   * The blob goes after: if that fails the row is already gone and the bytes
   * are reclaimable junk, logged, never a row pointing at missing media.
   */
  async deleteFrame(
    frame: RetrainFrame,
    withRow: readonly PreparedTransactOp[] = [],
  ): Promise<void> {
    const remove = async (): Promise<void> => {
      try {
        await this.ledger.transact([...withRow, this.ledger.txDelete(frame.frameId)])
      } catch (err) {
        this.logger.error('retrain frame delete failed; nothing was removed', {
          tags: { deviceId: frame.deviceId },
          meta: { frameId: frame.frameId, error: String(err) },
        })
        throw err
      }
      try {
        await this.storage.delete({
          location: frame.locationId ?? LEGACY_RETRAIN_MEDIA_LOCATION,
          relativePath: framePath(frame),
        })
      } catch (err) {
        this.logger.warn('retrain frame removed but its blob could not be deleted', {
          tags: { deviceId: frame.deviceId },
          meta: { frameId: frame.frameId, error: String(err) },
        })
      }
    }
    if (this.writeGate) await this.writeGate.run(remove)
    else await remove()
  }

  /**
   * Move every copy still on the footage class onto the durable retrain
   * tenant (D781): copy → read back → restamp → delete the source.
   *
   * A reconcile, not a one-shot: one query of a collection bounded by
   * operator selection, so it is cheap when converged, and it is what would
   * notice a pre-D781 copy restored from anywhere. The order is the gallery
   * reconcile's (D341) and for the same reason: the row is restamped only
   * after the new blob reads back, so a crash at any point leaves a row that
   * names a location holding its bytes.
   *
   * A copy whose bytes are already gone is COUNTED and LOGGED, never deleted:
   * its annotations are the operator's work, and only the operator decides
   * to drop them (deselecting the frame).
   */
  async relocateLegacyCopies(): Promise<RetrainRelocateResult> {
    const rows = await this.ledger.query({})
    let relocated = 0
    let missing = 0
    let failed = 0
    for (const row of rows) {
      if (typeof row.id !== 'string') continue
      const data = row.data as Record<string, unknown>
      if (rowIsDurableRetrainCopy(data)) continue
      const frame = this.rowToFrame(row.id, data)
      const from = frame.locationId ?? LEGACY_RETRAIN_MEDIA_LOCATION
      const relativePath = framePath(frame)
      let bytes: Buffer
      try {
        bytes = await this.storage.read({ location: from, relativePath })
      } catch (err) {
        missing += 1
        this.logger.warn(
          'retrain copy has NO bytes on the footage class — its row and annotations are kept; deselect the frame to drop it',
          {
            tags: { deviceId: frame.deviceId },
            meta: { frameId: frame.frameId, trackId: frame.trackId, from, error: String(err) },
          },
        )
        continue
      }
      const move = async (): Promise<void> => {
        await this.storage.write({ location: RETRAIN_MEDIA_LOCATION, relativePath, data: bytes })
        const readBack = await this.storage.read({ location: RETRAIN_MEDIA_LOCATION, relativePath })
        if (!readBack.equals(bytes)) throw new Error('read-back differs from the source')
        await this.ledger.update(frame.frameId, { locationId: RETRAIN_MEDIA_LOCATION })
        await this.storage.delete({ location: from, relativePath })
      }
      try {
        if (this.writeGate) await this.writeGate.run(move)
        else await move()
        relocated += 1
      } catch (err) {
        failed += 1
        this.logger.error('retrain copy could not be moved off the footage class', {
          tags: { deviceId: frame.deviceId },
          meta: { frameId: frame.frameId, trackId: frame.trackId, from, error: String(err) },
        })
      }
    }
    return { relocated, missing, failed }
  }
}
