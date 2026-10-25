/**
 * NcArtifactIndex — the browsable index behind the viewer's Artifact API
 * (task #36).
 *
 * ## What it is for
 *
 * Until now a notification artefact existed only as a SIGNED ONE-SHOT LINK: the
 * dispatcher minted it, a notifier backend fetched it, and after 24 h it was
 * gone with nothing left to say it had ever existed. The operator's ask was the
 * opposite of that — *"li voglio usare sulla app viewer"* [I want to use them on the viewer app]: an artefact should be
 * something you can scroll back through, filter by camera and by rule, and open
 * again days later.
 *
 * So this is a ROW PER RETAINED ARTEFACT, and nothing else. The bytes stay
 * exactly where they already were — on {@link NcArtifactStore}'s retained shelf,
 * under the same three bounds — and this table only records what a list needs to
 * render and what a reader needs to resolve. Two stores, one truth: `expiresAt`
 * here is derived from the SHELF's age bound, so the index can never promise
 * bytes the shelf has already swept.
 *
 * ## Deliberate limits, stated rather than discovered
 *
 * - **`deviceId` is the PRIMARY camera, and it is the filter authority.** A
 *   digest mosaic spans cameras; it is filed under the rule's first camera
 *   exactly as its outbox row already is (`summary-delivery.ts`), and its full
 *   camera list rides in the record for DISPLAY. A camera filter therefore
 *   answers "artefacts filed under this camera", not "artefacts this camera
 *   appears in" — the second question is what the `ruleId` filter is for. The
 *   alternative (one row per camera per artefact) makes a cross-camera digest
 *   appear N times in one list, which is worse.
 * - **`ownerUserId` is stored as `''` for a global artefact**, not as NULL, so
 *   visibility is one comparison: `'' | userId`.
 * - **A list reads the capture window whole, newest first, then filters.** The
 *   index is a mirror of the retained shelf (2000 rows by default), and the
 *   records door serves one equality prefix plus one range per statement — kind,
 *   camera, owner, rule AND two time bounds are not one index. The window is
 *   read to the end (bounded by {@link NC_ARTIFACT_PRUNE_SCAN_LIMIT}) and the
 *   predicates applied before `offset`/`limit`, so a filter never costs a slot
 *   of the page and `total` is exact.
 * - **The index is not the notifier's authority.** A row that fails to write
 *   never costs a notification: indexing is best-effort and logged, and the
 *   signed link is minted regardless.
 */

import type { IScopedLogger, RecordKindHandle } from '@camstack/types'
import { z } from 'zod'
import type { DurableLedgerBody } from '../durable/durable-record-body.js'
import type { DurableKindDeps } from '../durable/durable-wiring.js'
import { collectRecordPages } from '../durable/query-pages.js'
import { ncDurableRecordKinds } from './nc-durable-record-kinds.js'

/**
 * @durable class=ledger owner=notification-center database=events
 *   write="one row per RETAINED artefact, written once at publish; expiresAt patched never"
 *   retention="pruned by NcArtifactStore's shelf bounds (14 d / 2000 rows / 2 GiB) — the index row falls with its bytes, on the producer node only (see prune(null) gate)"
 */
export const NC_ARTIFACTS_COLLECTION = 'notification-center:artifacts'

/**
 * `expiresAt` for a row the operator asked to keep forever (shelf window 0).
 *
 * A sentinel and not a nullable column on purpose. `expiresAt` is `NOT NULL`
 * and carries `idx_nc_artifacts_expires`; every reader asks `expiresAt <= now`.
 * Making it nullable would mean touching the column, the index and each of
 * those comparisons — and a `NULL` silently loses every one of them, because
 * `NULL <= now` is not false, it is unknown. A date no clock will reach keeps
 * one code path and one index, and it reads as the decision it is.
 */
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER

/**
 * What an artefact IS. The schema lives in the ADDON, not in `packages/types`,
 * for the same reason the summary rule's does: it ships on `camstack deploy`
 * and never waits for a framework train.
 *
 * TWO groups:
 *  - **Gallery tiles** — what the operator browses (timelapse, gif, mp4, mosaic).
 *  - **Posters** — companion stills (`timelapse-preview`, `event-still`). They
 *    exist so a video/gif tile can name its thumbnail via `posterArtifactId`.
 *    They are not a filter chip and they are omitted from an unfiltered list.
 */
