/**
 * Durable calendar-events rule set.
 *
 * Records migration (phase 2, step 21): uses `RecordKindHandle<CalendarEventsRuleBody>`
 * over the `notification-center/calendar-events-rules` record kind instead of
 * the legacy `DurableLedger`. Owner stamp: `pipeline-analytics` (the hosting addon).
 *
 * In-memory mirror + write-through: a failed persist never leaves a phantom
 * in-RAM rule the next boot will not know.
 */

import { randomUUID } from 'node:crypto'
import type { IScopedLogger, RecordKindHandle, RecordsAccess } from '@camstack/types'
import { ncRecordKinds, type CalendarEventsRuleBody } from '../record-kinds.js'
import {
  type NcCalendarEventsRule,
  type NcCalendarEventsRuleInput,
  NcCalendarEventsRuleInputSchema,
  type NcCalendarEventsRulePatch,
  NcCalendarEventsRuleSchema,
  type NcCalendarEventsTemplate,
} from './calendar-events-rule.js'

/**
 * @durable class=config owner=pipeline-analytics
 *   write="an operator creates or edits a calendar-events rule, or the producer stamps a delivered window via markGenerated"
 *   retention="none — a row goes only when the operator deletes the rule."
 */
export const NC_CALENDAR_EVENTS_RULES_COLLECTION = 'notification-center:calendar-events-rules'

export interface NcCalendarEventsStoreRecordsDeps {
  readonly kind: RecordKindHandle<CalendarEventsRuleBody>
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly newId?: () => string
}

export type NcCalendarEventsStoreDeps = NcCalendarEventsStoreRecordsDeps

function applyTemplatePatch(
  merged: NcCalendarEventsRule,
  template: NcCalendarEventsTemplate | null | undefined,
): NcCalendarEventsRule {
  if (template === undefined) return merged
  if (template !== null) return { ...merged, template }
  const { template: _cleared, ...rest } = merged
  return rest
}

function applyOptionalStringList(
  merged: NcCalendarEventsRule,
  key: 'calendars' | 'calendarsExclude',
  value: readonly string[] | null | undefined,
): NcCalendarEventsRule {
  if (value === undefined) return merged
  if (value !== null) return { ...merged, [key]: [...value] }
  const { [key]: _cleared, ...rest } = merged
  return rest
}

export class NcCalendarEventsStore {
  private readonly byId = new Map<string, NcCalendarEventsRule>()
  private readonly kind: RecordKindHandle<CalendarEventsRuleBody>
  private readonly logger: IScopedLogger
  private readonly now: () => number
  private readonly newId: () => string

  constructor(deps: NcCalendarEventsStoreDeps) {
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
  ): NcCalendarEventsStore {
    return new NcCalendarEventsStore({
      kind: records.kind(ncRecordKinds['calendar-events-rules']),
      logger,
      now,
      newId,
    })
  }

  async load(): Promise<void> {
    try {
      const { records } = await this.kind.query({ limit: 10_000 })
      const next = new Map<string, NcCalendarEventsRule>()
      let skipped = 0
      for (const row of records) {
        const parsed = NcCalendarEventsRuleSchema.safeParse({ ...row.data, id: row.id })
        if (!parsed.success) {
          skipped += 1
          continue
        }
        next.set(row.id, parsed.data)
      }
      this.byId.clear()
      for (const [id, rule] of next) this.byId.set(id, rule)
      if (skipped > 0) {
        this.logger.warn('calendar-events rule rows skipped as malformed', { meta: { skipped } })
      }
    } catch (err) {
      this.logger.warn('calendar-events rules load failed — keeping rules already in memory', {
        meta: { error: String(err), rules: this.byId.size },
      })
    }
    this.logger.debug('calendar-events rules loaded', { meta: { rules: this.byId.size } })
  }

  list(): readonly NcCalendarEventsRule[] {
    return [...this.byId.values()].toSorted((a, b) => b.updatedAt - a.updatedAt)
  }

  listEnabled(): readonly NcCalendarEventsRule[] {
    return this.list().filter((r) => r.enabled)
  }

  get(ruleId: string): NcCalendarEventsRule | null {
    return this.byId.get(ruleId) ?? null
  }

  listForOwner(userId: string): readonly NcCalendarEventsRule[] {
    return this.list().filter((r) => r.ownerUserId === undefined || r.ownerUserId === userId)
  }

  async create(
    input: NcCalendarEventsRuleInput,
    createdBy: string,
    ownerUserId?: string,
  ): Promise<NcCalendarEventsRule> {
    const now = this.now()
    const rule = NcCalendarEventsRuleSchema.parse({
      ...NcCalendarEventsRuleInputSchema.parse(input),
      id: this.newId(),
      ...(ownerUserId !== undefined ? { ownerUserId } : {}),
      createdBy,
      createdAt: now,
      updatedAt: now,
    })
    await this.write(rule)
    return rule
  }

  async update(ruleId: string, patch: NcCalendarEventsRulePatch): Promise<NcCalendarEventsRule> {
    const existing = this.byId.get(ruleId)
    if (!existing) throw new Error(`calendar-events rule not found: ${ruleId}`)
    const { template, calendars, calendarsExclude, ...rest } = patch
    const merged: NcCalendarEventsRule = {
      ...existing,
      ...rest,
      id: existing.id,
      ...(existing.ownerUserId !== undefined ? { ownerUserId: existing.ownerUserId } : {}),
      ...(existing.generatedAt !== undefined ? { generatedAt: existing.generatedAt } : {}),
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
    }
    return this.write(
      applyOptionalStringList(
        applyOptionalStringList(applyTemplatePatch(merged, template), 'calendars', calendars),
        'calendarsExclude',
        calendarsExclude,
      ),
    )
  }

  async setEnabled(ruleId: string, enabled: boolean): Promise<NcCalendarEventsRule> {
    return this.update(ruleId, { enabled })
  }

  async markGenerated(ruleId: string, windowEndMs: number): Promise<NcCalendarEventsRule> {
    const existing = this.byId.get(ruleId)
    if (!existing) throw new Error(`calendar-events rule not found: ${ruleId}`)
    return this.write({
      ...existing,
      generatedAt: Math.max(existing.generatedAt ?? 0, windowEndMs),
    })
  }

  /**
   * Idempotent delete — unknown ids are a no-op in RAM, still attempted on disk.
   * Throws on a failed durable delete (an operator just pressed a button to remove).
   */
  async delete(ruleId: string): Promise<void> {
    this.byId.delete(ruleId)
    try {
      await this.kind.delete(ruleId)
    } catch (err) {
      this.logger.warn('calendar-events rule durable delete failed', {
        meta: { ruleId, error: err instanceof Error ? err.message : String(err) },
      })
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  private async write(rule: NcCalendarEventsRule): Promise<NcCalendarEventsRule> {
    const validated = NcCalendarEventsRuleSchema.parse(rule)
    const { id, ...body } = validated
    await this.kind.put({ id, data: body })
    this.byId.set(id, validated)
    return validated
  }
}
