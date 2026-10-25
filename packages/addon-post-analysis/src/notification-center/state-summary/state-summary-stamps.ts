/**
 * Which window each state-summary rule has already been SENT for (D647).
 *
 * The digest keeps this on its own rule (`generatedAt`); a state summary rides
 * an ordinary `NcRule`, whose shape is the cap's and has no server-stamped
 * field for it, so the stamp lives here, keyed by rule id. Together with the
 * outbox's dedup key (`state-summary:<ruleId>:<windowEndMs>`) it is what makes
 * a restart neither send a window twice nor skip one silently.
 *
 * `armedAt` is the floor: the moment this process first saw the rule as a
 * summary rule with THIS schedule. A window that closed before it is never
 * sent — turning summary mode on at 10:00 must not deliver the 08:00 summary
 * two hours late, and neither must editing the send time.
 *
 * Write-THROUGH: a stamp that did not land throws to the scheduler, which logs
 * it; the outbox dedup still refuses the second copy.
 */
import type { IScopedLogger } from '@camstack/types'
import { DurableLedger, type DurableLedgerSpec } from '../../durable/durable-ledger.js'
import { type DurableKindDeps } from '../../durable/durable-wiring.js'
import { ncDurableRecordKinds } from '../nc-durable-record-kinds.js'

/**
 * @durable class=ledger owner=notification-center
 *   write="a state-summary rule first seen with a schedule (armed), and every window sent, skipped as empty or missed (stamped)"
 *   retention="none — one row per rule that has ever been a state-summary rule; an operator-authored set. A deleted rule's row is inert."
 */
const NC_STATE_SUMMARY_STAMPS_COLLECTION = 'notification-center:state-summary-stamps'

const NC_STATE_SUMMARY_STAMPS_COLUMNS = [
  { name: 'ruleId', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'armedAt', type: 'INTEGER' as const, notNull: true },
  { name: 'lastWindowEnd', type: 'INTEGER' as const, notNull: true },
  { name: 'scheduleKey', type: 'TEXT' as const, notNull: true },
] as const

export interface NcStateSummaryStamp {
  readonly ruleId: string
  readonly armedAt: number
  /** The END of the last window sent, skipped as empty, or missed. 0 = none. */
  readonly lastWindowEnd: number
  /** The schedule this stamp was armed for — a different one re-arms. */
  readonly scheduleKey: string
}

const SPEC: DurableLedgerSpec<NcStateSummaryStamp> = {
  collection: NC_STATE_SUMMARY_STAMPS_COLLECTION,
  columns: NC_STATE_SUMMARY_STAMPS_COLUMNS,
  writeMode: 'write-through',
  keyOf: (row) => row.ruleId,
  toValue: (row) => ({
    armedAt: row.armedAt,
    lastWindowEnd: row.lastWindowEnd,
    scheduleKey: row.scheduleKey,
  }),
  fromRecord: (key, data) => {
    const armedAt = data['armedAt']
    const lastWindowEnd = data['lastWindowEnd']
    const scheduleKey = data['scheduleKey']
    if (typeof armedAt !== 'number' || typeof lastWindowEnd !== 'number') return null
    if (typeof scheduleKey !== 'string') return null
    return { ruleId: key, armedAt, lastWindowEnd, scheduleKey }
  },
  loadLimit: 10_000,
}

/** What the scheduler needs of the stamps — a Map in a spec. */
export interface NcStateSummaryStampPort {
  readonly get: (ruleId: string) => NcStateSummaryStamp | undefined
  /** Rejects when the write did not land. */
  readonly put: (row: NcStateSummaryStamp) => Promise<void>
  /** Has the store been READ once? Until then nothing is sent (D49). */
  readonly answered: () => boolean
}

export class NcStateSummaryStampStore {
  private readonly ledger: DurableLedger<NcStateSummaryStamp>

  constructor(deps: DurableKindDeps & { readonly logger: IScopedLogger }) {
    this.ledger = new DurableLedger({
      spec: SPEC,
      kind: deps.records.kind(ncDurableRecordKinds['state-summary-stamps']),
      logger: deps.logger,
    })
  }

  async load(): Promise<number> {
    return (await this.ledger.load()).length
  }

  port(): NcStateSummaryStampPort {
    return {
      get: (ruleId) => this.ledger.get(ruleId),
      put: (row) => this.ledger.put(row),
      answered: () => this.ledger.hasAnswered(),
    }
  }
}
