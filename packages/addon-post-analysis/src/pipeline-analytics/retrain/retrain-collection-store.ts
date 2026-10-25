/**
 * RetrainCollectionStore — named sets over the one retrain corpus.
 *
 * Collections: `pipeline-analytics:retrain-collections` (the names) and
 * `pipeline-analytics:retrain-collection-frames` (the membership).
 *
 * A collection OWNS NO PIXELS. Every frame — copied from a track or stilled
 * from the recording — lives once in `retrain-frames`, with its annotations,
 * its completeness and its export path; a collection is a name the operator
 * gives to a subset of it ("packages porch night", "false-positive cars"). So
 * a frame can be in several collections, a collection's count is its
 * membership, and deleting a collection removes memberships, never a frame
 * another collection or a track still holds. Which trackless frames are left
 * with no reason to exist is the caller's question
 * (`retrain-collection-service.ts`).
 */

import { createHash } from 'node:crypto'
import type { IScopedLogger, PreparedTransactOp } from '@camstack/types'
import type { EventLedgerCollection } from '../store/event-ledger-collection.js'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per named training collection the operator creates. Names are
 *     unique on nameKey (lower(trim)); empty names never become rows. A rename
 *     rewrites name + nameKey under the same id."
 *   retention="none — operator-owned corpus metadata. A row leaves only when the
 *     operator deletes the collection (deleteRetrainCollection), which removes its
 *     membership rows first."
 */
export const RETRAIN_COLLECTIONS_COLLECTION = 'pipeline-analytics:retrain-collections'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per (collection, frame) pair the operator adds — a frame added
 *     from the recording, or an existing retrain frame added to a collection. Keyed
 *     by a hash of the pair, so adding twice is one row."
 *   retention="none — rows leave when the operator removes the frame from the
 *     collection, deletes the collection, or deselects the frame itself. Bounded by
 *     operator curation."
 */
export const RETRAIN_COLLECTION_FRAMES_COLLECTION = 'pipeline-analytics:retrain-collection-frames'

export interface RetrainCollection {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly frameCount: number
}

export type RetrainCollectionCreateResult =
  | { readonly kind: 'created'; readonly collection: RetrainCollection }
  | { readonly kind: 'refused'; readonly reason: 'empty-name' | 'duplicate-name' }

export type RetrainCollectionRenameResult =
  | { readonly kind: 'renamed'; readonly collection: RetrainCollection }
  | {
      readonly kind: 'refused'
      readonly reason: 'empty-name' | 'duplicate-name' | 'unknown-collection'
    }

export interface RetrainCollectionDeleteResult {
  readonly deleted: boolean
  /** The frames that were members — the caller decides which are now orphans. */
  readonly memberFrameIds: readonly string[]
}

export interface RetrainCollectionStoreDeps {
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly newId: () => string
  readonly collectionLedger: EventLedgerCollection
  readonly membershipLedger: EventLedgerCollection
}

function normalizeCollectionName(raw: string): { name: string; nameKey: string } | null {
  const name = raw.trim()
  if (name.length === 0) return null
  return { name, nameKey: name.toLowerCase() }
}

/** The membership row's key — one row per pair, whatever the ids contain. */
function membershipKey(collectionId: string, frameId: string): string {
  return createHash('sha1').update(`${collectionId}\u0000${frameId}`).digest('hex')
}

/** Ids per `IN (…)` page. */
const IN_PAGE = 500

interface Row {
  readonly id: string
  readonly data: Record<string, unknown>
}

export class RetrainCollectionStore {
  private readonly logger: IScopedLogger
  private readonly now: () => number
  private readonly newId: () => string
  private readonly collections: EventLedgerCollection
  private readonly memberships: EventLedgerCollection

  constructor(deps: RetrainCollectionStoreDeps) {
    this.logger = deps.logger
    this.now = deps.now
    this.newId = deps.newId
    this.collections = deps.collectionLedger
    this.memberships = deps.membershipLedger
  }

