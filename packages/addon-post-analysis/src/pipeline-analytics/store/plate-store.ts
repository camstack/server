/**
 * PlateStore — bounded recent-plate-reads buffer (one entry per track).
 *
 * Collection: pipeline-analytics:plates
 *
 * Mirrors FaceStore, but a plate is SELF-LABELING: instead of an opaque
 * embedding + identity assignment, each row carries the OCR `text` (normalized
 * for display) and `score`. Grouping is dynamic (clusterByText) — there is no
 * persistent identity. `corrected` records a manual OCR fix so retention/merge
 * logic can prefer human-confirmed reads.
 *
 * Retention: a plate read carries a `trackId`, so it is TRACK-OWNED and leaves
 * with its track through `deleteByTracks` in the cascade — never by age (D61,
 * `retention/retention-model.ts`). What remains here is `pruneCapOverflow`, a
 * pure CAPACITY bound; corrected and vehicle-enrolled reads are exempt.
 */

import type { IScopedLogger } from '@camstack/types'
import type { TrackCascadeLeafCount } from '../pipeline/delete-track-cascade.js'
import type { TrackFusionLeafCount, TrackFusionRequest } from '../pipeline/track-fusion-leaf.js'
import type { EventLedgerCollection } from './event-ledger-collection.js'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one UPSERT per track that produced an OCR plate read — the id is
 *     'plate-<trackId>', so a track has at most one row, rewritten as a
 *     higher-scoring read arrives, when the operator corrects the text, and when
 *     the read is enrolled onto a vehicle."
 *   retention="TRACK-OWNED and clockless (D61): rows leave with their track through
 *     PlateStore.deleteByTracks. Human-corrected reads and vehicle-enrolled
 *     (`assigned`) reads are exempt from the cap and consume no slot. The only
 *     other bound is capacity: pruneCapOverflow holds each camera's remaining
 *     buffer to bufferMaxPerDevice newest reads (default 50)."
 */
export const PLATES_COLLECTION = 'pipeline-analytics:plates'

export const PLATE_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'trackId', type: 'TEXT' as const, notNull: true },
  { name: 'timestamp', type: 'INTEGER' as const, notNull: true },
  { name: 'text', type: 'TEXT' as const, notNull: true },
  { name: 'score', type: 'REAL' as const, notNull: true },
  { name: 'mediaId', type: 'INTEGER' as const },
  { name: 'corrected', type: 'BOOLEAN' as const, notNull: true },
  // Vehicle assignment (mirrors FaceStore Design B): the vehicle a read was
  // enrolled to, the `assigned` retention-exemption flag, and the enrolled
  // sample id (so unassign can remove exactly that sample).
  { name: 'recognizedVehicleId', type: 'TEXT' as const },
  { name: 'assigned', type: 'BOOLEAN' as const, notNull: true },
  { name: 'assignedSampleId', type: 'TEXT' as const },
  // keyFrame parity: the track's native key frame + the plate bbox on it, so a
  // detail view can draw the box over the native frame (see PlateInfo).
  { name: 'keyFrameMediaId', type: 'INTEGER' as const },
  { name: 'plateBbox', type: 'JSON' as const },
] as const

/**
 * The widest plate window a single read may materialise before it REFUSES.
 *
 * The corpus reads (`searchPlates`, `suggestPlateClusters`) are genuinely
 * corpus-shaped — fuzzy text distance is not a predicate — so they cannot be
 * narrowed the way the gallery list was. What they CAN do is stop lying: they
 * carried no `limit` at all, so the engine imposed
 * `SETTINGS_QUERY_DEFAULT_ROW_CAP` and handed back the first 2 000 rows with a
 * WARN no caller can see. A search over the newest 2 000 of 50 000 plates and a
 * search over all of them are the same array (D320 R3).
 *
 * 10 000 mirrors the faces ceiling and stays under the engine's hard cap so the
 * engine never truncates first.
 */
const PLATE_WINDOW_MAX_ROWS = 10_000

/** A corpus read whose window is wider than {@link PLATE_WINDOW_MAX_ROWS}. */
class PlateWindowTooWideError extends Error {
  constructor(rows: number) {
    super(
      `plate window exceeds ${String(PLATE_WINDOW_MAX_ROWS)} rows (read ${String(rows)}) — refusing to answer with the part that fit`,
    )
    this.name = 'PlateWindowTooWideError'
  }
}

export interface Plate {
  readonly id: string
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly text: string
  readonly score: number
  readonly mediaId?: number
  readonly corrected: boolean
  readonly recognizedVehicleId?: string
  readonly assigned: boolean
  readonly assignedSampleId?: string
  /** keyFrame parity: MediaStore row id of the track's native key frame. */
  readonly keyFrameMediaId?: number
  /** keyFrame parity: the plate bbox (pixel space) on the key frame. */
  readonly plateBbox?: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
}

