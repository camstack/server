/**
 * The settings-store filter compiler refuses an unbounded bulk delete.
 *
 * (The OAuth-session reaper this file used to drive moved to the
 * `oauth-sessions` records kind, D902; its "never deletes a live session"
 * property is pinned on the real engine in
 * `builtins/local-auth/__tests__/oauth-sessions-records-only.spec.ts`.)
 */
import { describe, expect, it } from 'vitest'
import {
  compileFilter,
  type CollectionShape,
} from '../../builtins/sqlite-storage/filter-compiler.js'

/** A token-shaped table: what an unbounded DELETE would empty. */
const tokens: CollectionShape = {
  primaryKey: 'id',
  columns: new Set(['userId', 'name', 'tokenHash', 'expiresAt', 'createdAt']),
  kvBlobColumn: null,
}

describe('the bulk-delete filter refuses to run unbounded', () => {
  it('an empty filter is rejected before any SQL exists', () => {
    // Not theoretical: `DELETE FROM scoped_tokens` with no WHERE would log out
    // every integration on the hub.
    expect(() => compileFilter({}, tokens, 'mutate', (v) => v)).toThrow(/every row/)
  })

  it('a predicate the table cannot express is rejected, not dropped', () => {
    expect(() => compileFilter({ where: { notAColumn: 1 } }, tokens, 'mutate', (v) => v)).toThrow(
      /cannot express/,
    )
  })
})
