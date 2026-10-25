/**
 * `NcRuleAiStore` — the durable AI section of the ORDINARY rules, keyed by rule id.
 *
 * A SIDE TABLE and not a second opinion. `NcRule` lives in `@camstack/types`;
 * the addon inlines its own copy, but the hub's cap router validates rule input
 * against the copy `@camstack/system` inlines, so a new key on it is silently
 * stripped at save until a `@camstack/server` release carrying it is installed
 * (`summary/summary-rule.ts` documents the three cascaded bugs that taught
 * this). Keeping the block here makes it live on the next
 * `camstack deploy packages/addon-post-analysis` instead.
 *
 * Nothing else in this repo stores whether a rule narrates itself, so there is
 * no authority for this table to disagree with — the D62 hazard is a switch
 * that writes a store somebody else already owned, not a store for a fact that
 * has no other home.
 *
 * Its lifetime is bound to the rule's: `nc.deleteRule` drops the row, and a row
 * whose rule is gone is inert either way (nothing reads it without a rule to
 * fire).
 *
 * Records migration (phase 2, step 20): uses `RecordKindHandle<RuleAiBody>`
 * over the `notification-center/rule-ai` record kind instead of the legacy
 * `DurableLedger`. Owner stamp: `pipeline-analytics` (the hosting addon).
 */

import type { IScopedLogger, RecordKindHandle, RecordsAccess } from '@camstack/types'
import { ncRecordKinds, type RuleAiBody } from './record-kinds.js'
import { type NcRuleAi, NcRuleAiSchema } from './rule-ai.js'

export interface NcRuleAiStoreRecordsDeps {
  readonly kind: RecordKindHandle<RuleAiBody>
  readonly logger: IScopedLogger
  readonly now?: () => number
}

export type NcRuleAiStoreDeps = NcRuleAiStoreRecordsDeps

/** One row of the kind, decoded. The record id is the ruleId. */
export interface NcRuleAiRow {
  readonly ruleId: string
  readonly ai: NcRuleAi
  readonly updatedAt: number
}

export class NcRuleAiStore {
  private readonly byRuleId = new Map<string, NcRuleAiRow>()
  private readonly kind: RecordKindHandle<RuleAiBody>
  private readonly logger: IScopedLogger
  private readonly now: () => number

  constructor(deps: NcRuleAiStoreDeps) {
    this.logger = deps.logger
    this.now = deps.now ?? ((): number => Date.now())
    this.kind = deps.kind
  }

  static of(
    records: Pick<RecordsAccess, 'kind'>,
    logger: IScopedLogger,
    now?: () => number,
  ): NcRuleAiStore {
    return new NcRuleAiStore({ kind: records.kind(ncRecordKinds['rule-ai']), logger, now })
  }

  /** (Re)hydrate — boot and the periodic rule refresh. A failed read KEEPS
   *  what is already in memory. */
  async load(): Promise<void> {
    try {
      const { records } = await this.kind.query({ limit: 10_000 })
      const next = new Map<string, NcRuleAiRow>()
      let skipped = 0
      for (const row of records) {
        const ai = NcRuleAiSchema.safeParse(row.data.ai)
        if (!ai.success) {
          skipped += 1
          continue
        }
        next.set(row.id, { ruleId: row.id, ai: ai.data, updatedAt: row.data.updatedAt })
      }
      this.byRuleId.clear()
      for (const [id, entry] of next) this.byRuleId.set(id, entry)
      if (skipped > 0) {
        this.logger.warn('rule AI rows skipped as malformed', { meta: { skipped } })
      }
    } catch (err) {
      this.logger.warn('rule AI load failed — keeping AI sections already in memory', {
        meta: { error: String(err), rows: this.byRuleId.size },
      })
    }
    this.logger.debug('rule AI sections loaded', { meta: { rows: this.byRuleId.size } })
  }

  list(): readonly NcRuleAiRow[] {
    return [...this.byRuleId.values()]
  }

  /**
   * The ENQUEUE-path read: the section to freeze on this rule's rows.
   *
   * `undefined` for a rule with no section, and that is the ordinary case —
   * every rule authored before this feature, and every rule the operator never
   * switched it on for.
   */
  get(ruleId: string): NcRuleAi | undefined {
    return this.byRuleId.get(ruleId)?.ai
  }

  /** Write (or replace) one rule's section. */
  async set(ruleId: string, ai: NcRuleAi): Promise<NcRuleAiRow> {
    const updatedAt = this.now()
    await this.kind.put({ id: ruleId, data: { ai, updatedAt } })
    const row: NcRuleAiRow = { ruleId, ai, updatedAt }
    this.byRuleId.set(ruleId, row)
    return row
  }

  /**
   * Idempotent removal — unknown ids are a no-op in RAM, still attempted on disk.
   * Deliberately throws on a failed delete (an operator just pressed a button to clear).
   */
  async clear(ruleId: string): Promise<void> {
    this.byRuleId.delete(ruleId)
    try {
      await this.kind.delete(ruleId)
    } catch (err) {
      this.logger.warn('rule AI section delete failed', {
        meta: { ruleId, error: String(err) },
      })
      throw err instanceof Error ? err : new Error(String(err))
    }
  }
}
