'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.readAllRows = readAllRows
const PAGE_SIZE = 1000
const MAX_PAGES = 100
async function readAllRows(kind, query = {}, options = {}) {
  const out = []
  let cursor
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
