/**
 * The settings of one Home Assistant instance live on its own `brokers` record (planning#416):
 * the calendars it imports (`calendarIds`) and the integration it belongs to (`integrationId`)
 * sit beside its connection, under the record id (`ha_NNN`). This is the one place that reads and
 * writes them. The leftover rows of the integration are read by the migrations only
 * (`migrations/legacy-integration-rows.ts`).
 */
import type { RecordKindHandle } from '@camstack/types'

/** A broker record as stored: the migrations see fields the current schema no longer names. */
export type RawHaBrokerBody = Record<string, unknown>

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

function valuesOf(body: RawHaBrokerBody): HaInstanceValues {
  const integrationId = body['integrationId']
  const calendarIds = body['calendarIds']
  return {
    ...(typeof integrationId === 'string' ? { integrationId } : {}),
    ...(Array.isArray(calendarIds)
      ? { calendarIds: calendarIds.filter((id): id is string => typeof id === 'string') }
      : {}),
  }
}

export function haInstanceRecordPortsOver(
  kind: Pick<RecordKindHandle<RawHaBrokerBody>, 'get' | 'patch'>,
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
