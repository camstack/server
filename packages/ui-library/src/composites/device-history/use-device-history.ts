/**
 * The data half of the History views: is device-history installed, which
 * series exist, and their reads over a window (plus the previous period when
 * comparing). Each stage keeps "not answered" apart from "answered nothing"
 * (D315): a pending list is never an empty one, a failed read is never a
 * flat line.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  DeviceHistoryQueryManyEntry,
  DeviceHistoryQueryManyItem,
  DeviceHistorySeriesInfo,
} from '@camstack/types'
import { useSystem } from '../../contexts/system-context'
import { useCapabilityPresence, type CapabilityPresence } from '../../hooks/use-capability-presence'
import { readHistory, type HistoryReader } from './history-reads'
import { HISTORY_WINDOW_MS, previousWindow, type HistoryWindow } from './history-window'

/** How a stage of the view stands. */
export type HistoryStage<T> =
  | { readonly status: 'pending' }
  | { readonly status: 'error'; readonly error: string }
  | { readonly status: 'ok'; readonly data: T }

const MINUTE = 60_000

/**
 * The instant a window ends at, rounded so the query key is stable between
 * renders and the view refreshes at a pace its width justifies.
 */
export function anchorNow(now: number, spanMs: number): number {
  const step =
    spanMs <= HISTORY_WINDOW_MS['24h']
      ? MINUTE
      : spanMs <= HISTORY_WINDOW_MS['7d']
        ? 5 * MINUTE
        : spanMs <= HISTORY_WINDOW_MS['30d']
          ? 15 * MINUTE
          : 60 * MINUTE
  return Math.ceil(now / step) * step
}

/** The tRPC client as the two doors `readHistory` needs. */
export function useHistoryReader(): HistoryReader {
  const client = useSystem().trpcClient
  return useMemo<HistoryReader>(
    () => ({
      queryMany: (input) => client.deviceHistory.queryMany.query(input),
      query: (input) => client.deviceHistory.query.query(input),
    }),
    [client],
  )
}

/** A device's series list, gated on device-history being present. */
export function useDeviceSeriesList(deviceId: number): {
  readonly presence: CapabilityPresence
  readonly list: HistoryStage<readonly DeviceHistorySeriesInfo[]>
} {
  const presence = useCapabilityPresence('device-history')
  const client = useSystem().trpcClient
  const q = useQuery({
    queryKey: ['device-history', 'listSeries', deviceId],
    queryFn: () => client.deviceHistory.listSeries.query({ deviceId }),
    enabled: presence === 'present',
    staleTime: 60_000,
  })
  const list: HistoryStage<readonly DeviceHistorySeriesInfo[]> =
    q.status === 'success'
      ? { status: 'ok', data: q.data }
      : q.status === 'error'
        ? { status: 'error', error: q.error.message }
        : { status: 'pending' }
  return { presence, list }
}

export interface HistoryReads {
  /** Entry per item id (see {@link readItemId}). */
  readonly current: ReadonlyMap<string, DeviceHistoryQueryManyEntry>
  /** The previous period, when comparing; shifted by `shiftMs` to overlay. */
  readonly previous: ReadonlyMap<string, DeviceHistoryQueryManyEntry> | null
  readonly shiftMs: number
}

/** Identity of a read item: subject + key (+ scope when narrowed). */
export function readItemId(item: DeviceHistoryQueryManyItem): string {
  const subject = 'deviceId' in item ? `d:${String(item.deviceId)}` : `n:${item.forNodeId}`
  return `${subject}|${item.key}|${item.scope ?? '*'}`
}

/** Read `items` over `window` (and the previous period when `compare`). */
export function useHistoryReads(
  items: readonly DeviceHistoryQueryManyItem[],
  window: HistoryWindow,
  compare: boolean,
  enabled = true,
): HistoryStage<HistoryReads> {
  const reader = useHistoryReader()
  const ids = items.map(readItemId)
  const q = useQuery({
    queryKey: ['device-history', 'reads', ids, window.from, window.to, compare],
    queryFn: async (): Promise<HistoryReads> => {
      const prev = previousWindow(window)
      const [cur, before] = await Promise.all([
        readHistory(reader, items, window),
        compare ? readHistory(reader, items, prev.window) : Promise.resolve(null),
      ])
      const toMap = (entries: readonly DeviceHistoryQueryManyEntry[]) =>
        new Map(entries.map((e, i) => [ids[i] ?? String(i), e] as const))
      return {
        current: toMap(cur),
        previous: before === null ? null : toMap(before),
        shiftMs: prev.shiftMs,
      }
    },
    enabled: enabled && items.length > 0,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  })
  if (q.status === 'success') return { status: 'ok', data: q.data }
  if (q.status === 'error') return { status: 'error', error: q.error.message }
  return { status: 'pending' }
}