export const NC_GALLERY_ARTIFACT_KINDS = [
  'timelapse',
  'event-gif',
  'event-clip',
  'summary-mosaic',
] as const
export const NC_POSTER_ARTIFACT_KINDS = ['timelapse-preview', 'event-still'] as const
export const NC_ARTIFACT_KINDS = [
  ...NC_GALLERY_ARTIFACT_KINDS,
  ...NC_POSTER_ARTIFACT_KINDS,
] as const
export const NcArtifactKindSchema = z.enum(NC_ARTIFACT_KINDS)
export type NcArtifactKind = z.infer<typeof NcArtifactKindSchema>

/** Kind a notification attachment is filed under in the gallery. */
export function artifactKindForMediaType(
  mediaType: 'image' | 'gif' | 'video',
): 'event-still' | 'event-gif' | 'event-clip' {
  if (mediaType === 'gif') return 'event-gif'
  if (mediaType === 'video') return 'event-clip'
  return 'event-still'
}

/**
 * How the viewer should DRAW it. Derived from the mime once, here, so no client
 * has to carry a mime table — and so a GIF that degraded to a JPEG is drawn as
 * the JPEG it actually is.
 */
export const NcArtifactMediaTypeSchema = z.enum(['image', 'gif', 'video'])
export type NcArtifactMediaType = z.infer<typeof NcArtifactMediaTypeSchema>

/** The relative hub path of the authenticated bytes route for an artefact id. */
export const NC_ARTIFACT_READ_PREFIX = 'nc-artifact-read'

export const NcArtifactRecordSchema = z.object({
  /** The `NcArtifactStore` id — the same id the bytes route resolves. */
  id: z.string().min(1),
  kind: NcArtifactKindSchema,
  mediaType: NcArtifactMediaTypeSchema,
  mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** When the artefact was PRODUCED. */
  createdAt: z.number().int(),
  /** What the content is ABOUT (window end / event time). The sort key: a
   *  timelapse rendered at 06:05 is about the night before, and a list ordered
   *  by production time puts it in the wrong morning. */
  capturedAt: z.number().int(),
  /** After this the bytes are gone. Derived from the retained shelf's own age
   *  bound — never a second retention policy. */
  expiresAt: z.number().int(),
  /** The camera the artefact is FILED under. Null only if it belongs to none. */
  deviceId: z.number().int().nullable(),
  /** Every camera the artefact covers, for display. */
  deviceIds: z.array(z.number().int()),
  ruleId: z.string().optional(),
  ruleName: z.string().optional(),
  title: z.string().optional(),
  /** A companion still for a video artefact (a timelapse's preview frame) —
   *  what a list renders as the thumbnail. */
  posterArtifactId: z.string().optional(),
  /** RELATIVE hub path of the authenticated bytes route. Relative on purpose:
   *  the viewer already holds the hub origin it is authenticated against, and
   *  only the SIGNED plane needs to guess which host a stranger can reach. */
  downloadPath: z.string().min(1),
})
export type NcArtifactRecord = z.infer<typeof NcArtifactRecordSchema>

/** What a producer supplies. Everything else is derived or stamped here. */
export interface NcArtifactIndexInput {
  readonly id: string
  readonly kind: NcArtifactKind
  readonly mime: string
  readonly sizeBytes: number
  readonly capturedAt: number
  readonly deviceId: number | null
  readonly deviceIds: readonly number[]
  readonly ruleId?: string
  readonly ruleName?: string
  readonly title?: string
  readonly posterArtifactId?: string
  /** Absent ⇒ a GLOBAL artefact, visible to every authenticated caller. */
  readonly ownerUserId?: string
}

/**
 * What a PRODUCER knows about the artefact it is about to publish. The three
 * missing members (`id`, `mime`, `sizeBytes`) are answers only the store has,
 * so a producer cannot get them wrong.
 */
export type NcArtifactPublishMeta = Omit<NcArtifactIndexInput, 'id' | 'mime' | 'sizeBytes'>

export const NcArtifactQuerySchema = z.object({
  kinds: z.array(NcArtifactKindSchema).optional(),
  deviceIds: z.array(z.number().int()).optional(),
  ruleId: z.string().optional(),
  /** Inclusive `capturedAt` window. */
  fromMs: z.number().int().optional(),
  toMs: z.number().int().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
})
export type NcArtifactQuery = z.infer<typeof NcArtifactQuerySchema>

/** Who is asking. Resolved server-side by the bridge action, never trusted
 *  from the input blob. */
export interface NcArtifactViewer {
  readonly userId: string
  readonly isAdmin: boolean
}

