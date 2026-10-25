/**
 * NcRuleStore unit tests — declared-collection persistence, caller-stamped
 * create, immutable update with re-validation, enabled/delivery filtering
 * and invalid-row resilience on load.
 */
import { ncRecordKinds } from '../record-kinds.js'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { describe, it, expect, beforeEach } from 'vitest'
import type { NcRuleInput } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import type { InMemoryRecords } from '@camstack/types'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcRuleStore } from '../rule-store.js'

function makeInput(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'person at gate',
    delivery: 'immediate',
    targets: [{ targetId: 'tgt-1' }],
    conditions: { classes: ['person'] },
    ...overrides,
  })
}

describe('NcRuleStore', () => {
  let world: InMemoryRecords
  let store: NcRuleStore
  let now: number

  beforeEach(async () => {
    world = makeNcRecords()
    now = 1_000
    let seq = 0
    store = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
      now: () => now,
      newId: () => `rule-${(seq += 1)}`,
    })
  })

  it('create stamps id, createdBy (caller), timestamps and persists', async () => {
    const rule = await store.create(makeInput(), 'admin-42')
    expect(rule.id).toBe('rule-1')
    expect(rule.createdBy).toBe('admin-42')
    expect(rule.createdAt).toBe(1_000)
    expect(rule.updatedAt).toBe(1_000)
    const row = ncTable(world, 'rules').get('rule-1')!
    expect(row['name']).toBe('person at gate')
    expect(row['enabled']).toBe(true)
    expect(row['delivery']).toBe('immediate')
    expect(row['createdBy']).toBe('admin-42')
  })

  it('load hydrates persisted rules (fresh instance over the same store)', async () => {
    await store.create(makeInput(), 'admin-42')
    const store2 = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
    })
    await store2.load()
    expect(store2.list()).toHaveLength(1)
    expect(store2.get('rule-1')?.name).toBe('person at gate')
  })

  it('load skips rows whose rule JSON no longer validates', async () => {
    await store.create(makeInput(), 'admin-42')
    world.seed('rules', { id: 'broken', data: { junk: 1 } })
    const store2 = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
    })
    await store2.load()
    expect(store2.list().map((r) => r.id)).toEqual(['rule-1'])
  })

  it('listEnabled filters by enabled AND delivery', async () => {
    await store.create(makeInput({ name: 'a' }), 'u')
    await store.create(makeInput({ name: 'b', delivery: 'track-end' }), 'u')
    const off = await store.create(makeInput({ name: 'c' }), 'u')
    await store.setEnabled(off.id, false)
    expect(store.listEnabled('immediate').map((r) => r.name)).toEqual(['a'])
    expect(store.listEnabled('track-end').map((r) => r.name)).toEqual(['b'])
  })

  it('update merges immutably, bumps updatedAt and preserves provenance', async () => {
    const created = await store.create(makeInput(), 'admin-42')
    now = 2_000
    const updated = await store.update(created.id, { name: 'renamed' })
    expect(updated).not.toBe(created)
    expect(created.name).toBe('person at gate') // original untouched
    expect(updated.name).toBe('renamed')
    expect(updated.createdAt).toBe(1_000)
    expect(updated.createdBy).toBe('admin-42')
    expect(updated.updatedAt).toBe(2_000)
    expect(store.get(created.id)?.name).toBe('renamed')
  })

  it('update rejects a patch that would persist an invalid rule', async () => {
    const created = await store.create(makeInput(), 'u')
    await expect(
      // priority out of the 1..5 ordinal range
      store.update(created.id, { priority: 9 as never }),
    ).rejects.toThrow()
    expect(store.get(created.id)?.priority).toBe(3)
  })

  it('update of an unknown rule throws', async () => {
    await expect(store.update('nope', { name: 'x' })).rejects.toThrow('not found')
  })

  it('delete removes cache + persisted row; unknown ids are a no-op', async () => {
    const rule = await store.create(makeInput(), 'u')
    await store.delete(rule.id)
    expect(store.get(rule.id)).toBeNull()
    expect(ncTable(world, 'rules').has(rule.id)).toBe(false)
    await expect(store.delete('nope')).resolves.toBeUndefined()
  })

  it('update with clear removes a stored optional field', async () => {
    const created = await store.create(
      makeInput({ template: { title: 'T {{camera}}', body: 'B' } }),
      'admin',
    )
    const updated = await store.update(created.id, { name: 'renamed' }, ['template'])
    expect(updated.template).toBeUndefined()
    expect(updated.name).toBe('renamed')
    expect(store.get(created.id)?.template).toBeUndefined()
  })

  it('update with clear removes a schedule, which cannot be sent empty', async () => {
    const created = await store.create(
      makeInput({ schedule: { windows: [{ days: [1], startMinute: 480, endMinute: 1080 }] } }),
      'admin',
    )
    const updated = await store.update(created.id, {}, ['schedule'])
    expect(updated.schedule).toBeUndefined()
  })

  it('update without clear still keeps an omitted field (partial-patch contract)', async () => {
    const created = await store.create(makeInput({ template: { title: 'kept' } }), 'admin')
    const updated = await store.update(created.id, { name: 'renamed' })
    expect(updated.template).toEqual({ title: 'kept' })
  })

  it('update refuses a key that is both set and cleared', async () => {
    const created = await store.create(makeInput(), 'admin')
    await expect(
      store.update(created.id, { template: { title: 'x' } }, ['template']),
    ).rejects.toThrow("both sets and clears 'template'")
  })
})

