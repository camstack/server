import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_PATH,
  findViolations,
  credentialStateKeysOf,
  legacyIdentifiersOf,
} from '../check-no-settings-fallback-for-kinds.js'
import { isProductSource, loadBaseline, ROOT, readSources, walk } from '../lib/family-baseline.js'
import { itRealTree } from './lib/real-tree.js'

const DUAL_STORE = `
records.kind(Thing)
await store.declareCollection({ name: 'x' })
`
const SEEDER = `
await this.sourceStore.replaceAll(this.parseConfigSources(this.config.sources))
`
const LEGACY = `
export const THINGS_LEGACY = 'things'
const parsed = LegacyThingSchema.parse(raw)
/** Legacy collection name — kept for the adoption mapper. */
export const OLD_THINGS_COLLECTION = 'a:b'

export const FRESH_COLLECTION = 'a:c'
`
const file = (p: string, text: string) => ({ path: p, text })

const BASELINE = {
  families: {
    registry: {
      'packages/a/src/dual.ts:declareCollection': 'P5',
      'packages/a/src/seed.ts:replaceAll-config': 'P6e',
      'packages/a/src/legacy.ts:THINGS_LEGACY': 'P5',
      'packages/a/src/legacy.ts:LegacyThingSchema': 'P5',
      'packages/a/src/legacy.ts:OLD_THINGS_COLLECTION': 'P5',
    },
  },
}
const FILES = [
  file('packages/a/src/dual.ts', DUAL_STORE),
  file('packages/a/src/seed.ts', SEEDER),
  file('packages/a/src/legacy.ts', LEGACY),
]

describe('check-no-settings-fallback-for-kinds', () => {
  it('names the legacy identifiers, the doc-commented collection constants, and not a fresh one', () => {
    expect(legacyIdentifiersOf(LEGACY)).toEqual([
      'THINGS_LEGACY',
      'LegacyThingSchema',
      'OLD_THINGS_COLLECTION',
    ])
    expect(legacyIdentifiersOf('class LegacyAutomationRecipeSchema {}\nconst H = 1')).toEqual([])
  })

  it('is green on a baseline that lists every site', () => {
    expect(findViolations(FILES, BASELINE)).toEqual([])
  })

  it('is red when a baseline line is removed', () => {
    const { 'packages/a/src/dual.ts:declareCollection': _removed, ...rest } =
      BASELINE.families.registry
    const found = findViolations(FILES, { families: { registry: rest } })
    expect(found).toHaveLength(1)
    expect(found[0]?.where).toBe('packages/a/src/dual.ts')
  })

  it('is red on a stale baseline entry', () => {
    const found = findViolations(FILES, {
      families: {
        registry: {
          ...BASELINE.families.registry,
          'packages/a/src/gone.ts:declareCollection': 'x',
        },
      },
    })
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('remove the line')
  })

  it('is red on a new violation', () => {
    const found = findViolations(
      [
        ...FILES,
        file('packages/b/src/new.ts', 'defineEntryKind(x)\nstore.query({ collection: "c" })'),
      ],
      BASELINE,
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('one store per kind')
  })

  it('lets a migration name the old shape, and a file that registers no kind declare a collection', () => {
    const found = findViolations(
      [
        file('packages/a/src/migrations/index.ts', LEGACY + DUAL_STORE + SEEDER),
        file('packages/c/src/plain.ts', "await store.declareCollection({ name: 'only-physical' })"),
      ],
      { families: {} },
    )
    expect(found).toEqual([])
  })

  it('flags a collection declared in ANOTHER file of an addon package that registers a kind', () => {
    const found = findViolations(
      [
        file('packages/addon-x/src/kinds.ts', 'records.kind(Thing)'),
        file('packages/addon-x/src/port.ts', "await store.declareCollection({ name: 'x' })"),
        file('packages/addon-y/src/port.ts', "await store.declareCollection({ name: 'y' })"),
      ],
      { families: {} },
    )
    expect(found.map((v) => v.where)).toEqual(['packages/addon-x/src/port.ts'])
  })

  it('flags serving the old rows beside a kind, in another file of the package', () => {
    const found = findViolations(
      [
        file('packages/addon-x/src/kinds.ts', 'defineRecordKinds(x)'),
        file('packages/addon-x/src/addon.ts', 'return withUnmigratedLegacyRows(rows, this.config)'),
        file('packages/addon-x/src/migrations/m.ts', 'withUnmigratedLegacyRows(a)'),
        file('packages/addon-z/src/addon.ts', 'const legacyServed = []'),
      ],
      { families: {} },
    )
    expect(found.map((v) => v.where)).toEqual(['packages/addon-x/src/addon.ts'])
    expect(found[0]?.message).toContain('old rows beside a record kind')
  })

  it('names only the state keys that root a declared secret path', () => {
    const text =
      "secretStatePaths = ['tokens[userId].accessToken', \"signingKey\"]\nthis.state('tokens', S, [])\nthis.state('signingKey', z.string(), '')\nthis.state('linked', S, [])"
    expect(credentialStateKeysOf(text)).toEqual(['tokens', 'signingKey'])
    expect(credentialStateKeysOf("this.state('tokens', S, [])")).toEqual([])
    // A comment in the list, with a quote of its own, does not hide the paths under it.
    const commented =
      "secretStatePaths = [\n  // only for the migration; the live one is the record's\n  'signingKey',\n]\nthis.state('signingKey', z.string(), '')"
    expect(credentialStateKeysOf(commented)).toEqual(['signingKey'])
  })

  it('flags a credential kept in durable state beside a record kind (the planning#480 shape)', () => {
    const addon = [
      "protected override readonly secretStatePaths = ['accounts.items[id].refreshToken', 'apiKey']",
      "this.handle = this.state('accounts', AccountsSchema, { items: [] })",
      "const cursor = this.state('cursor', z.number(), 0)",
    ].join('\n')
    const found = findViolations(
      [
        file('packages/addon-x/src/kinds.ts', 'records.kind(Thing)'),
        file('packages/addon-x/src/addon.ts', addon),
        file('packages/addon-x/src/migrations/m.ts', addon),
        file('packages/addon-y/src/addon.ts', addon),
      ],
      { families: {} },
    )
    // Only the credential root, only in the kind package, never in a migration; `cursor` holds no secret.
    expect(found.map((v) => v.where)).toEqual(['packages/addon-x/src/addon.ts'])
    expect(found[0]?.message).toContain("durable state ('accounts')")
  })

  itRealTree('holds on the committed tree and baseline', { timeout: 120_000 }, () => {
    const files = [
      ...walk(path.join(ROOT, 'packages'), isProductSource),
      ...walk(path.join(ROOT, 'server'), isProductSource),
    ]
    expect(findViolations(readSources(files), loadBaseline(BASELINE_PATH))).toEqual([])
  })
})
