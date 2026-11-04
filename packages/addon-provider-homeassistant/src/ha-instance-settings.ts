/**
 * The settings of one Home Assistant instance live on its own `brokers` record (planning#416):
 * the calendars it imports (`calendarIds`) and the integration it belongs to (`integrationId`)
 * sit beside its connection, under the record id (`ha_NNN`). This is the one place that reads and
 * writes them. The old home, the `integration_settings` rows of the integration, is read by the
 * migrations only (`migrations/legacy-integration-rows.ts`).
 */
import type { RecordKindHandle } from '@camstack/types'
import type { HaBrokerBody } from './broker-record-kinds.js'

/** What an instance carries beside its connection. */
export type HaInstanceValues = {
  readonly integrationId?: string
  readonly calendarIds?: readonly string[]
}

export interface HaInstanceRecordPorts {
  /** The instance values of one record; `null` when the record is gone. Throws when unreadable. */
  readInstance(brokerId: string): Promise<HaInstanceValues | null>
  /**
   * Merge `patch` into one record (a field the patch omits is untouched). `false` when the
   * record is gone (never recreated); throws when the write fails.
   */
  patchInstance(brokerId: string, patch: HaInstanceValues): Promise<boolean>
}

function valuesOf(body: HaBrokerBody): HaInstanceValues {
  return {
    ...(body.integrationId !== undefined ? { integrationId: body.integrationId } : {}),
    ...(body.calendarIds !== undefined ? { calendarIds: body.calendarIds } : {}),
  }
}

export function haInstanceRecordPortsOver(
  kind: Pick<RecordKindHandle<HaBrokerBody>, 'get' | 'patch'>,
): HaInstanceRecordPorts {
  return {
    readInstance: async (brokerId) => {
      const row = await kind.get(brokerId)
      return row === null ? null : valuesOf(row.data)
    },
    patchInstance: async (brokerId, patch) => {
      const row = await kind.get(brokerId)
      if (row === null) return false
      await kind.patch(brokerId, patch, { ifRev: row.rev })
      return true
    },
  }
}
