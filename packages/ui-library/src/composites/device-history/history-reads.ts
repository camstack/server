/**
 * Batched history reads. `queryMany` answers up to 24 reads over one window
 * in one call — but it is admin-only (its subjects are nested where the
 * device scope gate cannot see them). A principal it refuses reads each
 * DEVICE series through `query` instead; a node series has no other door and
 * is reported as refused.
 *
 * Every item gets an entry, in order: an answer, or the error that item met.
 * A failed item never hides the others, and is never an empty series.
 */
import {
  DEVICE_HISTORY_QUERY_MANY_MAX_ITEMS,
  type DeviceHistoryQueryManyEntry,
  type DeviceHistoryQueryManyItem,
  type DeviceHistoryQueryResult,
} from '@camstack/types'

export interface HistoryReadWindow {
  readonly from: number
  readonly to: number
  readonly maxPoints?: number
}

/** The two doors `readHistory` uses — the tRPC client in the app, a fake in a spec. */
export interface HistoryReader {
  queryMany(input: {
    readonly items: DeviceHistoryQueryManyItem[]
    readonly from: number
    readonly to: number
    readonly resolution: 'auto'
    readonly maxPoints: number
  }): Promise<{ readonly results: readonly DeviceHistoryQueryManyEntry[] }>
  query(input: {
    readonly deviceId: number
    readonly key: string
    readonly scope?: string
    readonly from: number
    readonly to: number
    readonly resolution: 'auto'
    readonly maxPoints: number
  }): Promise<DeviceHistoryQueryResult>
}

const DEFAULT_MAX_POINTS = 800

/** Split into batches of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Did the hub refuse this principal (rather than fail)? */
export function isRefusal(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const data: unknown = 'data' in err ? err.data : undefined
  const code = typeof data === 'object' && data !== null && 'code' in data ? data.code : undefined
  return code === 'FORBIDDEN' || code === 'UNAUTHORIZED'
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Read every item over one window; one entry per item, in order. */
export async function readHistory(
  reader: HistoryReader,
  items: readonly DeviceHistoryQueryManyItem[],
  window: HistoryReadWindow,
): Promise<readonly DeviceHistoryQueryManyEntry[]> {
  const maxPoints = window.maxPoints ?? DEFAULT_MAX_POINTS
  const out: DeviceHistoryQueryManyEntry[] = []
  for (const batch of chunk(items, DEVICE_HISTORY_QUERY_MANY_MAX_ITEMS)) {
    try {
      const r = await reader.queryMany({
        items: [...batch],
        from: window.from,
        to: window.to,
        resolution: 'auto',
        maxPoints,
      })
      batch.forEach((_item, i) => {
        // i18n-ignore: diagnostic text of a protocol fault, shown verbatim like a hub error
        out.push(r.results[i] ?? { ok: false, error: 'no answer for this item' })
      })
    } catch (err) {
      if (!isRefusal(err)) {
        const error = messageOf(err)
        for (const _item of batch) out.push({ ok: false, error })
        continue
      }
      out.push(
        ...(await readOneByOne(reader, batch, window.from, window.to, maxPoints, messageOf(err))),
      )
    }
  }
  return out
}

async function readOneByOne(
  reader: HistoryReader,
  batch: readonly DeviceHistoryQueryManyItem[],
  from: number,
  to: number,
  maxPoints: number,
  refusal: string,
): Promise<DeviceHistoryQueryManyEntry[]> {
  return Promise.all(
    batch.map(async (item): Promise<DeviceHistoryQueryManyEntry> => {
      if (!('deviceId' in item)) return { ok: false, error: refusal }
      try {
        const result = await reader.query({
          deviceId: item.deviceId,
          key: item.key,
          ...(item.scope !== undefined ? { scope: item.scope } : {}),
          from,
          to,
          resolution: 'auto',
          maxPoints,
        })
        return { ok: true, result }
      } catch (err) {
        return { ok: false, error: messageOf(err) }
      }
    }),
  )
}
