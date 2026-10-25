/**
 * The three records guards (D881) are armed: each rule is tested on a fixture
 * that breaks it, and on one that does not.
 *
 *  - check-records-no-unindexed-where: a where key outside every declared index,
 *    a non-literal `indexes`, and SQL against the records tables outside the engine;
 *  - check-durable-state-declared (kinds): a kind spec that leaves out class,
 *    writeTrigger or retention;
 *  - check-records-index-served: the module reader that feeds the probe.
 */
import { describe, expect, it } from 'vitest'
import { defineRecordKinds } from '../../packages/types/src/records/record-kind.js'
import { kindsOfModule } from '../check-records-index-served.js'
import { findViolations } from '../check-records-no-unindexed-where.js'
import { scanKindSpecs, scanWhereUses, unclassifiedKinds } from '../lib/parse-records.js'
import { z } from 'zod'

const KINDS_FILE = `
import { defineRecordKinds } from '@camstack/types'
export const kinds = defineRecordKinds({
  media: {
    schema: z.object({ loc: z.string(), bytes: z.number() }),
    class: 'ledger',
    writeTrigger: 'one row per media file',
    retention: { owner: 'x', reason: 'swept by the owner' },
    indexes: [{ name: 'loc', fields: ['loc', 'bytes'] }],
  },
})
`

const files = (
  extra: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] => [
  ['packages/addon-x/src/kinds.ts', KINDS_FILE],
  ...extra,
]

describe('check-records-no-unindexed-where', () => {
  it('accepts a where on a declared index field', () => {
    const use = `export async function f(h) { return h.query({ where: { loc: 'a' }, limit: 1 }) }`
    expect(findViolations(files([['packages/addon-x/src/use.ts', use]]))).toEqual([])
  })

  it('rejects a where on a field no index declares - the unindexed filter does not compile', () => {
    const use = `export async function f(h) { return h.count({ where: { trackId: 'a' } }) }`
    const found = findViolations(files([['packages/addon-x/src/use.ts', use]]))
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('"trackId" is not a field of any index')
  })

  it('reads deleteWhere and aggregate too', () => {
    const use = `h.deleteWhere({ where: { nope: 1 } }); h.aggregate({ op: 'count', where: { nope2: 1 } })`
    expect(findViolations(files([['packages/addon-x/src/use.ts', use]]))).toHaveLength(2)
  })

  it('does not look at another package or at a test', () => {
    const use = `h.count({ where: { trackId: 'a' } })`
    expect(findViolations(files([['packages/addon-y/src/use.ts', use]]))).toEqual([])
    expect(findViolations(files([['packages/addon-x/src/__tests__/use.spec.ts', use]]))).toEqual([])
  })

  it('rejects an `indexes` it cannot read', () => {
    const odd = KINDS_FILE.replace(
      "indexes: [{ name: 'loc', fields: ['loc', 'bytes'] }]",
      'indexes: SHARED_INDEXES',
    )
    const found = findViolations([['packages/addon-x/src/kinds.ts', odd]])
    expect(found[0]?.message).toContain('array literal')
  })

  it('rejects SQL against the records tables outside the engine, and allows the engine itself', () => {
    const sql = 'db.prepare("SELECT * FROM records WHERE kind_id = 3").all()'
    const found = findViolations([['packages/addon-x/src/raw.ts', sql]])
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('outside the engine')
    expect(
      findViolations([
        ['packages/system/src/builtins/sqlite-storage/records/records-engine.ts', sql],
      ]),
    ).toEqual([])
    expect(
      findViolations([['packages/addon-x/src/raw.ts', '// FROM records is the table']]),
    ).toEqual([])
  })
})

describe('check-durable-state-declared: record kinds', () => {
  it('flags a kind that leaves out class, writeTrigger or retention', () => {
    const source = `
      defineRecordKinds({
        good: { schema: s, class: 'config', writeTrigger: 'x', retention: { none: 'y' } },
        noClass: { schema: s, writeTrigger: 'x', retention: { none: 'y' } },
        bare: { schema: s },
      })`
    const missing = unclassifiedKinds(scanKindSpecs('a.ts', source)).map((u) => [u.kind, u.missing])
    expect(missing).toEqual([
      ['noClass', ['class']],
      ['bare', ['class', 'writeTrigger', 'retention']],
    ])
  })

  it('an entry kind is classified by defineEntryKind', () => {
    const source = `defineEntryKind('smtp', { title: 'SMTP', schema: s })`
    const specs = scanKindSpecs('a.ts', source)
    expect(specs).toHaveLength(1)
    expect(unclassifiedKinds(specs)).toEqual([])
  })

  it('reads where keys and literal index fields', () => {
    const uses = scanWhereUses('a.ts', `x.query({ where: { a: 1, 'b': 2 } })`)
    expect(uses[0]?.keys).toEqual(['a', 'b'])
    expect(scanKindSpecs('k.ts', KINDS_FILE)[0]?.indexFields).toEqual([['loc', 'bytes']])
  })
})

describe('check-records-index-served: module reader', () => {
  it('finds kinds exported directly or as a map, and nothing else', () => {
    const defined = defineRecordKinds({
      a: {
        schema: z.object({ v: z.string() }),
        class: 'config',
        writeTrigger: 'x',
        retention: { none: 'y' },
      },
    })
    expect(kindsOfModule({ kinds: defined, other: 3, str: 'x' }).map((k) => k.name)).toEqual(['a'])
    expect(kindsOfModule({ single: defined.a }).map((k) => k.name)).toEqual(['a'])
    expect(kindsOfModule({})).toEqual([])
  })
})