export interface NcArtifactPage {
  readonly artifacts: readonly NcArtifactRecord[]
  readonly total: number
  readonly hasMore: boolean
}

/** Lower bound of an open capture window. */
const TIME_MIN = -8_640_000_000_000_000

/** Ids per `deleteMany` — under the records batch bound. */
const ORPHAN_DELETE_BATCH = 500

/** Prune scan ceiling — the index is bounded by the shelf it mirrors (2000
 *  entries by default), so this only has to be comfortably above it. */
const NC_ARTIFACT_PRUNE_SCAN_LIMIT = 20_000

/** `image/gif` → `gif`. Keyed on what the bytes ARE, never on what was asked
 *  for: a GIF that degraded to a still must be drawn as a still. */
export function mediaTypeForMime(mime: string): NcArtifactMediaType {
  if (mime === 'image/gif') return 'gif'
  if (mime.startsWith('video/')) return 'video'
  return 'image'
}

/** The relative hub path an authenticated client fetches the bytes from. */
export function artifactDownloadPath(addonId: string, artifactId: string): string {
  return `/addon/${addonId}/${NC_ARTIFACT_READ_PREFIX}/${artifactId}`
}

export interface NcArtifactIndexDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
  /** The addon id the bytes route is served under (`pipeline-analytics`). */
  readonly addonId: string
  /** How long the retained shelf keeps bytes — the ONE retention authority. */
  readonly retentionMs: number | null
  readonly now?: () => number
}

export class NcArtifactIndex {
  /** The `artifacts` records kind (events.db). */
  private readonly rows: RecordKindHandle<DurableLedgerBody>
  private readonly logger: IScopedLogger
  private readonly addonId: string
  private readonly retentionMs: number | null
  private readonly now: () => number

  constructor(deps: NcArtifactIndexDeps) {
    this.rows = deps.records.kind(ncDurableRecordKinds.artifacts)
    this.logger = deps.logger
    this.addonId = deps.addonId
    this.retentionMs = deps.retentionMs
    this.now = deps.now ?? ((): number => Date.now())
  }

  /**
   * Record one retained artefact. Returns the row as the viewer will see it, or
   * null when the write failed — and a failure is LOGGED, per camera: an
   * artefact silently absent from the index reads to an operator as an artefact
   * that was never produced.
   */
  async record(input: NcArtifactIndexInput): Promise<NcArtifactRecord | null> {
    const createdAt = this.now()
    const record = NcArtifactRecordSchema.parse({
      id: input.id,
      kind: input.kind,
      mediaType: mediaTypeForMime(input.mime),
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      createdAt,
      capturedAt: input.capturedAt,
      expiresAt: this.retentionMs === null ? NEVER_EXPIRES : createdAt + this.retentionMs,
      deviceId: input.deviceId,
      deviceIds: [...input.deviceIds],
      ...(input.ruleId !== undefined ? { ruleId: input.ruleId } : {}),
      ...(input.ruleName !== undefined ? { ruleName: input.ruleName } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.posterArtifactId !== undefined ? { posterArtifactId: input.posterArtifactId } : {}),
      downloadPath: artifactDownloadPath(this.addonId, input.id),
    })
    try {
      await this.rows.put({
        id: record.id,
        ...(record.deviceId !== null ? { deviceId: record.deviceId } : {}),
        data: artifactRowBody(record, input.ownerUserId ?? ''),
      })
      return record
    } catch (err) {
      this.logger.warn('artifact not indexed — it will not appear in the viewer', {
        ...(record.deviceId !== null ? { tags: { deviceId: record.deviceId } } : {}),
        meta: { artifactId: record.id, kind: record.kind, error: String(err) },
      })
      return null
    }
  }

  /**
   * One page, newest `capturedAt` first.
   *
   * Expiry is a PREDICATE, not a post-filter: a row whose bytes the shelf has
   * already swept must not consume a slot of the page the caller asked for.
   */
  async list(query: NcArtifactQuery, viewer: NcArtifactViewer): Promise<NcArtifactPage> {
    try {
      const { rows, truncated } = await collectRecordPages(
        this.rows,
        {
          where: {
            capturedAt: {
              gte: query.fromMs ?? TIME_MIN,
              ...(query.toMs !== undefined ? { lte: query.toMs } : {}),
            },
          },
          desc: true,
        },
        NC_ARTIFACT_PRUNE_SCAN_LIMIT,
      )
      if (truncated) {
        this.logger.warn('artifact list read hit its scan bound — older rows were not considered', {
          meta: { limit: NC_ARTIFACT_PRUNE_SCAN_LIMIT },
        })
      }
      const keep = this.predicate(query, viewer)
      const matching = this.parseRows(rows.filter((r) => keep(r.data)))
      const artifacts = matching.slice(query.offset, query.offset + query.limit)
      return {
        artifacts,
        total: matching.length,
        hasMore: query.offset + artifacts.length < matching.length,
      }
    } catch (err) {
      this.logger.warn('artifact index query failed', { meta: { error: String(err) } })
      return { artifacts: [], total: 0, hasMore: false }
    }
  }

