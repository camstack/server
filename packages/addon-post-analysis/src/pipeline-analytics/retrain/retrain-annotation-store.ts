/**
 * RetrainAnnotationStore — the ground truth an operator drew.
 *
 * Collection: `pipeline-analytics:retrain-annotations`.
 *
 * One row per SUBJECT, not per frame: a frame with four people is four rows,
 * and that is the point. A frame annotated with one box and three unlabelled
 * people teaches the detector that two thirds of the people in it are
 * background, so the page annotates every subject and this table is what
 * records that it did.
 *
 * ## Three fields that must never be one
 *
 * `macroClass` / `label` / `subLabel` are SEPARATE TIERS.
 * `person` is a macro class; `postman` is a label; a specific person's name is a
 * sub-label. A schema that lets them share a field produces a taxonomy that
 * cannot be exported per model — you can no longer answer "every person box"
 * without knowing every label anyone ever typed. The tiers are enforced in the
 * cap schema (a macro class is refused as a label) and mirrored here.
 *
 * ## `kind: 'model_error'`
 *
 * A false positive is taught by OMISSION — the frame enters the dataset fully
 * annotated and deliberately WITHOUT the box the model drew. What makes that
 * usable rather than indistinguishable from a frame nobody finished is a row
 * that says the omission was deliberate, with the model and score that produced
 * the phantom. That row is also the post-fine-tune regression test.
 *
 * `bbox` is normalised `[0,1]` against the FULL frame, always. The per-model
 * shapes are derived at export from this one rectangle — see
 * `retrain-geometry.ts` for why storing them would rebuild the CLIP failure.
 */

import type {
  IScopedLogger,
  NativeCropBbox,
  PreparedTransactOp,
  RetrainDismissed,
  RetrainMacroClass,
  RetrainOrigin,
  RetrainAnnotationSource as WireAnnotationSource,
} from '@camstack/types'
import type { EventLedgerCollection } from '../store/event-ledger-collection.js'
import { KeyedCommitLock } from './keyed-commit-lock.js'
import { narrowOrigin } from './retrain-origin.js'
import { isRetrainMacroClass } from './retrain-taxonomy.js'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per SUBJECT an operator annotates on a copied retrain frame —
 *     four people in a frame is four rows — plus the 'model_error' rows that record
 *     a deliberate omission with the model and score that produced the phantom.
 *     Writes go through replaceForFrame, which rewrites a frame's whole set so a
 *     box the operator removed cannot survive as a stale row."
 *   retention="none — nothing ages these out and no owner cascade reaches them. The
 *     dataset addresses COPIES (D81), so a track being evicted, even a 'trained'
 *     one, leaves the annotations standing. Rows go only when the operator
 *     deselects the frame (deleteForFrame, always before the copy itself). Bounded
 *     only by how much the operator annotates."
 */
export const RETRAIN_ANNOTATIONS_COLLECTION = 'pipeline-analytics:retrain-annotations'

export const RETRAIN_ANNOTATION_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'trackId', type: 'TEXT' as const, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  /** The COPY in retrain storage — never the original's media key. */
  { name: 'mediaKey', type: 'TEXT' as const, notNull: true },
  { name: 'bbox', type: 'JSON' as const, notNull: true },
  { name: 'macroClass', type: 'TEXT' as const, notNull: true },
  { name: 'label', type: 'TEXT' as const },
  { name: 'subLabel', type: 'TEXT' as const },
  { name: 'kind', type: 'TEXT' as const, notNull: true },
  { name: 'source', type: 'TEXT' as const, notNull: true },
  { name: 'assistModelId', type: 'TEXT' as const },
  { name: 'assistScore', type: 'REAL' as const },
  /** The proposal the box started from (`RetrainOrigin`), snapshotted at
   *  accept time. NULL on a row saved before origins existed. */
  { name: 'origin', type: 'JSON' as const },
  { name: 'exportedInBatch', type: 'TEXT' as const },
  { name: 'createdAt', type: 'INTEGER' as const, notNull: true },
] as const

