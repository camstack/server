/**
 * Read every row of a record kind, page by page. A read that cannot finish
 * THROWS: a truncated list reported as the whole list is how a rollup answers
 * "no usage" for a hub that billed all day.
 */
import type {
  RecordKindHandle,
  RecordQueryInput,
  RecordQueryOptions,
  RecordRow,
} from '@camstack/types'

const PAGE_SIZE = 1000
/** 100 000 rows — far above anything the AI kinds hold. */
const MAX_PAGES = 100

export type RecordPageQuery = Omit<RecordQueryInput, 'kind' | 'limit' | 'cursor'>

export async function readAllRows<T>(
  kind: RecordKindHandle<T>,
  query: RecordPageQuery = {},
  options: RecordQueryOptions = {},
): Promise<RecordRow<T>[]> {
  const out: RecordRow<T>[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer = await kind.query(
      { ...query, limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
      options,
    )
    out.push(...answer.records)
    if (answer.nextCursor === null) return out
    cursor = answer.nextCursor
  }
  throw new Error(`record kind "${kind.name}" holds more than ${MAX_PAGES * PAGE_SIZE} rows`)
}
