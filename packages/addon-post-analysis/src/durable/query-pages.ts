/**
 * Read a records query to the end (or to `max` rows), page by page.
 *
 * A records page is at most `RECORD_QUERY_MAX` rows and there is no offset, so an
 * owner that wants "every row since T" walks the keyset cursor. The bound is the
 * caller's: a read that reaches it says so through `truncated`.
 */
import { RECORD_QUERY_MAX, type RecordKindHandle, type RecordRow } from '@camstack/types'

/**
 * The lower bound of an open range. A records `where` orders by its range field,
 * so "every row, by time" is spelled as a range from here — never from `0`,
 * which silently drops a row stamped before the epoch a spec's clock starts at.
 */
export const RANGE_FLOOR = Number.MIN_SAFE_INTEGER

export type RecordPageQuery = Omit<Parameters<RecordKindHandle<unknown>['query']>[0], 'cursor'>

export interface CollectedRows<T> {
  readonly rows: readonly RecordRow<T>[]
  /** True when `max` stopped the walk before the store ran out of rows. */
  readonly truncated: boolean
}

export async function collectRecordPages<T>(
  kind: RecordKindHandle<T>,
  q: RecordPageQuery,
  max: number,
): Promise<CollectedRows<T>> {
  const rows: RecordRow<T>[] = []
  let cursor: string | undefined
  for (;;) {
    const remaining = max - rows.length
    if (remaining <= 0) return { rows, truncated: true }
    const page = await kind.query({
      ...q,
      limit: Math.min(RECORD_QUERY_MAX, remaining),
      ...(cursor !== undefined ? { cursor } : {}),
    })
    rows.push(...page.records)
    if (page.nextCursor === null) return { rows, truncated: false }
    cursor = page.nextCursor
  }
}