/** Is this a subject to learn, or a phantom to unlearn? */
export type RetrainAnnotationKind = 'subject' | 'model_error'
/** Where the box came from — the cap's own union (a human, the assist on
 *  the copy, the live pipeline's box, or a vision LLM). Provenance only. */
export type RetrainAnnotationSource = WireAnnotationSource

const ANNOTATION_SOURCES: readonly RetrainAnnotationSource[] = [
  'operator',
  'assist',
  'pipeline',
  'llm',
]

/** The stored source, narrowed. Unknown reads as `operator` — the least
 *  presumptuous claim a row can make about who drew it. */
function narrowSource(value: unknown): RetrainAnnotationSource {
  return ANNOTATION_SOURCES.find((source) => source === value) ?? 'operator'
}

export interface RetrainAnnotation {
  readonly id: string
  /** The frame's track — `''` on a recording still, which has none. */
  readonly trackId: string
  readonly deviceId: number
  /** Key in the RETRAIN frame store — the copy. */
  readonly mediaKey: string
  /** Normalised `[0,1]` against the full frame. */
  readonly bbox: NativeCropBbox
  readonly macroClass: RetrainMacroClass
  readonly label?: string
  readonly subLabel?: string
  readonly kind: RetrainAnnotationKind
  readonly source: RetrainAnnotationSource
  readonly assistModelId?: string
  readonly assistScore?: number
  /** The proposal this box started from; `null` on a pre-origin row. */
  /** Absent or `null` on a row saved before origins existed. */
  readonly origin?: RetrainOrigin | null
  readonly exportedInBatch?: string
  readonly createdAt: number
}

/** An annotation as the writer supplies it — the store assigns id + createdAt. */
export type RetrainAnnotationDraft = Omit<RetrainAnnotation, 'id' | 'createdAt'>

export interface RetrainAnnotationStoreDeps {
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly newId: () => string
  readonly annotationLedger: EventLedgerCollection
  readonly frameLedger: EventLedgerCollection
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The stored class, narrowed to the closed macro set. */
function narrowMacroClass(value: unknown): RetrainMacroClass {
  return typeof value === 'string' && isRetrainMacroClass(value) ? value : 'person'
}

/** Frame ids per `IN (…)` page in {@link RetrainAnnotationStore.listByFrames}. */
const LIST_BY_FRAMES_PAGE = 500

function idsFromCountGroups(
  groups: readonly { readonly group: string | number | null; readonly value: number | null }[],
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const group of groups) {
    if (typeof group.group === 'string' && group.group.length > 0 && (group.value ?? 0) > 0) {
      ids.add(group.group)
    }
  }
  return ids
}

/** The frame-row half of an annotation save. */
export interface RetrainFrameCommit {
  /** The revision the frame must still be at; the guard of the transaction. */
  readonly fromRevision: number
  /** Replace the frame's dismissed set; absent ⇒ leave it as it is. */
  readonly dismissed?: readonly RetrainDismissed[]
}

export type RetrainReplaceResult =
  | {
      readonly kind: 'saved'
      readonly rows: readonly RetrainAnnotation[]
      readonly revision: number
    }
  /** `currentRevision` is `null` when the frame row is gone. */
  | { readonly kind: 'conflict'; readonly currentRevision: number | null }

export class RetrainAnnotationStore {
  private readonly logger: IScopedLogger
  private readonly now: () => number
  private readonly newId: () => string
  private readonly annotations: EventLedgerCollection
  private readonly frames: EventLedgerCollection
  private readonly recordsFrameCommitLock = new KeyedCommitLock<string>()

  constructor(deps: RetrainAnnotationStoreDeps) {
    this.logger = deps.logger
    this.now = deps.now
    this.newId = deps.newId
    this.annotations = deps.annotationLedger
    this.frames = deps.frameLedger
  }

