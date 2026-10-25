/**
 * The index-served probe (D881, D447) - the thing `check-records-index-served`
 * runs over every declared kind. It must pass a well-declared kind and FAIL on a
 * statement that scans, sorts, hides the kind or reads the row behind an index.
 */
import Database from 'better-sqlite3'
import { defineRecordKinds } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { judgeStatement, probeKind } from '../records/records-probe.js'
import { ensureRecordsSchema } from '../records/records-catalog.js'

const kinds = defineRecordKinds({
  media: {
    schema: z.object({ loc: z.string(), bytes: z.number(), trackId: z.string() }),
    class: 'ledger',
    writeTrigger: 'a spec writes it',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'loc', fields: ['loc', 'bytes'] },
      { name: 'track', fields: ['trackId'], unique: true },
    ],
    retention: { owner: 'spec', reason: 'spec' },
  },
  plain: {
    schema: z.object({ v: z.string() }),
    class: 'config',
    writeTrigger: 'a spec writes it',
    retention: { none: 'config' },
  },
  clocked: {
    schema: z.object({ v: z.string() }),
    class: 'ledger',
    writeTrigger: 'a spec writes it',
    at: 'required',
    retention: { owner: 'spec', reason: 'spec' },
  },
  // A field that LEADS one index and TRAILS an earlier one: a groupBy on it must
  // take the index it leads, or the group is built in a temp b-tree.
  shadowed: {
    schema: z.object({ deviceId: z.number(), updatedAt: z.number() }),
    class: 'ledger',
    writeTrigger: 'a spec writes it',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'device_updated', fields: ['deviceId', 'updatedAt'] },
      { name: 'updated', fields: ['updatedAt'] },
    ],
    retention: { owner: 'spec', reason: 'spec' },
  },
})

describe('records probe', () => {
  it.each([
    'media',
    'plain',
    'clocked',
    'shadowed',
  ] as const)('passes the well-declared kind "%s"', async (name) => {
    expect(await probeKind(kinds[name])).toEqual([])
  })

  describe('planted statements are judged', () => {
    function bare(): Database.Database {
      const db = new Database(':memory:')
      ensureRecordsSchema(db)
      db.exec(`CREATE INDEX rx_1_loc ON records(json_extract("data", '$.loc')) WHERE kind_id = 1`)
      return db
    }

    it('a kind_id bound as a parameter, a table scan, a sort and a table read are each caught', () => {
      const db = bare()
      const run = (sql: string, params: readonly unknown[] = []) =>
        judgeStatement(db, 'k', 'planted', { sql, params }).map((p) => p.problem)

      expect(run('SELECT rid FROM records WHERE kind_id = ?', [1]).join('\n')).toContain(
        'not a literal',
      )
      expect(
        run(`SELECT data FROM records WHERE json_extract(data, '$.zz') = 'a'`).join('\n'),
      ).toContain('scans the table')
      expect(
        run(`SELECT rid FROM records WHERE kind_id = 1 ORDER BY json_extract("data", '$.zz')`).join(
          '\n',
        ),
      ).toContain('sorts in a temp b-tree')
      expect(
        run(
          `SELECT NULL AS g, SUM(json_extract("data", '$.bytes')) AS v FROM records INDEXED BY rx_1_loc WHERE kind_id = 1 AND json_extract("data", '$.loc') = ?`,
          ['a'],
        ).join('\n'),
      ).toContain('reads the table row')
    })

    it('and a good statement is not', () => {
      const db = bare()
      expect(
        judgeStatement(db, 'k', 'ok', {
          sql: 'SELECT COUNT(*) AS n FROM records INDEXED BY records_kind_at WHERE kind_id = 1',
          params: [],
        }),
      ).toEqual([])
    })
  })

  it('reports an operation the engine refuses instead of passing silently', async () => {
    const odd = defineRecordKinds({
      odd: {
        schema: z.object({ v: z.string() }),
        class: 'config',
        writeTrigger: 'x',
        retention: { none: 'x' },
        indexes: [{ name: 'v', fields: ['v'] }],
      },
    })
    // a handle whose declaration was tampered with after definition: the engine's
    // own check on the stored index fails and the probe names it
    const broken = {
      ...odd.odd,
      declaration: { ...odd.odd.declaration, indexes: [{ name: 'v', fields: ['not a path!'] }] },
    }
    const problems = await probeKind(broken).catch((err: unknown) => [
      { kind: 'odd', op: 'declare', problem: String(err) },
    ])
    expect(problems.length).toBeGreaterThan(0)
  })
})
