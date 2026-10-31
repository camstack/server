/**
 * Shared action sequences for the notification centre.
 *
 * A sequence is a named, ordered run of steps (`wait` | `cap`) with its own
 * throttle. Rules and notification buttons bind to it by id — never by copying
 * the steps inline — so two rules that open the same gate share one budget and
 * one authoring surface.
 *
 * Records migration (phase 2, step 19): uses `RecordKindHandle<SequenceBody>`
 * over the `notification-center/sequences` record kind instead of the legacy
 * `SettingsStoreClient`. Owner stamp: `pipeline-analytics` (the hosting addon).
 *
 * In-memory mirror + write-through: a failed persist never leaves a phantom
 * sequence the next boot will not know.
 */

import { randomUUID } from 'node:crypto'
import type {
  IScopedLogger,
  NcRuleAction,
  NcSharedSequence,
  NcSharedSequenceInput,
  RecordKindHandle,
  RecordsAccess,
} from '@camstack/types'
import { NcRuleActionSchema, NcSharedSequenceSchema } from '@camstack/types'
import { normalizeNcAction } from '@camstack/types'
import { ncRecordKinds, type SequenceBody } from './record-kinds.js'

/**
 * @durable class=config owner=pipeline-analytics
 *   write="an admin creates/edits/deletes a shared sequence via
 *     `notificationRules.createSequence` / `updateSequence` / `deleteSequence`,
 *     or the one-shot boot migration that materialises legacy inline sequences"
 *   retention="none — a row goes only when an admin deletes it. Bounded by the
 *     sequence set a human is willing to author."
 */
export const NC_SEQUENCES_COLLECTION = 'notification-center:sequences'

export interface NcSequenceStoreRecordsDeps {
  readonly kind: RecordKindHandle<SequenceBody>
  readonly logger: IScopedLogger
  readonly now?: () => number
}

export type NcSequenceStoreDeps = NcSequenceStoreRecordsDeps

function parseActions(raw: unknown): readonly NcRuleAction[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: NcRuleAction[] = []
  for (const entry of raw) {
    const parsed = NcRuleActionSchema.safeParse(entry)
    if (!parsed.success) return null
    // D983: a step stored with `deviceId` is READ as a `devices` target.
    out.push(normalizeNcAction(parsed.data))
  }
  return out
}

/** Does a stored row still carry a pre-D983 cap step (`deviceId`, no `target`)? */
function hasLegacyTarget(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false
  return raw.some((entry) => {
    const parsed = NcRuleActionSchema.safeParse(entry)
    return parsed.success && parsed.data.kind === 'cap' && parsed.data.target === undefined
  })
}