  private rowToAnnotation(id: string, data: Record<string, unknown>): RetrainAnnotation {
    const bbox = (data['bbox'] ?? { x: 0, y: 0, w: 0, h: 0 }) as NativeCropBbox
    const score = data['assistScore']
    return {
      id,
      trackId: String(data['trackId'] ?? ''),
      deviceId: Number(data['deviceId'] ?? 0),
      mediaKey: String(data['mediaKey'] ?? ''),
      bbox,
      // NARROWED, never cast: a row whose class is not in the closed set is a
      // row written by something that did not go through the guard, and reading
      // it as `person` is the least-wrong answer that stays representable.
      macroClass: narrowMacroClass(data['macroClass']),
      label: optionalString(data['label']),
      subLabel: optionalString(data['subLabel']),
      kind: data['kind'] === 'model_error' ? 'model_error' : 'subject',
      source: narrowSource(data['source']),
      assistModelId: optionalString(data['assistModelId']),
      assistScore: typeof score === 'number' ? score : undefined,
      origin: narrowOrigin(data['origin']),
      exportedInBatch: optionalString(data['exportedInBatch']),
      createdAt: Number(data['createdAt'] ?? 0),
    }
  }

  private toRecord(a: RetrainAnnotation): Record<string, unknown> {
    return {
      trackId: a.trackId,
      deviceId: a.deviceId,
      mediaKey: a.mediaKey,
      bbox: a.bbox,
      macroClass: a.macroClass,
      label: a.label ?? null,
      subLabel: a.subLabel ?? null,
      kind: a.kind,
      source: a.source,
      assistModelId: a.assistModelId ?? null,
      assistScore: a.assistScore ?? null,
      origin: a.origin ?? null,
      exportedInBatch: a.exportedInBatch ?? null,
      createdAt: a.createdAt,
    }
  }

  /**
   * Replace EVERY annotation on one frame with the supplied set — atomically,
   * and only if the frame is still at the revision the caller saw.
   *
   * Whole-frame replacement rather than per-box upsert, deliberately: the unit
   * of ground truth is the frame, and "the operator deleted a box" and "the
   * operator never drew it" have to be the same durable outcome. A per-box
   * patch API would let a frame keep a box the operator removed on a surface
   * that only knew about the boxes it sent.
   *
   * The old rows' deletion, the new rows, the frame's `dismissed` set and its
   * bumped `revision` run under a per-frame commit lock, guarded by
   * `commit.fromRevision`: a concurrent save in this process leaves one winner
   * and one `conflict` — never a blend. The deletion, the new rows and the frame
   * row are ONE records `transact` (the four retrain kinds share a family): a
   * failure leaves the frame exactly as it was.
   *
   * Returns the persisted rows so the caller renders ids it can address.
   */
  async replaceForFrame(
    mediaKey: string,
    drafts: readonly RetrainAnnotationDraft[],
    commit: RetrainFrameCommit,
  ): Promise<RetrainReplaceResult> {
    const createdAt = this.now()
    const rows = drafts.map(
      (d): RetrainAnnotation => ({
        ...d,
        origin: d.origin ?? null,
        id: this.newId(),
        createdAt,
        mediaKey,
      }),
    )
    const nextRevision = commit.fromRevision + 1
    return this.recordsFrameCommitLock.run(mediaKey, () =>
      this.replaceForFrameOnRecords(mediaKey, rows, commit, nextRevision),
    )
  }

  /**
   * Set `origin` on rows that have none, under the same per-frame commit lock
   * and `fromRevision` guard, with a revision bump. Rows that already carry an origin, or are not on this frame,
   * are left untouched and not counted. No eligible row ⇒ no write at all.
   */
  async setOrigins(
    mediaKey: string,
    origins: ReadonlyMap<string, RetrainOrigin>,
    commit: RetrainFrameCommit,
  ): Promise<
    | { readonly kind: 'updated'; readonly updated: number; readonly revision: number }
    | { readonly kind: 'conflict'; readonly currentRevision: number | null }
  > {
    const eligible = (await this.listByFrame(mediaKey)).filter(
      (row) => !row.origin && origins.has(row.id),
    )
    if (eligible.length === 0) {
      return { kind: 'updated', updated: 0, revision: commit.fromRevision }
    }
    const nextRevision = commit.fromRevision + 1
    return this.recordsFrameCommitLock.run(mediaKey, () =>
      this.setOriginsOnRecords(mediaKey, eligible, origins, commit, nextRevision),
    )
  }