/**
 * A plate patch: every column of {@link Plate} bar its id, with the nullable
 * media references also accepting `null` to CLEAR them (D482).
 */
export type PlateColumnPatch = Partial<Omit<Plate, 'id' | 'mediaId' | 'keyFrameMediaId'>> & {
  readonly mediaId?: number | null
  readonly keyFrameMediaId?: number | null
}

export interface PlateStoreDeps {
  readonly logger: IScopedLogger
  readonly plateLedger: EventLedgerCollection
}

export class PlateStore {
  private readonly logger: IScopedLogger
  private readonly ledger: EventLedgerCollection

  constructor(deps: PlateStoreDeps) {
    this.logger = deps.logger
    this.ledger = deps.plateLedger
  }

  /** Upsert one buffered plate read (keyed by `plate.id` = `plate-${trackId}`). */
  async insert(plate: Plate): Promise<void> {
    const { id, ...rest } = plate
    try {
      await this.ledger.upsertRow(id, rest as Record<string, unknown>)
    } catch (err) {
      this.logger.warn('PlateStore.insert failed', {
        tags: { deviceId: plate.deviceId },
        meta: { plateId: id, error: String(err) },
      })
    }
  }

  private normalizeRow(r: { id: string; data: unknown }): Plate {
    const data = r.data as Omit<Plate, 'id'> & {
      mediaId?: number | null
      recognizedVehicleId?: string | null
      assignedSampleId?: string | null
      keyFrameMediaId?: number | null
      plateBbox?: Plate['plateBbox'] | null
    }
    return {
      id: r.id,
      ...data,
      score: Number((r.data as { score?: unknown }).score ?? 0),
      corrected: Boolean((r.data as { corrected?: unknown }).corrected),
      assigned: Boolean((r.data as { assigned?: unknown }).assigned),
      mediaId: data.mediaId ?? undefined,
      recognizedVehicleId: data.recognizedVehicleId ?? undefined,
      assignedSampleId: data.assignedSampleId ?? undefined,
      keyFrameMediaId: data.keyFrameMediaId ?? undefined,
      plateBbox: data.plateBbox ?? undefined,
    }
  }

  /** Recent plate reads for one device (or all when deviceId omitted), newest first. */
  async listRecentPlates(input: { deviceId?: number; limit?: number }): Promise<readonly Plate[]> {
    const where: Record<string, unknown> = {}
    if (input.deviceId !== undefined) where['deviceId'] = input.deviceId
    const rows = await this.ledger.query({
      where,
      orderBy: { field: 'timestamp', direction: 'desc' },
      limit: input.limit ?? 200,
    })
    return rows.map((r) => this.normalizeRow(r))
  }

  /**
   * List ALL recent plate reads across devices, newest first.
   *
   * The corpus read, for the two passes whose question is not a predicate
   * (fuzzy text search, text clustering). It carries an explicit `limit` and
   * REFUSES past it rather than handing back the part that fit: without one the
   * engine imposed its own cap and truncated silently, and a search over the
   * newest 2 000 plates looks exactly like a search over all of them.
   */
  async listAllRecentPlates(input: { limit?: number }): Promise<readonly Plate[]> {
    const bounded = input.limit !== undefined
    const rows = await this.ledger.query({
      orderBy: { field: 'timestamp', direction: 'desc' },
      limit: bounded ? (input.limit ?? 0) : PLATE_WINDOW_MAX_ROWS + 1,
    })
    if (!bounded && rows.length > PLATE_WINDOW_MAX_ROWS) {
      throw new PlateWindowTooWideError(rows.length)
    }
    return rows.map((r) => this.normalizeRow(r))
  }

  /**
   * Every plate row currently attributed to a vehicle, id only.
   *
   * `deleteVehicle` detaches these before the vehicle goes. It used to list the
   * WHOLE buffer and compare in JS — the `deleteIdentity` defect verbatim, and
   * past the engine's row cap it would detach the plates that fit and leave the
   * rest pointing at a vehicle that no longer exists.
   */
  async listPlateIdsForVehicle(vehicleId: string): Promise<readonly string[]> {
    const rows = await this.ledger.query(
      {
        where: { recognizedVehicleId: vehicleId },
        orderBy: { field: 'timestamp', direction: 'desc' },
        limit: PLATE_WINDOW_MAX_ROWS + 1,
      },
      ['deviceId'],
    )
    if (rows.length > PLATE_WINDOW_MAX_ROWS) throw new PlateWindowTooWideError(rows.length)
    return rows.map((r) => r.id)
  }

  async get(plateId: string): Promise<Plate | null> {
    const row = await this.ledger.get(plateId)
    if (row === null) return null
    return this.normalizeRow({ id: plateId, data: row.data })
  }

