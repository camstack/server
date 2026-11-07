/**
 * A system-event rule's delivery in the `modes` shape (D987, D1019).
 *
 * A stored rule says its delivery as absent / `{ mode: 'instant' }` (a message
 * per edge, D906) or `{ mode: 'summary', schedule, split? }` (only a scheduled
 * summary). Both keep meaning exactly what they meant, now written as the
 * combination the editors read and write:
 *
 *  - absent / `instant` → `{ onActivation: true, onDeactivation: <the kinds
 *    have a clearing edge> }`, kinds untouched;
 *  - `summary` → `{ onActivation: false, onDeactivation: false, onSchedule }`
 *    with the SAME schedule object (its hash arms the scheduler, so a rebuilt
 *    schedule would resend a window) and `split` as the grouping.
 *
 * Only the `device-events` / `system` families (an alarm and a mixed rule keep
 * their key). A `procedure` (a rule row is a record, written through the
 * records engine); idempotent — a row already in the `modes` shape is not
 * touched, so a rerun reports `already-done`.
 */
import {
  type MigrationProcedureResult,
  type RecordKindHandle,
  withSystemEventModes,
} from '@camstack/types'
import type { RuleBody } from '../notification-center/record-kinds.js'
import { rewriteKind } from './device-template-var.js'

/** The one kind the migration reads and writes. */
export interface NcSystemEventDeliveryPorts {
  readonly rules: RecordKindHandle<RuleBody>
}

/** The rule row with its delivery in the `modes` shape; `null` when it already is, or is not eligible. */
export function rowWithModesDelivery(data: RuleBody): RuleBody | null {
  const next = withSystemEventModes(data)
  return next === data ? null : next
}

export async function migrateSystemEventDeliveryModes(
  ports: NcSystemEventDeliveryPorts,
): Promise<MigrationProcedureResult> {
  const rules = await rewriteKind(ports.rules, rowWithModesDelivery)
  return {
    outcome: rules === 0 ? 'already-done' : 'done',
    summary: { rules },
  }
}