  async listByFrame(mediaKey: string): Promise<readonly RetrainAnnotation[]> {
    return this.queryWhere({ mediaKey }, `frame ${mediaKey}`)
  }

  /**
   * Frame ids that have at least one annotation. A `deviceId` restricts the
   * count to that camera. Served by `media` / `device_media` — ids and counts,
   * not annotation bodies.
   */
  async annotatedFrameIds(deviceId?: number): Promise<ReadonlySet<string>> {
    try {
      const groups = await this.annotations.countGroupedBy(
        'mediaKey',
        deviceId === undefined ? undefined : { deviceId },
      )
      return idsFromCountGroups(groups)
    } catch (err) {
      this.logger.warn('RetrainAnnotationStore.annotatedFrameIds failed', {
        ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
        meta: { error: String(err) },
      })
      throw err
    }
  }

  /**
   * Frames carrying at least one of these classes. One covering group per
   * class (`class_media`); the frame id set is the union.
   */
  async frameIdsWithAnyClass(classes: readonly RetrainMacroClass[]): Promise<ReadonlySet<string>> {
    const ids = new Set<string>()
    try {
      for (const macroClass of classes) {
        const groups = await this.annotations.countGroupedBy('mediaKey', { macroClass })
        for (const id of idsFromCountGroups(groups)) ids.add(id)
      }
      return ids
    } catch (err) {
      this.logger.warn('RetrainAnnotationStore.frameIdsWithAnyClass failed', {
        meta: { classes: classes.length, error: String(err) },
      })
      throw err
    }
  }

  /** Every annotation of these frames, oldest first — paged `IN (…)`. */
  async listByFrames(mediaKeys: readonly string[]): Promise<readonly RetrainAnnotation[]> {
    const out: RetrainAnnotation[] = []
    for (let i = 0; i < mediaKeys.length; i += LIST_BY_FRAMES_PAGE) {
      const page = mediaKeys.slice(i, i + LIST_BY_FRAMES_PAGE)
      try {
        const rows = await this.annotations.query({
          whereIn: { mediaKey: [...page] },
          orderBy: { field: 'createdAt', direction: 'asc' },
        })
        for (const r of rows) {
          if (typeof r.id === 'string') {
            out.push(this.rowToAnnotation(r.id, r.data as Record<string, unknown>))
          }
        }
      } catch (err) {
        this.logger.warn('RetrainAnnotationStore.listByFrames failed', {
          meta: { frames: page.length, error: String(err) },
        })
      }
    }
    return out
  }

  async listByTrack(trackId: string): Promise<readonly RetrainAnnotation[]> {
    return this.queryWhere({ trackId }, `track ${trackId}`)
  }

  /** Annotation counts per track — one query for the whole staging list. */
  async countsByTrack(trackIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>()
    if (trackIds.length === 0) return counts
    try {
      const rows = await this.annotations.query({ whereIn: { trackId: [...trackIds] } })
      for (const r of rows) {
        const trackId = String((r.data as Record<string, unknown>)['trackId'] ?? '')
        if (trackId === '') continue
        counts.set(trackId, (counts.get(trackId) ?? 0) + 1)
      }
    } catch (err) {
      this.logger.warn('RetrainAnnotationStore.countsByTrack failed', {
        meta: { tracks: trackIds.length, error: String(err) },
      })
    }
    return counts
  }

  /** Every annotation of a device, newest first — the export selection. */
  async listByDevice(deviceId: number, limit: number): Promise<readonly RetrainAnnotation[]> {
    try {
      const rows = await this.annotations.query({
        where: { deviceId },
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit,
      })
      return rows
        .filter((r): r is typeof r & { id: string } => typeof r.id === 'string')
        .map((r) => this.rowToAnnotation(r.id, r.data as Record<string, unknown>))
    } catch (err) {
      this.logger.warn('RetrainAnnotationStore.listByDevice failed', {
        tags: { deviceId },
        meta: { deviceId, error: String(err) },
      })
      return []
    }
  }

