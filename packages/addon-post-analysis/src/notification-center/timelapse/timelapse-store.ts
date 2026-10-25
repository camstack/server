/**
 * TimelapseStore — durable timelapse rule set.
 *
 * Records migration (phase 2, step 23): uses `RecordKindHandle<TimelapseRuleBody>`
 * over the `notification-center/timelapse-rules` record kind instead of the legacy
 * `DurableLedger`. Owner stamp: `pipeline-analytics` (the hosting addon).
 *
 * In-memory mirror + write-through. A failed load NEVER clears the mirror —
 * a cleared mirror would make the scheduler tick over nothing, and a timelapse
 * window that closes unrendered does not come back (D130 lesson).
 *
 * OWNERSHIP IS SERVER-DERIVED. `create` takes `createdBy` and an optional
 * `ownerUserId` as ARGUMENTS — never from the input blob. `create` ENFORCES
 * that by re-parsing the blob through `TimelapseRuleInputSchema` before stamping.
 *
 * ## Synthesised `createdAt` for legacy rows
 *
 * A row written before `createdAt` was required has none. The memo in
 * `synthesisedCreatedAt` assigns one stable birth stamp per such row so that
 * repeated `load()` calls do not advance the scheduler's eligibility floor.
 * The first `update`/`markGenerated` call persists the synthesised value and
 * the row is no longer legacy.
 */

import type {
  IScopedLogger,
  RecordKindHandle,
  RecordsAccess,
  TimelapseRule,
  TimelapseRuleInput,
  TimelapseRulePatch,
  TimelapseTemplate,
} from '@camstack/types'
import { TimelapseRuleInputSchema, TimelapseRuleSchema } from '@camstack/types'
import { randomUUID } from 'node:crypto'
import { ncRecordKinds, type TimelapseRuleBody } from '../record-kinds.js'
import { type NcRereadResult, rereadRecordRow } from '../durable-reread.js'
import type { TimelapseRuleClearableKey } from './timelapse-rule-clear.js'

/**
 * @durable class=config owner=pipeline-analytics
 *   write="an operator creates or edits a timelapse rule, or the scheduler stamps a successful per-camera generation via markGenerated"
 *   retention="none — a row goes only when the operator deletes the rule. Bounded by the rule set a human is willing to author."
 */
export const NC_TIMELAPSE_RULES_COLLECTION = 'notification-center:timelapse-rules'

export interface TimelapseStoreRecordsDeps {
  readonly kind: RecordKindHandle<TimelapseRuleBody>
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly newId?: () => string
}

export type TimelapseStoreDeps = TimelapseStoreRecordsDeps

/**
 * @durable class=config owner=pipeline-analytics
 *   write="an operator creates or edits a timelapse rule, or the scheduler stamps a successful per-camera generation via markGenerated"
 *   retention="none — a row goes only when the operator deletes the rule. Bounded by the rule set a human is willing to author."
 */

function applyTemplatePatch(
  merged: TimelapseRule,
  template: TimelapseTemplate | null | undefined,
): TimelapseRule {
  if (template === undefined) return merged
  if (template !== null) return { ...merged, template }
  const { template: _cleared, ...withoutTemplate } = merged
  return withoutTemplate
}

function withoutCleared(
  rule: TimelapseRule,
  clear: ReadonlySet<TimelapseRuleClearableKey>,
): TimelapseRule {
  const { template, previewText, reportClasses, denseCadenceSec, minDwellSec, ...rest } = rule
  return {
    ...rest,
    ...(template !== undefined && !clear.has('template') ? { template } : {}),
    ...(previewText !== undefined && !clear.has('previewText') ? { previewText } : {}),
    ...(reportClasses !== undefined && !clear.has('reportClasses') ? { reportClasses } : {}),
    ...(denseCadenceSec !== undefined && !clear.has('denseCadenceSec') ? { denseCadenceSec } : {}),
    ...(minDwellSec !== undefined && !clear.has('minDwellSec') ? { minDwellSec } : {}),
  }
}

/**
 * Give a stored body a `createdAt` if it has none, without writing anything back.
 * See the module docblock for why.
 */