  /** Update mutable fields (e.g. correctPlateText sets text + corrected). */
  /**
   * Patch a plate row.
   *
   * `PlateColumnPatch` widens the nullable media columns to accept `null`,
   * which is how a caller CLEARS one (`assignPlate` nulls a crop whose blob it
   * just deleted, so the reown that follows cannot try to move a resource that
   * is gone). It used to be expressed at the call site as a `null` double-cast
   * through `unknown` to `string` — a cast that stopped being even nominally
   * true when the column became a number (D482), and which the type can simply
   * say instead.
   */
  async update(plateId: string, data: PlateColumnPatch): Promise<void> {
    try {
      await this.ledger.update(plateId, data as Record<string, unknown>)
    } catch (err) {
      this.logger.warn('PlateStore.update failed', { meta: { plateId, error: String(err) } })
    }
  }

  async delete(plateId: string): Promise<void> {
    try {
      await this.ledger.deleteKey(plateId)
    } catch (err) {
      this.logger.warn('PlateStore.delete failed', { meta: { plateId, error: String(err) } })
    }
  }

  /** Flip `assigned` to true and record the vehicle + enrolled sample. */
  async markAssigned(plateId: string, vehicleId: string, sampleId?: string): Promise<void> {
    const data: Record<string, unknown> = { assigned: true, recognizedVehicleId: vehicleId }
    if (sampleId !== undefined) data['assignedSampleId'] = sampleId
    try {
      await this.ledger.update(plateId, data)
    } catch (err) {
      this.logger.warn('PlateStore.markAssigned failed', { meta: { plateId, error: String(err) } })
    }
  }

  /** Clear the assignment (assigned=false, null recognizedVehicleId + assignedSampleId). */
  async clearAssignment(plateId: string): Promise<void> {
    try {
      await this.ledger.update(plateId, {
        assigned: false,
        recognizedVehicleId: null,
        assignedSampleId: null,
      })
    } catch (err) {
      this.logger.warn('PlateStore.clearAssignment failed', {
        meta: { plateId, error: String(err) },
      })
    }
  }

  /**
   * `TrackScopedStore` contract for the retention cascade: delete the buffered
   * plate rows of the given tracks that are NOT assigned. Mirrors
   * `FaceStore.deleteByTracks` — ENROLLED (`assigned`) reads SURVIVE retention.
   * Per-track ISOLATED + best-effort per row — one bad track or row never aborts
   * the batch. (Crop media of these rows is removed by `MediaStore`.)
   */
  async deleteByTracks(trackIds: readonly string[]): Promise<readonly TrackCascadeLeafCount[]> {
    let removed = 0
    for (const trackId of trackIds) {
      try {
        const rows = await this.ledger.query({ where: { trackId } })
        // Skip assigned rows entirely — exempt from retention eviction (enrolled
        // reads survive). Same predicate as `pruneAll`.
        const eligible = rows.filter((r) => !(r.data as { assigned?: unknown }).assigned)
        for (const row of eligible) {
          try {
            await this.ledger.deleteKey(row.id)
            removed++
          } catch (err) {
            this.logger.warn('PlateStore.deleteByTracks delete failed', {
              meta: { plateId: row.id, error: String(err) },
            })
          }
        }
      } catch (err) {
        this.logger.warn('PlateStore.deleteByTracks query failed', {
          meta: { trackId, error: String(err) },
        })
      }
    }
    return [{ family: 'plates', rows: removed, bytes: 0 }]
  }