  /** Stamp a batch id on rows an export consumed. Best-effort per row: a stamp
   *  that fails must not fail the export the operator already downloaded. */
  async markExported(ids: readonly string[], batchId: string): Promise<number> {
    let stamped = 0
    for (const id of ids) {
      try {
        await this.annotations.update(id, { exportedInBatch: batchId })
        stamped += 1
      } catch (err) {
        this.logger.warn('retrain annotation export stamp failed', {
          meta: { annotationId: id, batchId, error: String(err) },
        })
      }
    }
    return stamped
  }

  /**
   * The delete ops of every annotation of a frame, for ONE transaction with
   * the frame row and its memberships (RetrainService.removeFrame). A failed
   * read THROWS: "no annotations" must never be the answer to an unreadable
   * store, because the frame row would then be deleted over live boxes.
   */
  async deleteOpsForFrame(mediaKey: string): Promise<readonly PreparedTransactOp[]> {
    const rows = await this.annotations.query({ where: { mediaKey } })
    return rows.map((row) => this.annotations.txDelete(row.id))
  }

  private async replaceForFrameOnRecords(
    mediaKey: string,
    rows: readonly RetrainAnnotation[],
    commit: RetrainFrameCommit,
    nextRevision: number,
  ): Promise<RetrainReplaceResult> {
    const frame = await this.frames.get(mediaKey)
    if (frame === null) {
      return { kind: 'conflict', currentRevision: null }
    }
    const currentRevision = Number(frame.data['revision'] ?? 0)
    if (currentRevision !== commit.fromRevision) {
      return { kind: 'conflict', currentRevision }
    }
    const ops: PreparedTransactOp[] = []
    for (const existing of await this.annotations.query({ where: { mediaKey } })) {
      ops.push(this.annotations.txDelete(existing.id))
    }
    for (const row of rows) {
      ops.push(await this.annotations.txUpsert(row.id, this.toRecord(row)))
    }
    ops.push(
      await this.frames.txUpdate(mediaKey, {
        revision: nextRevision,
        ...(commit.dismissed !== undefined ? { dismissed: [...commit.dismissed] } : {}),
      }),
    )
    await this.frames.transact(ops)
    return { kind: 'saved', rows, revision: nextRevision }
  }

  private async setOriginsOnRecords(
    mediaKey: string,
    eligible: readonly RetrainAnnotation[],
    origins: ReadonlyMap<string, RetrainOrigin>,
    commit: RetrainFrameCommit,
    nextRevision: number,
  ): Promise<
    | { readonly kind: 'updated'; readonly updated: number; readonly revision: number }
    | { readonly kind: 'conflict'; readonly currentRevision: number | null }
  > {
    const frame = await this.frames.get(mediaKey)
    if (frame === null) {
      return { kind: 'conflict', currentRevision: null }
    }
    const currentRevision = Number(frame.data['revision'] ?? 0)
    if (currentRevision !== commit.fromRevision) {
      return { kind: 'conflict', currentRevision }
    }
    const ops: PreparedTransactOp[] = []
    for (const row of eligible) {
      ops.push(await this.annotations.txUpdate(row.id, { origin: origins.get(row.id) ?? null }))
    }
    ops.push(await this.frames.txUpdate(mediaKey, { revision: nextRevision }))
    await this.frames.transact(ops)
    return { kind: 'updated', updated: eligible.length, revision: nextRevision }
  }

  private async queryWhere(
    where: Record<string, string>,
    scope: string,
  ): Promise<readonly RetrainAnnotation[]> {
    try {
      const rows = await this.annotations.query({
        where,
        orderBy: { field: 'createdAt', direction: 'asc' },
      })
      return rows
        .filter((r): r is typeof r & { id: string } => typeof r.id === 'string')
        .map((r) => this.rowToAnnotation(r.id, r.data as Record<string, unknown>))
    } catch (err) {
      this.logger.warn('RetrainAnnotationStore query failed', {
        meta: { scope, error: String(err) },
      })
      return []
    }
  }
}