  /**
   * One artefact by id, or null when it does not exist, has expired, or belongs
   * to another user. All three answer the same way ON PURPOSE — a surface that
   * distinguishes "not yours" from "not there" tells a caller what other people
   * own.
   */
  async get(artifactId: string, viewer: NcArtifactViewer): Promise<NcArtifactRecord | null> {
    const row = await this.readRow(artifactId)
    if (row === null) return null
    if (row.record.expiresAt <= this.now()) return null
    if (!viewer.isAdmin && row.ownerUserId !== '' && row.ownerUserId !== viewer.userId) return null
    return row.record
  }

  /**
   * Drop one artefact's ROW, and its poster's with it.
   *
   * Two rules, and both differ from {@link get}:
   *
   *  - **ownership, not visibility.** A GLOBAL artefact is visible to everyone
   *    and removable only by an admin. Seeing a digest the hub produced for the
   *    household is not the same permission as deleting it.
   *  - **a poster goes with its video.** A timelapse's still is indexed as its
   *    own row and listed only through `posterArtifactId`; leaving it behind
   *    makes a row nothing lists and bytes nothing names. This repo has spent
   *    two sessions on exactly that shape in other tables.
   *
   * Returns the ids whose rows are gone — empty when there was nothing to do OR
   * nothing the caller may remove, deliberately the same answer: a surface that
   * distinguished them would report what other people own.
   */
  async deleteOwned(artifactId: string, viewer: NcArtifactViewer): Promise<readonly string[]> {
    const row = await this.readRow(artifactId)
    if (row === null) return []
    if (!viewer.isAdmin && (row.ownerUserId === '' || row.ownerUserId !== viewer.userId)) return []
    const ids = [artifactId]
    const poster = row.record.posterArtifactId
    if (poster !== undefined && poster.length > 0 && poster !== artifactId) ids.push(poster)
    const gone: string[] = []
    for (const id of ids) {
      try {
        await this.rows.delete(id)
        gone.push(id)
      } catch (err) {
        this.logger.warn('artifact row could not be deleted', {
          meta: { artifactId: id, error: String(err) },
        })
      }
    }
    return gone
  }

  /**
   * Resolve an id for the BYTES route — visibility-free by design.
   *
   * The route is served `authenticated`, so the hub has already established a
   * principal; what this answers is only "is this id an indexed artefact, and is
   * it still meant to exist". Per-user artefact scoping on the byte route would
   * be a second authorization model layered on an unguessable id, and this repo
   * has one of those already (`data-plane-access.ts`): a plane serving ONE item
   * the caller had to be told about is `authenticated`.
   */
  async resolve(artifactId: string): Promise<NcArtifactRecord | null> {
    const row = await this.readRow(artifactId)
    return row?.record ?? null
  }

  /** One row by primary key, parsed. Null when absent or no longer valid. */
  private async readRow(
    artifactId: string,
  ): Promise<{ record: NcArtifactRecord; ownerUserId: string } | null> {
    let row: Record<string, unknown>
    try {
      const found = await this.rows.get(artifactId)
      if (found === null) return null
      row = found.data
    } catch (err) {
      this.logger.warn('artifact index lookup failed', {
        meta: { artifactId, error: String(err) },
      })
      return null
    }
    const parsed = NcArtifactRecordSchema.safeParse(row['record'])
    if (!parsed.success) return null
    const owner = row['ownerUserId']
    return { record: parsed.data, ownerUserId: typeof owner === 'string' ? owner : '' }
  }

