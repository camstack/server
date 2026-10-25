/**
 * `whereJsonArrayAny` against a REAL SQLite file.
 *
 * The operator exists so the track timeline's class chips narrow the READ
 * instead of narrowing a day of rows already on the phone. It compiles to
 * `json_each` + `json_valid`, and neither is something a fake can vouch for:
 * a JS `Array.some` mirror will agree with any SQL you write, including SQL
 * that throws on a malformed column or silently drops the rows that predate
 * it. Both of those are the failure this operator is shaped to avoid.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const COLLECTION = 'test:tracks-by-class'

const COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'className', type: 'TEXT' as const },
  { name: 'classes', type: 'JSON' as const },
]

let dir: string
let backend: SqliteSettingsBackend

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'camstack-json-any-'))
  backend = new SqliteSettingsBackend(join(dir, 'camstack.db'))
  await backend.initialize()
  await backend.declareCollection({ collection: COLLECTION, columns: COLUMNS })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function seed(records: readonly { id: string; data: Record<string, unknown> }[]) {
  for (const r of records) {
    await backend.insert({ collection: COLLECTION, record: { id: r.id, data: r.data } })
  }
}

const idsOf = (rows: readonly { id: string }[]): string[] => rows.map((r) => r.id).toSorted()

describe('whereJsonArrayAny over real SQLite', () => {
  beforeEach(async () => {
    await seed([
      { id: 'person', data: { className: 'person', classes: ['person'] } },
      { id: 'vehicle', data: { className: 'vehicle', classes: ['vehicle'] } },
      // className says person, the track ALSO saw an animal. Measured at 0.5%
      // of live tracks; filtering on className would have hidden it.
      { id: 'ambiguous', data: { className: 'person', classes: ['person', 'animal'] } },
      // Predates the column — 5.5% of live tracks. Unknown is not "no match".
      { id: 'legacy', data: { className: 'person', classes: null } },
    ])
  })

  it('keeps the rows whose array contains the value', async () => {
    const rows = await backend.query({
      collection: COLLECTION,
      filter: { whereJsonArrayAny: { classes: ['animal'] } },
    })
    expect(idsOf(rows)).toContain('ambiguous')
  })

  it('drops the rows whose array cannot match', async () => {
    const rows = await backend.query({
      collection: COLLECTION,
      filter: { whereJsonArrayAny: { classes: ['animal'] } },
    })
    expect(idsOf(rows)).not.toContain('vehicle')
    expect(idsOf(rows)).not.toContain('person')
  })

  it('KEEPS a row whose column is NULL — the prefilter never hides', async () => {
    const rows = await backend.query({
      collection: COLLECTION,
      filter: { whereJsonArrayAny: { classes: ['animal'] } },
    })
    expect(idsOf(rows)).toContain('legacy')
  })

  it('accepts several values at once', async () => {
    const rows = await backend.query({
      collection: COLLECTION,
      filter: { whereJsonArrayAny: { classes: ['vehicle', 'animal'] } },
    })
    expect(idsOf(rows)).toEqual(['ambiguous', 'legacy', 'vehicle'])
  })

  it('treats an EMPTY list as no filter, never as "nothing matches"', async () => {
    const rows = await backend.query({
      collection: COLLECTION,
      filter: { whereJsonArrayAny: { classes: [] } },
    })
    expect(rows).toHaveLength(4)
  })

  it('composes with the other predicates rather than replacing them', async () => {
    const rows = await backend.query({
      collection: COLLECTION,
      filter: {
        where: { className: 'person' },
        whereJsonArrayAny: { classes: ['animal'] },
      },
    })
    expect(idsOf(rows)).toEqual(['ambiguous', 'legacy'])
  })
})
