import { describe, expect, it } from 'vitest'
import {
  MigrationCatalogueSchema,
  MigrationMetaSchema,
  MigrationPlanSchema,
  orderMigrations,
  type MigrationMeta,
} from '../migration.js'

function meta(over: Partial<MigrationMeta> = {}): MigrationMeta {
  return {
    id: 'hub/2026-10-31-first',
    owner: 'hub',
    level: 'hub-store',
    seq: 1,
    dependsOn: [],
    store: 'settings',
    scope: 'cluster',
    onFailure: 'block-owner',
    bodyKind: 'sql',
    description: 'a test migration',
    fixtureMark: 'mark',
    ...over,
  }
}

describe('MigrationMeta', () => {
  it('accepts a well-formed migration', () => {
    expect(MigrationMetaSchema.safeParse(meta()).success).toBe(true)
  })

  it('refuses a bad id', () => {
    for (const id of [
      'first',
      'hub/first',
      'hub/2026-10-31',
      'Hub/2026-10-31-x',
      'hub/26-10-31-x',
    ]) {
      expect(MigrationMetaSchema.safeParse(meta({ id })).success, id).toBe(false)
    }
  })

  it('refuses an id whose prefix is not its owner', () => {
    expect(MigrationMetaSchema.safeParse(meta({ owner: 'other' })).success).toBe(false)
  })

  it('refuses a non-positive seq', () => {
    expect(MigrationMetaSchema.safeParse(meta({ seq: 0 })).success).toBe(false)
  })
})

describe('MigrationCatalogue', () => {
  const a = meta({ id: 'hub/2026-10-31-a', seq: 1 })
  const b = meta({ id: 'hub/2026-10-31-b', seq: 2 })

  it('accepts an ordered catalogue', () => {
    expect(MigrationCatalogueSchema.safeParse([a, b]).success).toBe(true)
  })

  it('refuses a duplicate id', () => {
    expect(MigrationCatalogueSchema.safeParse([a, { ...b, id: a.id }]).success).toBe(false)
  })

  it('refuses a duplicate seq within an owner', () => {
    const result = MigrationCatalogueSchema.safeParse([a, { ...b, seq: 1 }])
    expect(result.success).toBe(false)
    if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('seq')
  })

  it('refuses a seq that does not increase in declaration order', () => {
    expect(MigrationCatalogueSchema.safeParse([b, a]).success).toBe(false)
  })

  it('refuses a dependsOn cycle', () => {
    const x = meta({ id: 'hub/2026-10-31-x', seq: 1, dependsOn: ['addon-x/2026-10-31-y'] })
    const y = meta({
      id: 'addon-x/2026-10-31-y',
      owner: 'addon-x',
      level: 'addon-state',
      seq: 1,
      dependsOn: [x.id],
    })
    const result = MigrationCatalogueSchema.safeParse([x, y])
    expect(result.success).toBe(false)
    if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('cycle')
  })

  it('refuses a dependsOn that names an unknown id', () => {
    expect(
      MigrationCatalogueSchema.safeParse([{ ...a, dependsOn: ['hub/2026-01-01-ghost'] }]).success,
    ).toBe(false)
  })
})

describe('orderMigrations', () => {
  it('orders by dependsOn, ties by (owner, seq)', () => {
    const hub1 = meta({ id: 'hub/2026-10-31-a', seq: 1 })
    const zed = meta({ id: 'zed/2026-10-31-a', owner: 'zed', level: 'addon-state', seq: 1 })
    const alpha = meta({
      id: 'alpha/2026-10-31-a',
      owner: 'alpha',
      level: 'addon-state',
      seq: 1,
      dependsOn: [zed.id],
    })
    expect(orderMigrations([alpha, zed, hub1]).map((m) => m.id)).toEqual([
      hub1.id,
      zed.id,
      alpha.id,
    ])
  })

  it('runs a lower seq of an owner first even without dependsOn', () => {
    const second = meta({ id: 'hub/2026-10-31-b', seq: 2 })
    const first = meta({ id: 'hub/2026-10-31-a', seq: 1 })
    expect(orderMigrations([second, first]).map((m) => m.id)).toEqual([first.id, second.id])
  })
})

describe('MigrationPlan', () => {
  it('accepts every edit kind and refuses an unknown one', () => {
    const edits = [
      { op: 'setKeys', scope: 'x:addon-settings', values: { a: 1 } },
      { op: 'deleteKeys', scope: 'x:addon-settings', keys: ['a'], precondition: 'h' },
      { op: 'putRow', table: 't', key: { id: 1 }, row: { id: 1 } },
      { op: 'deleteRow', table: 't', key: { id: 1 } },
      { op: 'upsertRecord', kind: 'k', recordKey: 'r', value: {} },
      { op: 'deleteRecord', kind: 'k', recordKey: 'r' },
    ]
    expect(MigrationPlanSchema.safeParse({ edits }).success).toBe(true)
    expect(MigrationPlanSchema.safeParse({ edits: [{ op: 'truncate' }] }).success).toBe(false)
  })
})
