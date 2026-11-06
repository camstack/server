/**
 * The Echo notification targets move from the `echoTargets` setting (one array in the addon's global
 * settings) to one `notify-alexa-echo` record each, under the SAME id so a notification rule naming it
 * still resolves (epic #440, step 6). The switch (`enabled`) is carried across, never reset.
 *
 * Each record is read back before the setting is cleared. A record that already exists is never
 * overwritten (an operator may have edited it since). A row that does not parse is left where it is and
 * keeps the setting in place: nothing is destroyed on a guess (D49).
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
}

export interface EchoSettingPorts {
  /** The stored `echoTargets` value as written, one entry per row, unparsed. */
  readRows(): readonly unknown[]
  writeRows(rows: readonly unknown[]): Promise<void>
}

export async function moveEchoTargetsToRecords(
  ports: EchoRecordPorts & EchoSettingPorts,
): Promise<MigrationProcedureResult> {
  const rows = ports.readRows()
  if (rows.length === 0) return { outcome: 'already-done', summary: { converted: 0 } }
  let converted = 0
  let kept = 0
  let unparsed = 0
  for (const row of rows) {
    const parsed = alexaEchoTargetSchema.safeParse(row)
    if (!parsed.success) {
      unparsed += 1
      continue
    }
    const target = parsed.data
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
        respectDnd: target.respectDnd,
      },
    })
    await ports.writeEchoRecord(target.id, body)
    const back = await ports.readEchoRecord(target.id)
    const same =
      back !== null &&
      back['name'] === body['name'] &&
      back['enabled'] === body['enabled'] &&
      back['echoId'] === body['echoId'] &&
      back['respectDnd'] === body['respectDnd'] &&
      back['brokerId'] === body['brokerId']
    if (!same) {
      await ports.dropEchoRecord(target.id)
      throw new Error(`Echo target '${target.id}' did not read back - the setting is unchanged`)
    }
    converted += 1
  }
  if (unparsed === 0) await ports.writeRows([])
  return {
    outcome: converted > 0 || kept > 0 ? 'done' : 'already-done',
    summary: { converted, kept, unparsed, kind: ALEXA_SPEAK_KIND },
  }
}