function withCreatedAt(
  rowId: string,
  raw: TimelapseRuleBody,
  synthesised: Map<string, number>,
  now: () => number,
): TimelapseRuleBody {
  if (typeof (raw as Record<string, unknown>)['createdAt'] === 'number') return raw
  const stamped = synthesised.get(rowId) ?? now()
  synthesised.set(rowId, stamped)
  return { ...raw, createdAt: stamped }
}

export class TimelapseStore {
  /**
   * Birth stamps synthesised for LEGACY rows (no `createdAt`), kept so
   * repeated `load()` calls re-use the FIRST one and the eligibility floor
   * does not advance on each refresh.
   */
  private readonly synthesisedCreatedAt = new Map<string, number>()
  private readonly byId = new Map<string, TimelapseRule>()
  private readonly kind: RecordKindHandle<TimelapseRuleBody>
  private readonly logger: IScopedLogger
  private readonly now: () => number
  private readonly newId: () => string

  constructor(deps: TimelapseStoreDeps) {
    this.logger = deps.logger
    this.now = deps.now ?? ((): number => Date.now())
    this.newId = deps.newId ?? ((): string => randomUUID())
    this.kind = deps.kind
  }

  static of(
    records: Pick<RecordsAccess, 'kind'>,
    logger: IScopedLogger,
    now?: () => number,
    newId?: () => string,
  ): TimelapseStore {
    return new TimelapseStore({
      kind: records.kind(ncRecordKinds['timelapse-rules']),
      logger,
      now,
      newId,
    })
  }

  /**
   * (Re)hydrate the FULL rule set — boot and the periodic refresh tick.
   * **A failed read keeps the rule set already in memory** — an emptied mirror
   * means the scheduler ticks over nothing and a timelapse window that closes
   * unrendered does not come back.
   */
  async load(): Promise<void> {
    try {
      const { records } = await this.kind.query({ limit: 10_000 })
      const next = new Map<string, TimelapseRule>()
      let skipped = 0
      let synthesised = 0
      for (const row of records) {
        const body = withCreatedAt(row.id, row.data, this.synthesisedCreatedAt, this.now)
        const parsed = TimelapseRuleSchema.safeParse({ ...body, id: row.id })
        if (!parsed.success) {
          skipped += 1
          continue
        }
        next.set(row.id, parsed.data)
        if (body !== row.data) synthesised += 1
      }
      this.byId.clear()
      for (const [id, rule] of next) this.byId.set(id, rule)
      if (skipped > 0) {
        this.logger.warn('timelapse rule rows skipped as malformed', { meta: { skipped } })
      }
      this.logger.debug('timelapse rules loaded', {
        meta: {
          rules: this.byId.size,
          ...(synthesised > 0 ? { synthesisedCreatedAt: synthesised } : {}),
        },
      })
    } catch (err) {
      this.logger.warn('timelapse rules load failed — keeping rules already in memory', {
        meta: { error: String(err), rules: this.byId.size },
      })
    }
  }

  /** Every rule, newest-first (admin path). */
  list(): readonly TimelapseRule[] {
    return [...this.byId.values()].toSorted((a, b) => b.updatedAt - a.updatedAt)
  }

  /** The scheduler's read: only rules that should be ticked. */
  listEnabled(): readonly TimelapseRule[] {
    return this.list().filter((r) => r.enabled)
  }

  get(ruleId: string): TimelapseRule | null {
    return this.byId.get(ruleId) ?? null
  }

  /**
   * Re-read ONE rule from the durable store into the mirror, for a writer
   * that must not act on a mirror a reload tick stale (the deleted-device
   * prune). Throws on a failed read; see `durable-reread.ts`.
   */
  reread(ruleId: string): Promise<NcRereadResult<TimelapseRule>> {
    return rereadRecordRow(this.kind, this.byId, ruleId, (id, data) => {
      const body = withCreatedAt(id, data, this.synthesisedCreatedAt, this.now)
      const parsed = TimelapseRuleSchema.safeParse({ ...body, id })
      return parsed.success ? parsed.data : null
    })
  }

