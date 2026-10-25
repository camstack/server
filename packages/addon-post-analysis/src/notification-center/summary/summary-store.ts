/**
 * NcSummaryStore — the durable multi-camera digest rule set.
 *
 * Records migration (phase 2, step 22): uses `RecordKindHandle<SummaryRuleBody>`
 * over the `notification-center/summary-rules` record kind instead of the legacy
 * `DurableLedger`. Owner stamp: `pipeline-analytics` (the hosting addon).
 *
 * In-memory mirror + write-through: a failed persist never leaves a phantom
 * in-RAM rule. A failed LOAD never clears the mirror — the ledger's fail-safe
 * direction (D130): an emptied mirror means the producer delivers nothing and
 * a closed window does not come back.
 */

import { randomUUID } from 'node:crypto'
import type { IScopedLogger, RecordKindHandle, RecordsAccess } from '@camstack/types'
import { ncRecordKinds, type SummaryRuleBody } from '../record-kinds.js'
import { type NcRereadResult, rereadRecordRow } from '../durable-reread.js'
import {
  type NcSummaryAi,
  type NcSummaryFilters,
  type NcSummaryRule,
  type NcSummaryRuleInput,
  NcSummaryRuleInputSchema,
  type NcSummaryRulePatch,
  NcSummaryRuleSchema,
  type NcSummaryTemplate,
} from './summary-rule.js'
import type { SummaryRuleClearableKey } from './summary-rule-clear.js'

/**
 * @durable class=config owner=pipeline-analytics
 *   write="an operator creates or edits a digest rule, or the producer stamps a delivered window via markGenerated"
 *   retention="none — a row goes only when the operator deletes the rule. Bounded by the rule set a human is willing to author."
 */
export const NC_SUMMARY_RULES_COLLECTION = 'notification-center:summary-rules'

export interface NcSummaryStoreRecordsDeps {
  readonly kind: RecordKindHandle<SummaryRuleBody>
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly newId?: () => string
}

export type NcSummaryStoreDeps = NcSummaryStoreRecordsDeps

function applyTemplatePatch(
  merged: NcSummaryRule,
  template: NcSummaryTemplate | null | undefined,
): NcSummaryRule {
  if (template === undefined) return merged
  if (template !== null) return { ...merged, template }
  const { template: _cleared, ...rest } = merged
  return rest
}

function applyFiltersPatch(
  merged: NcSummaryRule,
  filters: NcSummaryFilters | null | undefined,
): NcSummaryRule {
  if (filters === undefined) return merged
  if (filters !== null) return { ...merged, filters }
  const { filters: _cleared, ...rest } = merged
  return rest
}

function withoutCleared(
  rule: NcSummaryRule,
  clear: ReadonlySet<SummaryRuleClearableKey>,
): NcSummaryRule {
  const { captionText, ...rest } = rule
  return {
    ...rest,
    ...(captionText !== undefined && !clear.has('captionText') ? { captionText } : {}),
  }
}

function applyAiPatch(merged: NcSummaryRule, ai: NcSummaryAi | null | undefined): NcSummaryRule {
  if (ai === undefined) return merged
  if (ai !== null) return { ...merged, ai }
  const { ai: _cleared, ...rest } = merged
  return rest
}

export class NcSummaryStore {
  private readonly byId = new Map<string, NcSummaryRule>()
  private readonly kind: RecordKindHandle<SummaryRuleBody>
  private readonly logger: IScopedLogger
  private readonly now: () => number
  private readonly newId: () => string

  constructor(deps: NcSummaryStoreDeps) {
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
  ): NcSummaryStore {
    return new NcSummaryStore({
      kind: records.kind(ncRecordKinds['summary-rules']),
      logger,
      now,
      newId,
    })
  }