  /**
   * D683 §6.3: one plate row per track survives, under the survivor's id —
   * except that an enrolled (vehicle-assigned) row is never deleted. Mirrors
   * `FaceStore.reassignTrack`, including its H2/M2 review fixes: every write
   * that must land is VERIFIED by reading it back before the next step runs,
   * media moves BEFORE the source row is dropped, and a carried
   * `keyFrameMediaId` the media leg no longer has is dropped and logged
   * rather than left dangling.
   */
  async reassignTrack(req: TrackFusionRequest): Promise<readonly TrackFusionLeafCount[]> {
    const fromId = `plate-${req.absorbedId}`
    const toId = `plate-${req.survivorId}`
    const absorbed = await this.get(fromId)
    if (absorbed === null) return [{ family: 'plates', moved: 0, dropped: 0 }]
    const survivor = await this.get(toId)
    const rank = (p: Plate): number => (p.assigned ? 4 : 0) + (p.corrected ? 2 : 0)
    const survivorWins =
      survivor !== null &&
      (rank(survivor) > rank(absorbed) ||
        (rank(survivor) === rank(absorbed) && survivor.score >= absorbed.score))
    if (survivorWins || survivor?.assigned === true) {
      // N2: the SURVIVOR's OWN row may itself name a keyFrameMediaId the
      // media leg just dropped — independent of which row the ranking above
      // keeps, and never checked by the `stillPresent` guard below, which
      // only ever looks at the CARRIED (absorbed) row.
      if (
        survivor !== null &&
        survivor.keyFrameMediaId !== undefined &&
        !(await req.media.stillPresent(survivor.keyFrameMediaId))
      ) {
        this.logger.warn(
          "plate fusion: dropped the survivor's own keyFrameMediaId the media leg no longer has",
          {
            tags: { deviceId: req.deviceId },
            meta: { plateId: toId, droppedMediaId: survivor.keyFrameMediaId },
          },
        )
        await this.update(toId, { keyFrameMediaId: null })
        // Review P3: verify the clear landed, like every other write in this leaf.
        if ((await this.get(toId))?.keyFrameMediaId !== undefined) {
          throw new Error(
            `plate fusion: could not clear the survivor's own stale keyFrameMediaId on ${toId}`,
          )
        }
      }
      if (absorbed.assigned) return [{ family: 'plates', moved: 0, dropped: 0, kept: 1 }]
      // N3: media before row — a crash between the two must never leave
      // `plate-<absorbed>`-owned media with no row a retry can find again.
      await req.media.deleteOwner('plate', fromId)
      await this.delete(fromId)
      if ((await this.get(fromId)) !== null) {
        throw new Error(`plate fusion: could not delete losing absorbed row ${fromId}`)
      }
      return [{ family: 'plates', moved: 0, dropped: 1 }]
    }
    if (survivor !== null) {
      await this.delete(toId)
      if ((await this.get(toId)) !== null) {
        throw new Error(`plate fusion: could not delete losing survivor row ${toId}`)
      }
      await req.media.deleteOwner('plate', toId)
    }
    const keyFrameMediaId =
      absorbed.keyFrameMediaId !== undefined &&
      (await req.media.stillPresent(absorbed.keyFrameMediaId))
        ? absorbed.keyFrameMediaId
        : undefined
    if (absorbed.keyFrameMediaId !== undefined && keyFrameMediaId === undefined) {
      this.logger.warn('plate fusion: dropped a keyFrameMediaId the media leg no longer has', {
        tags: { deviceId: req.deviceId },
        meta: { plateId: toId, droppedMediaId: absorbed.keyFrameMediaId },
      })
    }
    await this.insert({ ...absorbed, id: toId, trackId: req.survivorId, keyFrameMediaId })
    if ((await this.get(toId)) === null) {
      throw new Error(`plate fusion: insert of ${toId} did not land`)
    }
    await req.media.moveOwner('plate', fromId, toId)
    await this.delete(fromId)
    if ((await this.get(fromId)) !== null) {
      throw new Error(`plate fusion: could not delete carried-over absorbed row ${fromId}`)
    }
    return [{ family: 'plates', moved: 1, dropped: survivor !== null ? 1 : 0 }]
  }

  /**
   * Hold the unassigned plate buffer to `maxPerDevice` newest reads per camera.
   *
   * A CAPACITY bound only — the mirror of `FaceStore.pruneCapOverflow`. The age
   * half of this rule was removed with the other track-owned clocks (D61): a
   * plate read carries a `trackId` and cascades with its track.
   *
   * Corrected (human-confirmed) AND vehicle-enrolled (`assigned`) reads are
   * exempt and consume no cap slots. Returns deleted ids so the caller removes
   * their crops.
   */
  async pruneCapOverflow(input: { maxPerDevice: number }): Promise<readonly string[]> {
    const rows = await this.ledger.query({
      orderBy: { field: 'timestamp', direction: 'desc' },
    })
    const byDevice = new Map<number, { id: string; timestamp: number }[]>()
    for (const r of rows) {
      const data = r.data as {
        deviceId?: unknown
        timestamp?: unknown
        corrected?: unknown
        assigned?: unknown
      }
      // Keep human-confirmed reads AND vehicle-enrolled (assigned) reads — both
      // are retention-exempt (mirrors FaceStore's `assigned` exemption).
      if (data.corrected || data.assigned) continue
      const deviceId = Number(data.deviceId ?? -1)
      const list = byDevice.get(deviceId) ?? []
      list.push({ id: r.id, timestamp: Number(data.timestamp ?? 0) })
      byDevice.set(deviceId, list)
    }
    const toDelete = new Set<string>()
    for (const list of byDevice.values()) {
      list.sort((a, b) => b.timestamp - a.timestamp)
      list.forEach((row, idx) => {
        if (idx >= input.maxPerDevice) toDelete.add(row.id)
      })
    }
    const deleted: string[] = []
    for (const id of toDelete) {
      try {
        await this.ledger.deleteKey(id)
        deleted.push(id)
      } catch (err) {
        this.logger.warn('PlateStore.pruneCapOverflow delete failed', {
          meta: { plateId: id, error: String(err) },
        })
      }
    }
    return deleted
  }
}