  /**
   * Drop rows whose bytes are gone, in ONE `deleteWhere` rather than an N+1
   * drain.
   *
   * TWO halves, and only one of them is safe everywhere:
   *
   * - **Expired rows** are time-based and node-independent. Always swept.
   * - **Orphans** — rows whose file a byte/count bound took before the age bound
   *   did — are found by reconciling against the shelf. That reconcile is only
   *   valid for a caller whose shelf holds the bytes for the WHOLE index, and
   *   the index is CENTRAL while the shelf is local: a second node running this
   *   with its own (empty) shelf would read every row as an orphan and delete
   *   the entire library. Hence `keptIds: null` — a caller that is not the
   *   producing node states so, and the destructive half becomes unreachable
   *   rather than merely un-called.
   *
   * @param keptIds the ids the caller's shelf holds, or `null` when this node is
   *                not the one that produces artefacts.
   */
  async prune(keptIds: readonly string[] | null): Promise<number> {
    let removed = 0
    try {
      const expired = await this.rows.deleteWhere({
        where: { expiresAt: { lt: this.now() } },
      })
      removed += expired
      if (keptIds === null) {
        if (removed > 0) {
          this.logger.debug('artifact index pruned (expired only)', { meta: { removed } })
        }
        return removed
      }
      const alive = new Set(keptIds)
      // Every row, by id. A records page carries the whole row (there is no
      // projection); the table is bounded by the shelf it mirrors.
      const { rows } = await collectRecordPages(this.rows, {}, NC_ARTIFACT_PRUNE_SCAN_LIMIT)
      const orphans = rows.map((r) => r.id).filter((id) => !alive.has(id))
      for (let at = 0; at < orphans.length; at += ORPHAN_DELETE_BATCH) {
        removed += await this.rows.deleteMany(orphans.slice(at, at + ORPHAN_DELETE_BATCH))
      }
      if (removed > 0) {
        this.logger.debug('artifact index pruned', {
          meta: { removed, expired, orphaned: orphans.length },
        })
      }
      return removed
    } catch (err) {
      this.logger.warn('artifact index prune failed', { meta: { error: String(err) } })
      return removed
    }
  }

  /**
   * The list predicate over one row body: visibility (a caller sees global
   * artefacts plus his own; an admin sees every one), kind, camera, rule and
   * expiry. Expiry is part of the predicate, never a post-page filter: a row the
   * shelf has already swept must not consume a slot of the page.
   */
  private predicate(
    query: NcArtifactQuery,
    viewer: NcArtifactViewer,
  ): (row: Record<string, unknown>) => boolean {
    // Unfiltered list = gallery tiles. Posters stay addressable by id (the
    // video row's `posterArtifactId`) and by an explicit `kinds` filter, but
    // they must not appear as their own cards.
    const kinds: ReadonlySet<unknown> = new Set<unknown>(
      query.kinds !== undefined && query.kinds.length > 0 ? query.kinds : NC_GALLERY_ARTIFACT_KINDS,
    )
    const devices: ReadonlySet<unknown> | null =
      query.deviceIds !== undefined && query.deviceIds.length > 0
        ? new Set<unknown>(query.deviceIds)
        : null
    const now = this.now()
    return (row) => {
      if (!viewer.isAdmin && row['ownerUserId'] !== '' && row['ownerUserId'] !== viewer.userId) {
        return false
      }
      if (!kinds.has(row['kind'])) return false
      if (devices !== null && !devices.has(row['deviceId'])) return false
      if (query.ruleId !== undefined && row['ruleId'] !== query.ruleId) return false
      const expiresAt = row['expiresAt']
      return typeof expiresAt === 'number' && expiresAt >= now
    }
  }

  /** Parse the record body, skipping rows that no longer validate. A degraded
   *  row must never cost the whole page. */
  private parseRows(
    rows: ReadonlyArray<{ readonly id: string; readonly data: Record<string, unknown> }>,
  ): readonly NcArtifactRecord[] {
    const out: NcArtifactRecord[] = []
    let skipped = 0
    for (const row of rows) {
      const parsed = NcArtifactRecordSchema.safeParse(row.data['record'])
      if (!parsed.success) {
        skipped += 1
        continue
      }
      out.push(parsed.data)
    }
    if (skipped > 0) {
      this.logger.warn('artifact index rows skipped as invalid', { meta: { skipped } })
    }
    return out
  }
}

/**
 * One artefact as its row body: the indexed scalars beside the full record. The
 * legacy table's column map, which the adoption mapper reproduces exactly.
 */
function artifactRowBody(record: NcArtifactRecord, ownerUserId: string): Record<string, unknown> {
  return {
    kind: record.kind,
    deviceId: record.deviceId,
    ruleId: record.ruleId ?? '',
    ownerUserId,
    capturedAt: record.capturedAt,
    expiresAt: record.expiresAt,
    record,
  }
}