  /**
   * (Re)hydrate the FULL rule set — boot and the periodic refresh tick.
   * **A failed read keeps the rule set already in memory** — an emptied mirror
   * means the producer delivers nothing and a closed window does not come back.
   */
  async load(): Promise<void> {
    try {
      const { records } = await this.kind.query({ limit: 10_000 })
      const next = new Map<string, NcSummaryRule>()
      let skipped = 0
      for (const row of records) {
        const parsed = NcSummaryRuleSchema.safeParse({ ...row.data, id: row.id })
        if (!parsed.success) {
          skipped += 1
          continue
        }
        next.set(row.id, parsed.data)
      }
      this.byId.clear()
      for (const [id, rule] of next) this.byId.set(id, rule)
      if (skipped > 0) {
        this.logger.warn('summary rule rows skipped as malformed', { meta: { skipped } })
      }
    } catch (err) {
      this.logger.warn('summary rules load failed — keeping rules already in memory', {
        meta: { error: String(err), rules: this.byId.size },
      })
    }
    this.logger.debug('summary rules loaded', { meta: { rules: this.byId.size } })
  }

  /** Every rule, newest-first. */
  list(): readonly NcSummaryRule[] {
    return [...this.byId.values()].toSorted((a, b) => b.updatedAt - a.updatedAt)
  }

  /** The producer's read: only rules that should be ticked. */
  listEnabled(): readonly NcSummaryRule[] {
    return this.list().filter((r) => r.enabled)
  }

  get(ruleId: string): NcSummaryRule | null {
    return this.byId.get(ruleId) ?? null
  }

  /**
   * Re-read ONE rule from the durable store into the mirror, for a writer
   * that must not act on a mirror a reload tick stale (the deleted-device
   * prune). Throws on a failed read; see `durable-reread.ts`.
   */
  reread(ruleId: string): Promise<NcRereadResult<NcSummaryRule>> {
    return rereadRecordRow(this.kind, this.byId, ruleId, (id, data) => {
      const parsed = NcSummaryRuleSchema.safeParse({ ...data, id })
      return parsed.success ? parsed.data : null
    })
  }

  listForOwner(userId: string): readonly NcSummaryRule[] {
    return this.list().filter((r) => r.ownerUserId === undefined || r.ownerUserId === userId)
  }

  async create(
    input: NcSummaryRuleInput,
    createdBy: string,
    ownerUserId?: string,
  ): Promise<NcSummaryRule> {
    const now = this.now()
    const rule = NcSummaryRuleSchema.parse({
      ...NcSummaryRuleInputSchema.parse(input),
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
    patch: NcSummaryRulePatch,
    clear: readonly SummaryRuleClearableKey[] = [],
  ): Promise<NcSummaryRule> {
    const existing = this.byId.get(ruleId)
    if (!existing) throw new Error(`summary rule not found: ${ruleId}`)
    const conflict = clear.find((key) => patch[key] !== undefined)
    if (conflict !== undefined) {
      throw new Error(`summary rule patch both sets and clears '${conflict}'`)
    }
    const { template, filters, ai, ...rest } = patch
    const merged: NcSummaryRule = {
      ...withoutCleared(existing, new Set(clear)),
      ...rest,
      id: existing.id,
      ...(existing.ownerUserId !== undefined ? { ownerUserId: existing.ownerUserId } : {}),
      ...(existing.generatedAt !== undefined ? { generatedAt: existing.generatedAt } : {}),
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
    }
    return this.write(
      applyAiPatch(applyFiltersPatch(applyTemplatePatch(merged, template), filters), ai),
    )
  }

  async setEnabled(ruleId: string, enabled: boolean): Promise<NcSummaryRule> {
    return this.update(ruleId, { enabled })
  }

  async markGenerated(ruleId: string, windowEndMs: number): Promise<NcSummaryRule> {
    const existing = this.byId.get(ruleId)
    if (!existing) throw new Error(`summary rule not found: ${ruleId}`)
    return this.write({
      ...existing,
      generatedAt: Math.max(existing.generatedAt ?? 0, windowEndMs),
    })
  }

  /**
   * Idempotent delete — unknown ids are a no-op in RAM, still attempted on disk.
   * Throws on a failed durable delete.
   */
  async delete(ruleId: string): Promise<void> {
    this.byId.delete(ruleId)
    try {
      await this.kind.delete(ruleId)
    } catch (err) {
      this.logger.warn('summary rule delete failed', {
        meta: { ruleId, error: String(err) },
      })
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  private async write(candidate: NcSummaryRule): Promise<NcSummaryRule> {
    const rule = NcSummaryRuleSchema.parse(candidate)
    const { id, ...body } = rule
    await this.kind.put({ id, data: body })
    this.byId.set(id, rule)
    return rule
  }
}
