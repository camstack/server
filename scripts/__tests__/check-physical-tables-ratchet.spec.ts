import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_TABLES,
  ALLOWED_UNRESOLVED_SITES,
  censusOf,
  ratchetFailures,
} from '../check-physical-tables-ratchet.js'
import { buildStorageMap } from '../lib/parse-storage.js'
import { itRealTree } from './lib/real-tree.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const allowed = {
  tables: ['a', 'b'],
  unresolvedSites: ['f.ts :: X', 'f.ts :: X'],
}

describe('check-physical-tables-ratchet', () => {
  it('passes when the census matches the lists exactly', () => {
    expect(
      ratchetFailures({ tables: ['a', 'b'], unresolvedSites: ['f.ts :: X', 'f.ts :: X'] }, allowed),
    ).toEqual([])
  })

  it('refuses a new table and sends it to ctx.records / an ADR', () => {
    const failures = ratchetFailures(
      { tables: ['a', 'b', 'c'], unresolvedSites: allowed.unresolvedSites },
      allowed,
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('new physical table "c"')
    expect(failures[0]).toContain('ctx.records')
    expect(failures[0]).toContain('ADR')
  })

  it('is shrink-only: a listed table the code no longer creates fails', () => {
    const failures = ratchetFailures(
      { tables: ['a'], unresolvedSites: allowed.unresolvedSites },
      allowed,
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('"b" is in ALLOWED_TABLES')
  })

  it('counts computed-name sites as a multiset', () => {
    const third = ratchetFailures(
      {
        tables: allowed.tables,
        unresolvedSites: ['f.ts :: X', 'f.ts :: X', 'f.ts :: X'],
      },
      allowed,
    )
    expect(third).toHaveLength(1)
    expect(third[0]).toContain('computed name: f.ts :: X')
    const gone = ratchetFailures(
      { tables: allowed.tables, unresolvedSites: ['f.ts :: X'] },
      allowed,
    )
    expect(gone).toHaveLength(1)
    expect(gone[0]).toContain('ALLOWED_UNRESOLVED_SITES')
  })

  it('keeps the committed lists sorted and the table list unique', () => {
    expect([...ALLOWED_TABLES].toSorted()).toEqual(ALLOWED_TABLES)
    expect(new Set(ALLOWED_TABLES).size).toBe(ALLOWED_TABLES.length)
    expect([...ALLOWED_UNRESOLVED_SITES].toSorted()).toEqual(ALLOWED_UNRESOLVED_SITES)
  })

  itRealTree('the workspace matches the committed lists', () => {
    const census = censusOf(
      buildStorageMap(
        ROOT,
        path.join(ROOT, 'packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts'),
      ),
    )
    expect(ratchetFailures(census)).toEqual([])
  })
})
