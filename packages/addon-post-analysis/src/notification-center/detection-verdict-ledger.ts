/**
 * Who answered "was this detection right?", for which track, and when (#243).
 *
 * The retrain mark itself (`markForTrain`, the Library's staging mark) is a
 * lifecycle flag on the track row and carries no author. A notification button
 * needs one: the person who tapped is unknown by design (D47), but the person
 * the notification was ADDRESSED to is frozen on the token, and that is what is
 * recorded here, with the verdict and, when the operator named it, the class
 * the subject really was. The retrain page reads this to show why a track is in
 * staging and what the operator said about it.
 *
 * One row per track: a second answer about the same track replaces the first
 * (the latest word wins), so the ledger is bounded by the tracks a rule asked
 * about. The row carries the device so a deleted camera takes its rows with it
 * (`device-removal.ts`).
 */

import type { IScopedLogger } from '@camstack/types'
import { z } from 'zod'
import { DurableLedger, type DurableLedgerSpec } from '../durable/durable-ledger.js'
import { type DurableKindDeps } from '../durable/durable-wiring.js'
import { ncDurableRecordKinds } from './nc-durable-record-kinds.js'

/**
 * @durable class=ledger owner=notification-center
 *   write="the operator taps Correct / Wrong on a detection notification; one row per track, the latest answer replaces the earlier one"
 *   retention="none — bounded by the tracks a rule asked about; deleted with the camera by the device-removal hook"
 */
const NC_DETECTION_VERDICTS_COLLECTION = 'notification-center:detection-verdicts'

const NC_DETECTION_VERDICTS_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'ruleId', type: 'TEXT' as const, notNull: true },
  { name: 'at', type: 'INTEGER' as const, notNull: true },
  /** The FULL row (Zod-validated on read). */
  { name: 'row', type: 'JSON' as const, notNull: true },
] as const

export const NcDetectionVerdictRecordSchema = z.object({
  trackId: z.string().min(1),
  deviceId: z.number().int(),
  verdict: z.enum(['correct', 'wrong', 'wrong-label']),
  /** The class the operator said it really was. Only with `wrong`. */
  suggestedClass: z.string().min(1).optional(),
  /** Whose notification it was (the token's frozen owner), NOT who tapped. */
  userId: z.string().min(1),
  ruleId: z.string().min(1),
  ruleName: z.string(),
  at: z.number(),
})
export type NcDetectionVerdictRecord = z.infer<typeof NcDetectionVerdictRecordSchema>

const NC_DETECTION_VERDICTS_SPEC: DurableLedgerSpec<NcDetectionVerdictRecord> = {
  collection: NC_DETECTION_VERDICTS_COLLECTION,
  columns: [...NC_DETECTION_VERDICTS_COLUMNS],
  writeMode: 'write-through',
  keyOf: (row) => row.trackId,
  toValue: (row) => ({ ruleId: row.ruleId, at: row.at, row }),
  fromRecord: (_key, data) => {
    const parsed = NcDetectionVerdictRecordSchema.safeParse(data['row'])
    return parsed.success ? parsed.data : null
  },
  deviceIdOf: (row) => row.deviceId,
  loadLimit: 10_000,
}

export interface NcDetectionVerdictLedgerDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
}

export class NcDetectionVerdictLedger {
  private readonly ledger: DurableLedger<NcDetectionVerdictRecord>

  constructor(deps: NcDetectionVerdictLedgerDeps) {
    this.ledger = new DurableLedger({
      spec: NC_DETECTION_VERDICTS_SPEC,
      kind: deps.records.kind(ncDurableRecordKinds['detection-verdicts']),
      logger: deps.logger,
    })
  }

  /** The answers recorded for these tracks (a track nobody answered is absent).
   *  Reads the in-memory mirror: no I/O, so a listing never waits on it. */
  forTracks(trackIds: readonly string[]): ReadonlyMap<string, NcDetectionVerdictRecord> {
    const out = new Map<string, NcDetectionVerdictRecord>()
    for (const id of trackIds) {
      const row = this.ledger.get(id)
      if (row !== undefined) out.set(id, row)
    }
    return out
  }

  /** Write-through; throws on a failed write so the tap reports it. */
  async record(row: NcDetectionVerdictRecord): Promise<void> {
    await this.ledger.put(NcDetectionVerdictRecordSchema.parse(row))
  }
}
