/**
 * Home Assistant notify targets move from the `ha-notification-targets` record kind (a free-form
 * `config` blob) to the `notify-homeassistant` record kind with the config flat in the body (epic #440,
 * step 6). The work is `moveTargetRows`: every row keeps its id, so a notification rule that names it
 * still resolves; the switch (`enabled`) is carried across, never reset.
 */
import {
  type IScopedLogger,
  legacyTargetsOver,
  type MigrationProcedureResult,
  moveTargetRows,
  type RecordsAccess,
  targetRowPortsOver,
  type TargetRowPorts,
} from '@camstack/types'
import { HaTargetStore } from '../ha-notification-output.js'
import { haRecordKinds } from '../record-kinds.js'

export const HA_NOTIFY_TARGETS_TO_BODY_ID =
  'provider-homeassistant/2026-11-06-notify-targets-config-to-body'

/** What the migration reads and writes through. */
export interface HaNotifyPorts {
  readonly notifyRows: TargetRowPorts
}

/** The retired kind as the legacy source of the store: a row the migration skipped is still served. */
export function haLegacyTargetsOver(records: Pick<RecordsAccess, 'kind'>, logger: IScopedLogger) {
  return legacyTargetsOver(records.kind(haRecordKinds['ha-notification-targets']), logger)
}

/** Ports over the retired kind and the new one. */
export function haNotifyPortsOver(
  records: Pick<RecordsAccess, 'kind'>,
  logger: IScopedLogger,
): HaNotifyPorts {
  const legacy = haLegacyTargetsOver(records, logger)
  return {
    notifyRows: targetRowPortsOver({
      legacy,
      store: HaTargetStore.of(records, { logger, legacy }),
      logger,
    }),
  }
}

/** The HA kind carries no credential: no secret key to read back. */
export async function moveHaNotifyTargets(ports: HaNotifyPorts): Promise<MigrationProcedureResult> {
  return moveTargetRows(ports.notifyRows, () => [])
}