  async create(input: { name: string }): Promise<RetrainCollectionCreateResult> {
    const normalized = normalizeCollectionName(input.name)
    if (normalized === null) return { kind: 'refused', reason: 'empty-name' }
    if ((await this.findIdByNameKey(normalized.nameKey)) !== null) {
      return { kind: 'refused', reason: 'duplicate-name' }
    }
    const createdAt = this.now()
    const id = this.newId()
    await this.collections.upsertRow(id, {
      name: normalized.name,
      nameKey: normalized.nameKey,
      createdAt,
      updatedAt: createdAt,
    })
    this.logger.info('retrain collection created', { meta: { collectionId: id } })
    return { kind: 'created', collection: { id, name: normalized.name, createdAt, frameCount: 0 } }
  }

  /** Every collection, newest first, each with its membership count (one query). */
  async list(): Promise<readonly RetrainCollection[]> {
    let rows: readonly Row[]
    try {
      rows = await this.collections.query({
        orderBy: { field: 'createdAt', direction: 'desc' },
      })
    } catch (err) {
      this.logger.warn('retrain collections list failed', { meta: { error: String(err) } })
      return []
    }
    const counts = await this.countMembers(rows.map((r) => r.id))
    return rows.map((row) => this.toCollection(row.id, row.data, counts.get(row.id) ?? 0))
  }

  async getById(id: string): Promise<RetrainCollection | null> {
    const data = await this.readRow(id)
    if (data === null) return null
    const counts = await this.countMembers([id])
    return this.toCollection(id, data, counts.get(id) ?? 0)
  }

  async rename(input: { id: string; name: string }): Promise<RetrainCollectionRenameResult> {
    const normalized = normalizeCollectionName(input.name)
    if (normalized === null) return { kind: 'refused', reason: 'empty-name' }
    const current = await this.readRow(input.id)
    if (current === null) return { kind: 'refused', reason: 'unknown-collection' }
    const holder = await this.findIdByNameKey(normalized.nameKey)
    if (holder !== null && holder !== input.id) return { kind: 'refused', reason: 'duplicate-name' }
    await this.collections.update(input.id, {
      name: normalized.name,
      nameKey: normalized.nameKey,
      updatedAt: this.now(),
    })
    this.logger.info('retrain collection renamed', { meta: { collectionId: input.id } })
    const counts = await this.countMembers([input.id])
    return {
      kind: 'renamed',
      collection: this.toCollection(
        input.id,
        { ...current, name: normalized.name },
        counts.get(input.id) ?? 0,
      ),
    }
  }

  /** Remove the collection and its memberships in ONE transaction: a failure
   *  leaves the collection with all its members, never memberships pointing at
   *  a name that no longer exists, nor a collection that silently lost some. */
  async delete(id: string): Promise<RetrainCollectionDeleteResult> {
    if ((await this.readRow(id)) === null) return { deleted: false, memberFrameIds: [] }
    // Strict: the member list decides which recording stills are deleted
    // next. A failed read must fail the delete, not report "no members" and
    // leave unreachable stills behind.
    const members = await this.memberships.query({ where: { collectionId: id } })
    await this.collections.transact([
      ...members.map((m) => this.memberships.txDelete(m.id)),
      this.collections.txDelete(id),
    ])
    this.logger.info('retrain collection deleted', {
      meta: { collectionId: id, members: members.length },
    })
    return { deleted: true, memberFrameIds: members.map((m) => String(m.data['frameId'] ?? '')) }
  }

  /** Add a frame. `false` when it was already a member (nothing written). */
  async addFrame(input: {
    collectionId: string
    frameId: string
    deviceId: number
  }): Promise<boolean> {
    const key = membershipKey(input.collectionId, input.frameId)
    const existing = await this.memberships.get(key)
    if (existing !== null) return false
    await this.memberships.upsertRow(key, {
      collectionId: input.collectionId,
      frameId: input.frameId,
      deviceId: input.deviceId,
      addedAt: this.now(),
    })
    return true
  }

  /** Remove one membership. `false` when it did not exist. */
  async removeFrame(input: { collectionId: string; frameId: string }): Promise<boolean> {
    const key = membershipKey(input.collectionId, input.frameId)
    const existing = await this.memberships.get(key)
    if (existing === null) return false
    await this.memberships.deleteKey(key)
    return true
  }

  /**
   * The delete ops of every membership of a frame, for ONE transaction with
   * the frame row and its annotations (RetrainService.removeFrame). A failed
   * read THROWS: the frame row must not be deleted over memberships nobody
   * could list.
   */
  async forgetFrameOps(frameId: string): Promise<readonly PreparedTransactOp[]> {
    const rows = await this.memberships.query({ where: { frameId } })
    return rows.map((r) => this.memberships.txDelete(r.id))
  }