function rowToSequence(id: string, body: SequenceBody): NcSharedSequence | null {
  const actions = parseActions(body.actions)
  if (actions === null) return null
  const candidate = {
    id,
    name: body.name,
    ...(body.minDelaySec !== undefined ? { minDelaySec: body.minDelaySec } : {}),
    actions: [...actions],
  }
  const parsed = NcSharedSequenceSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

export class NcSequenceStore {
  private readonly byId = new Map<string, NcSharedSequence>()
  private readonly kind: RecordKindHandle<SequenceBody>
  private readonly logger: IScopedLogger
  private readonly now: () => number

  constructor(deps: NcSequenceStoreDeps) {
    this.logger = deps.logger
    this.now = deps.now ?? ((): number => Date.now())
    this.kind = deps.kind
  }

  static of(
    records: Pick<RecordsAccess, 'kind'>,
    logger: IScopedLogger,
    now?: () => number,
  ): NcSequenceStore {
    return new NcSequenceStore({ kind: records.kind(ncRecordKinds.sequences), logger, now })
  }

  /**
   * (Re)hydrate. A failed load KEEPS what is already in memory — dropping every
   * sequence on a transient store error would leave every button and binding
   * pointing at nothing until the next successful load.
   */
  async load(): Promise<void> {
    try {
      const { records } = await this.kind.query({ limit: 10_000 })
      const next = new Map<string, NcSharedSequence>()
      const legacyRows: string[] = []
      let skipped = 0
      for (const row of records) {
        const sequence = rowToSequence(row.id, row.data)
        if (sequence === null) {
          skipped += 1
          continue
        }
        next.set(sequence.id, sequence)
        if (hasLegacyTarget(row.data.actions)) legacyRows.push(row.id)
      }
      this.byId.clear()
      for (const [id, seq] of next) this.byId.set(id, seq)
      await this.rewriteLegacyRows(legacyRows, records)
      if (skipped > 0) {
        this.logger.warn('sequence rows skipped as malformed — bindings to them will miss', {
          meta: { skipped },
        })
      }
    } catch (err) {
      this.logger.warn('sequence load failed — keeping the sequences already in memory', {
        meta: { error: String(err), sequences: this.byId.size },
      })
    }
  }

  /**
   * One-shot, idempotent (D983): a row whose steps still carry `deviceId` is
   * stored again in the target shape. A failed write leaves the row as it was —
   * it is still READ as the new shape — and is on the record.
   */
  private async rewriteLegacyRows(
    ids: readonly string[],
    records: readonly { readonly id: string; readonly data: SequenceBody }[],
  ): Promise<void> {
    for (const id of ids) {
      const sequence = this.byId.get(id) ?? null
      const row = records.find((r) => r.id === id)
      if (sequence === null || row === undefined) continue
      try {
        const createdAt = row.data.createdAt
        await this.persist(
          sequence,
          typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : this.now(),
          this.now(),
        )
        this.logger.info('notification sequence rewritten to the target shape', {
          meta: { sequenceId: id },
        })
      } catch (err) {
        this.logger.warn(
          'notification sequence could not be rewritten — it is still read as the target shape',
          {
            meta: { sequenceId: id, error: String(err) },
          },
        )
      }
    }
  }

  list(): readonly NcSharedSequence[] {
    return [...this.byId.values()].toSorted((a, b) => a.name.localeCompare(b.name))
  }

  get(sequenceId: string): NcSharedSequence | null {
    return this.byId.get(sequenceId) ?? null
  }

  /** Hot-path existence check for button minting. */
  has(sequenceId: string): boolean {
    return this.byId.has(sequenceId)
  }

  knownIds(): ReadonlySet<string> {
    return new Set(this.byId.keys())
  }

  async create(input: NcSharedSequenceInput): Promise<NcSharedSequence> {
    const now = this.now()
    const sequence: NcSharedSequence = {
      id: randomUUID(),
      name: input.name,
      ...(input.minDelaySec !== undefined ? { minDelaySec: input.minDelaySec } : {}),
      actions: input.actions.map(normalizeNcAction),
    }
    await this.persist(sequence, now, now)
    this.byId.set(sequence.id, sequence)
    return sequence
  }

  /**
   * Create with a CALLER-chosen id — used by the legacy migration so a rewrite
   * can name the sequence before rewriting the rule that points at it.
   */
  async createWithId(sequence: NcSharedSequence): Promise<NcSharedSequence> {
    const now = this.now()
    const stored: NcSharedSequence = {
      id: sequence.id,
      name: sequence.name,
      ...(sequence.minDelaySec !== undefined ? { minDelaySec: sequence.minDelaySec } : {}),
      actions: sequence.actions.map(normalizeNcAction),
    }
    await this.persist(stored, now, now)
    this.byId.set(stored.id, stored)
    return stored
  }

  async update(sequenceId: string, input: NcSharedSequenceInput): Promise<NcSharedSequence> {
    const existing = this.byId.get(sequenceId)
    if (existing === undefined) throw new Error(`sequence ${sequenceId} does not exist`)
    const now = this.now()
    const sequence: NcSharedSequence = {
      id: sequenceId,
      name: input.name,
      ...(input.minDelaySec !== undefined ? { minDelaySec: input.minDelaySec } : {}),
      actions: input.actions.map(normalizeNcAction),
    }
    const createdAt = await this.readCreatedAt(sequenceId, now)
    await this.persist(sequence, createdAt, now)
    this.byId.set(sequenceId, sequence)
    return sequence
  }

  async delete(sequenceId: string): Promise<void> {
    await this.kind.delete(sequenceId)
    this.byId.delete(sequenceId)
  }

  private async readCreatedAt(sequenceId: string, fallback: number): Promise<number> {
    try {
      const row = await this.kind.get(sequenceId)
      const raw = row?.data.createdAt
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
    } catch {
      return fallback
    }
  }

  private async persist(
    sequence: NcSharedSequence,
    createdAt: number,
    updatedAt: number,
  ): Promise<void> {
    await this.kind.put({
      id: sequence.id,
      data: {
        name: sequence.name,
        ...(sequence.minDelaySec !== undefined ? { minDelaySec: sequence.minDelaySec } : {}),
        actions: sequence.actions,
        createdAt,
        updatedAt,
      },
    })
  }
}
