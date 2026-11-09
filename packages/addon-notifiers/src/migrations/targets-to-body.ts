/**
 * Notification targets move from one record kind with a free-form `config` blob to one record kind per
 * target kind with the config flat in the body (epic #440, step 6). The work is `moveTargetRows`: every
 * secret is written to the keychain by the records door and read back before the old row goes.
 */
import {
  defineRecordKinds,
  type MigrationProcedureResult,
  moveTargetRows,
  OldTargetBodySchema,
  type RecordKindHandle,
  type TargetRowPorts,
} from '@camstack/types'
import { z } from 'zod'

export const TARGETS_TO_BODY_ID = 'notifiers/2026-11-06-targets-config-to-body'

/** The retired single kind, as it was declared; read by the migration and by the store while a row stays in it. */
export const OLD_TARGETS_KIND = 'notification-targets'
export const oldTargetKinds = defineRecordKinds({
  [OLD_TARGETS_KIND]: {
    schema: OldTargetBodySchema,
    class: 'config',
    writeTrigger: 'retired: read once by the targets-to-body migration',
    device: 'none',
    at: 'none',
    retention: {
      none: 'emptied by the migration; a row of a kind this addon does not serve stays',
    },
    entry: { title: 'Notification targets (retired)' },
  },
})
export type OldTargetsHandle = RecordKindHandle<z.infer<typeof OldTargetBodySchema>>

export interface NotifiersMigrationPorts {
  readonly rows: TargetRowPorts
  readonly secretKeysOf: (kind: string) => readonly string[]
}

export async function moveNotifierTargets(
  ports: NotifiersMigrationPorts,
): Promise<MigrationProcedureResult> {
  return moveTargetRows(ports.rows, ports.secretKeysOf)
}