  /**
   * The op that adds a frame to a collection, for ONE transaction with the
   * frame's own row (a still stored from the recording). `null` when it is
   * already a member: there is nothing to write.
   */
  async addFrameOp(input: {
    collectionId: string
    frameId: string
    deviceId: number
  }): Promise<PreparedTransactOp | null> {
    const key = membershipKey(input.collectionId, input.frameId)
    if ((await this.memberships.get(key)) !== null) return null
    return this.memberships.txUpsert(key, {
      collectionId: input.collectionId,
      frameId: input.frameId,
      deviceId: input.deviceId,
      addedAt: this.now(),
    })
  }

  /** The frames of a collection, in the order they were added. */
  async listFrameIds(collectionId: string): Promise<readonly string[]> {
    const rows = await this.membershipRows({ collectionId })
    return rows
      .toSorted((a, b) => Number(a.data['addedAt'] ?? 0) - Number(b.data['addedAt'] ?? 0))
      .map((r) => String(r.data['frameId'] ?? ''))
      .filter((id) => id !== '')
  }

  /** frameId → the collections it belongs to. Frames in none are absent. */
  async collectionsOf(
    frameIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const out = new Map<string, string[]>()
    for (const row of await this.membershipRowsIn('frameId', frameIds)) {
      const frameId = String(row.data['frameId'] ?? '')
      const collectionId = String(row.data['collectionId'] ?? '')
      if (frameId === '' || collectionId === '') continue
      out.set(frameId, [...(out.get(frameId) ?? []), collectionId])
    }
    for (const [frameId, ids] of out) out.set(frameId, ids.toSorted())
    return out
  }

  /** The frame ids of several collections, de-duplicated. */
  async frameIdsOf(collectionIds: readonly string[]): Promise<readonly string[]> {
    const ids = new Set<string>()
    for (const row of await this.membershipRowsIn('collectionId', collectionIds)) {
      const frameId = String(row.data['frameId'] ?? '')
      if (frameId !== '') ids.add(frameId)
    }
    return [...ids]
  }

  private toCollection(
    id: string,
    data: Record<string, unknown>,
    frameCount: number,
  ): RetrainCollection {
    return {
      id,
      name: typeof data['name'] === 'string' ? data['name'] : '',
      createdAt: Number(data['createdAt'] ?? 0),
      frameCount,
    }
  }

  private async readRow(id: string): Promise<Record<string, unknown> | null> {
    try {
      const row = await this.collections.get(id)
      return row === null ? null : { ...row.data }
    } catch (err) {
      this.logger.warn('retrain collection get failed', {
        meta: { collectionId: id, error: String(err) },
      })
      return null
    }
  }

  private async countMembers(
    collectionIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>()
    for (const row of await this.membershipRowsIn('collectionId', collectionIds)) {
      const id = String(row.data['collectionId'] ?? '')
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }

  private async membershipRows(where: Record<string, string>): Promise<readonly Row[]> {
    try {
      return await this.memberships.query({ where })
    } catch (err) {
      this.logger.warn('retrain collection membership read failed', {
        meta: { ...where, error: String(err) },
      })
      return []
    }
  }

  private async membershipRowsIn(
    field: 'collectionId' | 'frameId',
    values: readonly string[],
  ): Promise<readonly Row[]> {
    const out: Row[] = []
    for (let i = 0; i < values.length; i += IN_PAGE) {
      const page = values.slice(i, i + IN_PAGE)
      try {
        out.push(...(await this.memberships.query({ whereIn: { [field]: [...page] } })))
      } catch (err) {
        this.logger.warn('retrain collection membership read failed', {
          meta: { field, values: page.length, error: String(err) },
        })
      }
    }
    return out
  }

  private async findIdByNameKey(nameKey: string): Promise<string | null> {
    try {
      const rows = await this.collections.query({ where: { nameKey }, limit: 1 })
      return rows[0]?.id ?? null
    } catch (err) {
      this.logger.warn('retrain collection findByNameKey failed', {
        meta: { nameKey, error: String(err) },
      })
      return null
    }
  }
}