  listForOwner(userId: string): readonly TimelapseRule[] {
    return this.list().filter((r) => r.ownerUserId === undefined || r.ownerUserId === userId)
  }

  isOwnedBy(ruleId: string, userId: string): boolean {
    const rule = this.byId.get(ruleId)
    return rule?.ownerUserId !== undefined && rule.ownerUserId === userId
  }

  async create(
    input: TimelapseRuleInput,
    createdBy: string,
    ownerUserId?: string,
  ): Promise<TimelapseRule> {
    const now = this.now()
    const rule = TimelapseRuleSchema.parse({
      ...TimelapseRuleInputSchema.parse(input),
      id: this.newId(),
      ...(ownerUserId !== undefined ? { ownerUserId } : {}),
      createdBy,
      createdAt: now,
      updatedAt: now,
    })
    return this.write(rule)
  }

  async update(
    ruleId: string,
    patch: TimelapseRulePatch,
    clear: readonly TimelapseRuleClearableKey[] = [],
  ): Promise<TimelapseRule> {
    const existing = this.byId.get(ruleId)
    if (!existing) throw new Error(`timelapse rule not found: ${ruleId}`)
    const conflict = clear.find((key) => patch[key] !== undefined && patch[key] !== null)
    if (conflict !== undefined) {
      throw new Error(`timelapse rule patch both sets and clears '${conflict}'`)
    }
    const { template, ...rest } = patch
    const merged: TimelapseRule = {
      ...withoutCleared(existing, new Set(clear)),
      ...rest,
      id: existing.id,
      ownerUserId: existing.ownerUserId,
      lastGeneratedAt: existing.lastGeneratedAt,
      generatedByDevice: existing.generatedByDevice,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
    }
    return this.write(applyTemplatePatch(merged, template))
  }

  async setEnabled(ruleId: string, enabled: boolean): Promise<TimelapseRule> {
    return this.update(ruleId, { enabled })
  }

  async markGenerated(ruleId: string, deviceId: number, at: number): Promise<TimelapseRule> {
    const existing = this.byId.get(ruleId)
    if (!existing) throw new Error(`timelapse rule not found: ${ruleId}`)
    const seeded: Record<string, number> = {}
    if (existing.generatedByDevice === undefined && existing.lastGeneratedAt !== undefined) {
      for (const id of existing.deviceIds) seeded[String(id)] = existing.lastGeneratedAt
    }
    const generatedByDevice: Record<string, number> = {
      ...seeded,
      ...existing.generatedByDevice,
      [String(deviceId)]: at,
    }
    return this.write({
      ...existing,
      generatedByDevice,
      lastGeneratedAt: Math.max(existing.lastGeneratedAt ?? 0, at),
    })
  }

  async forgetDevices(ruleId: string, deviceIds: readonly number[]): Promise<TimelapseRule> {
    const existing = this.byId.get(ruleId)
    if (!existing) throw new Error(`timelapse rule not found: ${ruleId}`)
    const stamps = existing.generatedByDevice
    const drop = new Set(deviceIds.map((id) => String(id)))
    if (stamps === undefined || !Object.keys(stamps).some((key) => drop.has(key))) return existing
    const kept = Object.fromEntries(Object.entries(stamps).filter(([key]) => !drop.has(key)))
    return this.write({ ...existing, generatedByDevice: kept })
  }

  /**
   * Idempotent delete — unknown ids are a no-op.
   * Deliberately throws on a failed durable delete.
   */
  async delete(ruleId: string): Promise<void> {
    this.byId.delete(ruleId)
    try {
      await this.kind.delete(ruleId)
    } catch (err) {
      this.logger.warn('timelapse rule delete failed', {
        meta: { ruleId, error: String(err) },
      })
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  private async write(candidate: TimelapseRule): Promise<TimelapseRule> {
    const rule = TimelapseRuleSchema.parse(candidate)
    const { id, ...body } = rule
    await this.kind.put({ id, data: body })
    this.byId.set(id, rule)
    return rule
  }
}
