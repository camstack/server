/**
 * An `order: "id"` query must resume from its own cursor. The engine encodes
 * every cursor as the plan's key values PLUS `rid`, and the id plan expected
 * one value — so the second page of every id-ordered walk (the orphan audit's
 * `pageById`) was refused "the cursor does not belong to this query".
 */
import { describe, expect, it } from 'vitest'
import { declaration, makeHarness } from './support/records-harness.js'

const OWNER = 'spec-addon'

describe('records engine: order "id" paging', () => {
  it.each([false, true])('walks every row page by page (desc=%s)', async (desc) => {
    const h = makeHarness()
    await h.engine.declareKinds({ owner: OWNER, kinds: { ev: declaration() } })
    const ids = ['a', 'b', 'c', 'd', 'e']
    for (const [i, id] of ids.entries()) {
      await h.engine.put({
        owner: OWNER,
        kind: 'ev',
        record: { id, deviceId: 1, at: 100 - i, data: {} },
      })
    }
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await h.engine.query({
        owner: OWNER,
        kind: 'ev',
        order: 'id',
        desc,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      })
      seen.push(...page.records.map((r) => r.id))
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(desc ? [...ids].reverse() : ids)
  })
})
