/**
 * The `device-runs` capability over the run ledger. Reads go to the store, never
 * to the recorder's mirror: an answered empty page is "no runs", and the open
 * run is what is on disk (the open row is written through).
 */
import type {
  DeviceRun,
  DeviceRunOutcome,
  IDeviceRunsProvider,
  RecordKindHandle,
  RecordWhere,
} from '@camstack/types'

interface Window {
  readonly atFrom?: number | undefined
  readonly atTo?: number | undefined
}

/** `device_outcome` index: deviceId, outcome (equality), then the start as the range. */
function outcomeWhere(deviceId: number, outcome: DeviceRunOutcome, window: Window): RecordWhere {
  const range = {
    ...(window.atFrom !== undefined ? { gte: window.atFrom } : {}),
    ...(window.atTo !== undefined ? { lt: window.atTo } : {}),
  }
  return {
    deviceId,
    outcome,
    ...(Object.keys(range).length > 0 ? { startedAt: range } : {}),
  }
}

export function createDeviceRunsProvider(runs: RecordKindHandle<DeviceRun>): IDeviceRunsProvider {
  return {
    listRuns: async (input) => {
      const paging = {
        desc: true,
        limit: input.limit,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      }
      const page =
        input.outcome === undefined
          ? await runs.query({
              deviceId: input.deviceId,
              ...(input.atFrom !== undefined ? { atFrom: input.atFrom } : {}),
              ...(input.atTo !== undefined ? { atTo: input.atTo } : {}),
              ...paging,
            })
          : await runs.query({
              where: outcomeWhere(input.deviceId, input.outcome, input),
              ...paging,
            })
      return { runs: page.records.map((row) => row.data), nextCursor: page.nextCursor }
    },
    getRun: async ({ deviceId, runId }) => {
      const row = await runs.get(runId)
      return row !== null && row.data.deviceId === deviceId ? row.data : null
    },
    getCurrentRun: async ({ deviceId }) => {
      const page = await runs.query({ where: { state: 'open', deviceId }, desc: true, limit: 1 })
      return page.records[0]?.data ?? null
    },
  }
}
