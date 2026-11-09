/**
 * Home Assistant notify targets move from the `ha-notification-targets` record kind (a free-form
 * `config` blob) to the `notify-homeassistant` record kind with the config flat in the body (epic #440,
 * step 6). The work is `moveTargetRows`: every row keeps its id, so a notification rule that names it
 * still resolves; the switch (`enabled`) is carried across, never reset.
 */
import {
  defineRecordKinds,
  type LegacyTargets,
  type IScopedLogger,
  type MigrationProcedureResult,
  moveTargetRows,
  OldTargetBodySchema,
  type RecordsAccess,
  retiredTargetsOver,
  targetRowPortsOver,
  type TargetRowPorts,
} from '@camstack/types'
import { HaTargetStore } from '../ha-notification-output.js'

/** The retired kind, as it was declared; read by the migration and by the store while a row stays in it. */
export const haRetiredTargetKinds = defineRecordKinds({
  'ha-notification-targets': {
    schema: OldTargetBodySchema,
    class: 'config',
    writeTrigger: 'retired: read once by the notify-targets-to-body migration',
    device: 'none',
    at: 'none',
    retention: { none: 'emptied by the migration' },
    entry: { title: 'Home Assistant notification targets (retired)' },
  },
})

export const HA_NOTIFY_TARGETS_TO_BODY_ID =
  'provider-homeassistant/2026-11-06-notify-targets-config-to-body'

/** What the migration reads and writes through. */
export interface HaNotifyPorts {
  readonly notifyRows: TargetRowPorts
}

/** The retired kind as a legacy source: declared on first read, served while a row stays in it. */
export function haLegacyTargetsOver(
  records: Pick<RecordsAccess, 'declare' | 'kind'>,
  logger: IScopedLogger,
): LegacyTargets {
  return retiredTargetsOver(records, haRetiredTargetKinds['ha-notification-targets'], logger)
}

/** Ports over the retired kind and the new one. */
export function haNotifyPortsOver(
  records: Pick<RecordsAccess, 'declare' | 'kind'>,
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