describe('NcRuleStore ownership + per-target opt-out', () => {
  let world: InMemoryRecords
  let store: NcRuleStore
  let seq: number

  beforeEach(async () => {
    world = makeNcRecords()
    seq = 0
    store = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
      newId: () => `rule-${(seq += 1)}`,
    })
  })

  it('create persists ownerUserId and defaults disabledTargetIds to []', async () => {
    const personal = await store.create(makeInput({ ownerUserId: 'u1' }), 'u1')
    expect(personal.ownerUserId).toBe('u1')
    expect(personal.disabledTargetIds).toEqual([])
    // The FULL persisted rule body carries both fields.
    const persisted = ncTable(world, 'rules').get(personal.id)!
    expect(persisted['ownerUserId']).toBe('u1')
    expect(persisted['disabledTargetIds']).toEqual([])
  })

  it('create without ownerUserId is a global (admin) rule', async () => {
    const global = await store.create(makeInput(), 'admin-1')
    expect(global.ownerUserId).toBeUndefined()
    expect(global.disabledTargetIds).toEqual([])
  })

  it('listForOwner returns own personal + global rules only', async () => {
    await store.create(makeInput({ name: 'mine', ownerUserId: 'u1' }), 'u1')
    await store.create(makeInput({ name: 'global' }), 'admin-1')
    await store.create(makeInput({ name: 'other', ownerUserId: 'u2' }), 'u2')
    const names = store
      .listForOwner('u1')
      .map((r) => r.name)
      .sort()
    expect(names).toEqual(['global', 'mine'])
  })

  it('a global rule is visible to every owner; list() (admin path) sees all', async () => {
    await store.create(makeInput({ name: 'mine', ownerUserId: 'u1' }), 'u1')
    await store.create(makeInput({ name: 'global' }), 'admin-1')
    await store.create(makeInput({ name: 'other', ownerUserId: 'u2' }), 'u2')
    expect(store.listForOwner('stranger').map((r) => r.name)).toEqual(['global'])
    expect(
      store
        .list()
        .map((r) => r.name)
        .sort(),
    ).toEqual(['global', 'mine', 'other'])
  })

  it('setRuleTargetEnabled toggles disabledTargetIds and isRuleTargetDisabled reflects it', async () => {
    const rule = await store.create(makeInput({ targets: [{ targetId: 't2' }] }), 'admin-1')
    expect(store.isRuleTargetDisabled(rule.id, 't2')).toBe(false)
    const disabled = await store.setRuleTargetEnabled(rule.id, 't2', false)
    expect(disabled.disabledTargetIds).toEqual(['t2'])
    expect(store.isRuleTargetDisabled(rule.id, 't2')).toBe(true)
    const reenabled = await store.setRuleTargetEnabled(rule.id, 't2', true)
    expect(reenabled.disabledTargetIds).toEqual([])
    expect(store.isRuleTargetDisabled(rule.id, 't2')).toBe(false)
  })

  it('setRuleTargetEnabled is idempotent per target (no duplicate ids)', async () => {
    const rule = await store.create(makeInput({ targets: [{ targetId: 't2' }] }), 'admin-1')
    await store.setRuleTargetEnabled(rule.id, 't2', false)
    const again = await store.setRuleTargetEnabled(rule.id, 't2', false)
    expect(again.disabledTargetIds).toEqual(['t2'])
    // Removing an id that isn't present is a no-op, not an error.
    const cleared = await store.setRuleTargetEnabled(rule.id, 't2', true)
    const clearedAgain = await store.setRuleTargetEnabled(rule.id, 't2', true)
    expect(cleared.disabledTargetIds).toEqual([])
    expect(clearedAgain.disabledTargetIds).toEqual([])
  })

  it('setRuleTargetEnabled persists the opt-out across a reload', async () => {
    const rule = await store.create(makeInput({ targets: [{ targetId: 't2' }] }), 'admin-1')
    await store.setRuleTargetEnabled(rule.id, 't2', false)
    const store2 = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
    })
    await store2.load()
    expect(store2.isRuleTargetDisabled(rule.id, 't2')).toBe(true)
  })

  it('setRuleTargetEnabled on an unknown rule throws not-found', async () => {
    await expect(store.setRuleTargetEnabled('nope', 't1', false)).rejects.toThrow('not found')
  })

  it('isRuleTargetDisabled on an unknown rule is false (fail-safe read)', () => {
    expect(store.isRuleTargetDisabled('nope', 't1')).toBe(false)
  })
})

describe('the identity migration is a back-fill, never a load gate', () => {
  it('load() never touches the gallery — the 119 s boot read cannot gate the intake', async () => {
    // Measured 2026-08-19: readIdentityIds cost 119 s at boot — 74 s more
    // than every other start() read combined — for an ENRICHMENT the engine
    // does not need to match (it keeps the name leg). load() must hydrate
    // the ledger without a single gallery call.
    const world = makeNcRecords()
    let galleryCalls = 0
    const s2 = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
      newId: () => 'x',
      identityIdsByName: async () => {
        galleryCalls += 1
        return new Map()
      },
    })
    await s2.load()
    expect(galleryCalls).toBe(0)
    await s2.migrateIdentityIds()
    expect(galleryCalls).toBe(1)
  })
})
