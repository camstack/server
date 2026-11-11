/**
 * The Echo notification targets move from the `echoTargets` setting (one array in the addon's global
 * settings) to one `notify-alexa-echo` record each, under the SAME id so a notification rule naming it
 * still resolves (epic #440, step 6). The switch (`enabled`) is carried across, never reset.
 *
 * Each record is read back before its row leaves the setting. One bad row never aborts the others: a row
 * whose write or read-back fails is undone, reported with its id and reason, and stays in the setting,
 * where the Echo store keeps serving it. A record that already exists is never overwritten (an operator
 * may have edited it since). A row that does not parse is left where it is and keeps the setting in
 * place: nothing is destroyed on a guess (D49).
 */
import { type MigrationProcedureResult, targetBody } from '@camstack/types'
import { alexaEchoTargetSchema } from '../config.js'
import { ALEXA_SPEAK_KIND } from '../speak/constants.js'

type InstanceBody = ReturnType<typeof targetBody>

export const ECHO_TARGETS_TO_RECORDS_ID = 'import-alexa/2026-11-06-echo-targets-to-records'

/** The Echo target records, through the records door. */
export interface EchoRecordPorts {
  /** The record under `id`, or null when absent. */
  readEchoRecord(id: string): Promise<Readonly<Record<string, unknown>> | null>
  writeEchoRecord(id: string, body: InstanceBody): Promise<void>
  dropEchoRecord(id: string): Promise<void>
  /** A row left in the setting (still served from there), with the reason. */
  echoSkipped(row: { readonly id: string; readonly reason: string }): void
}

export interface EchoSettingPorts {
  /** The stored `echoTargets` value as written, one entry per row, unparsed. */
  readRows(): Promise<readonly unknown[]>
  writeRows(rows: readonly unknown[]): Promise<void>
}

export async function moveEchoTargetsToRecords(
  ports: EchoRecordPorts & EchoSettingPorts,
): Promise<MigrationProcedureResult> {
  const rows = await ports.readRows()
  if (rows.length === 0) return { outcome: 'already-done', summary: { converted: 0 } }
  let converted = 0
  let kept = 0
  let unparsed = 0
  const left: unknown[] = []
  for (const row of rows) {
    const parsed = alexaEchoTargetSchema.safeParse(row)
    if (!parsed.success) {
      unparsed += 1
      continue
    }
    const target = parsed.data
    try {
      if ((await ports.readEchoRecord(target.id)) !== null) {
        kept += 1
        continue
      }
      const body = targetBody({
        id: target.id,
        name: target.name,
        enabled: target.enabled,
        config: {
          ...(target.brokerId.length > 0 ? { brokerId: target.brokerId } : {}),
          echoId: target.echoId,
        },
      })
      await ports.writeEchoRecord(target.id, body)
      const back = await ports.readEchoRecord(target.id)
      const same =
        back !== null &&
        back['name'] === body['name'] &&
        back['enabled'] === body['enabled'] &&
        back['echoId'] === body['echoId'] &&
        back['brokerId'] === body['brokerId']
      if (!same) {
        await ports.dropEchoRecord(target.id)
        throw new Error('the new record did not read back')
      }
      converted += 1
    } catch (err) {
      await ports.dropEchoRecord(target.id).catch(() => undefined)
      ports.echoSkipped({
        id: target.id,
        reason: err instanceof Error ? err.message : String(err),
      })
      left.push(row)
    }
  }
  // Only the rows that stayed are written back; a row that did not parse keeps the whole setting.
  if (unparsed === 0) await ports.writeRows(left)
  return {
    outcome: converted > 0 || kept > 0 ? 'done' : 'already-done',
    summary: {
      converted,
      kept,
      unparsed,
      skipped: left.length,
      kind: ALEXA_SPEAK_KIND,
    },
  }
}
