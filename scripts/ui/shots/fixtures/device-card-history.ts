/**
 * Device-history answers for the washer plug (971) of `hero-plug`: the device
 * card's History pane and the global lanes. Load after `hero-plug`.
 */
import { defineFixtures } from './_define'
import { DEVICE_SERIES, queryResult, seriesInfo } from './_history-data'

interface QueryManyItem {
  readonly deviceId?: number
  readonly key: string
  readonly scope?: string
}

const answer = (item: QueryManyItem, from: number, to: number) => {
  const list = DEVICE_SERIES[item.deviceId ?? 0] ?? []
  return { ok: true, result: queryResult(list, item.key, item.scope, from, to) }
}

export default defineFixtures({
  area: 'device-card-history',
  description: 'device-history series and reads for the washer plug (971)',
  handlers: {
    'deviceHistory.listSeries': (i: { deviceId: number }) =>
      seriesInfo(DEVICE_SERIES[i.deviceId] ?? []),
    'deviceHistory.queryMany': (i: {
      items: readonly QueryManyItem[]
      from: number
      to: number
    }) => ({ results: i.items.map((item) => answer(item, i.from, i.to)) }),
    'deviceHistory.query': (i: {
      deviceId: number
      key: string
      scope?: string
      from: number
      to: number
    }) => queryResult(DEVICE_SERIES[i.deviceId] ?? [], i.key, i.scope, i.from, i.to),
    'deviceHistory.getDeviceEnabled': { enabled: true },
    'deviceRuns.listRuns': { runs: [], nextCursor: null },
  },
})
