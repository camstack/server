import type { InMemoryRecords } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { ncRecordKinds } from '../../record-kinds.js'
import { makeNcRecords, ncTable } from '../../__tests__/support/nc-test-deps.js'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import {
  type NcSummaryRuleInput,
  NcSummaryRuleInputSchema,
  NcSummaryRuleSchema,
} from '../summary-rule.js'
import { SUMMARY_RULE_CLEARABLE_KEYS } from '../summary-rule-clear.js'
import { NcSummaryStore } from '../summary-store.js'

const SCHEDULE = { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1260, endMinute: 420 }] }

function makeInput(overrides: Record<string, unknown> = {}): NcSummaryRuleInput {
  return NcSummaryRuleInputSchema.parse({
    name: 'night digest',
    deviceIds: [636, 637],
    window: { kind: 'schedule', schedule: SCHEDULE },
    targets: [{ targetId: 'tgt-1' }],
    ...overrides,
  })
}

describe('NcSummaryStore', () => {
  let world: InMemoryRecords
  let store: NcSummaryStore
  let now: number

  beforeEach(async () => {
    world = makeNcRecords()
    now = 1_000
    let seq = 0
    store = new NcSummaryStore({
      kind: world.records.kind(ncRecordKinds['summary-rules']),
      logger: makeSilentLogger(),
      now: () => now,
      newId: () => `sum-${(seq += 1)}`,
    })
  })

  it('stamps identity + provenance from the ARGUMENTS and persists the full blob', async () => {
    const rule = await store.create(makeInput(), 'admin-42')
    expect(rule.id).toBe('sum-1')
    expect(rule.createdBy).toBe('admin-42')
    expect(rule.ownerUserId).toBeUndefined()
    expect(rule.generatedAt).toBeUndefined()
    const row = ncTable(world, 'summary-rules').get('sum-1')
    expect(row?.['enabled']).toBe(true)
    expect(NcSummaryRuleSchema.parse({ ...row, id: 'sum-1' }).id).toBe('sum-1')
  })

  it('refuses to inherit an owner that rode in on the blob', async () => {
    // A persisted rule is structurally assignable to the input type, so a
    // future "duplicate rule" would compile clean and clone the owner.
    const existing = await store.create(makeInput(), 'admin-42', 'user-a')
    const clone = await store.create(existing, 'admin-42')
    expect(clone.ownerUserId).toBeUndefined()
    expect(clone.createdBy).toBe('admin-42')
    expect(clone.id).toBe('sum-2')
  })

  it('a partial patch changes only what it names', async () => {
    const rule = await store.create(
      makeInput({ maxTiles: 12, maxAiImages: 4, deliverEmpty: true }),
      'admin',
    )
    now = 2_000
    const patched = await store.update(rule.id, { name: 'renamed' })
    expect(patched.name).toBe('renamed')
    expect(patched.maxTiles).toBe(12)
    expect(patched.maxAiImages).toBe(4)
    expect(patched.deliverEmpty).toBe(true)
    expect(patched.deviceIds).toEqual([636, 637])
    expect(patched.updatedAt).toBe(2_000)
    expect(patched.createdAt).toBe(1_000)
  })

  it('a patch can never re-own a rule, even hand-built', async () => {
    const rule = await store.create(makeInput(), 'admin', 'user-a')
    const patched = await store.update(rule.id, { name: 'x' })
    expect(patched.ownerUserId).toBe('user-a')
    expect(patched.createdBy).toBe('admin')
  })

  it('clears template / filters / ai on an explicit null and leaves them on undefined', async () => {
    const rule = await store.create(
      makeInput({
        template: { title: 't' },
        filters: { classes: ['person'] },
        ai: { enabled: true },
      }),
      'admin',
    )
    const kept = await store.update(rule.id, { name: 'y' })
    expect(kept.template).toEqual({ title: 't' })
    expect(kept.filters).toEqual({ classes: ['person'] })
    expect(kept.ai).toEqual({ enabled: true })
    const cleared = await store.update(rule.id, { template: null, filters: null, ai: null })
    expect(cleared).not.toHaveProperty('template')
    expect(cleared).not.toHaveProperty('filters')
    expect(cleared).not.toHaveProperty('ai')
  })

  describe('update with a clear list', () => {
    it('clears every clearable key, and the removal survives a reload', async () => {
      const rule = await store.create(makeInput({ captionText: 'Notte' }), 'admin')
      const cleared = await store.update(rule.id, {}, [...SUMMARY_RULE_CLEARABLE_KEYS])
      for (const key of SUMMARY_RULE_CLEARABLE_KEYS) expect(cleared).not.toHaveProperty(key)
      await store.load()
      for (const key of SUMMARY_RULE_CLEARABLE_KEYS)
        expect(store.get(rule.id)).not.toHaveProperty(key)
    })

    it('a stored "no caption" (\'\') is cleared too — the key goes, not just the text', async () => {
      const rule = await store.create(makeInput({ captionText: '' }), 'admin')
      const cleared = await store.update(rule.id, {}, ['captionText'])
      expect(cleared).not.toHaveProperty('captionText')
    })

    it('refuses set+clear of one key and writes nothing', async () => {
      const rule = await store.create(makeInput({ captionText: 'Notte' }), 'admin')
      await expect(
        store.update(rule.id, { captionText: 'Giorno' }, ['captionText']),
      ).rejects.toThrow(/both sets and clears 'captionText'/)
      expect(store.get(rule.id)?.captionText).toBe('Notte')
    })

    it('an empty list is a plain merge', async () => {
      const rule = await store.create(makeInput({ captionText: 'Notte' }), 'admin')
      const patched = await store.update(rule.id, { name: 'x' }, [])
      expect(patched.captionText).toBe('Notte')
      expect(patched.name).toBe('x')
    })
  })

  it('markGenerated stores the WINDOW END and never regresses', async () => {
    const rule = await store.create(makeInput(), 'admin')
    await store.markGenerated(rule.id, 5_000)
    expect(store.get(rule.id)?.generatedAt).toBe(5_000)
    await store.markGenerated(rule.id, 3_000)
    expect(store.get(rule.id)?.generatedAt).toBe(5_000)
    // A generation is not an edit.
    expect(store.get(rule.id)?.updatedAt).toBe(1_000)
  })

  it('load survives a row whose JSON no longer validates', async () => {
    await store.create(makeInput(), 'admin')
    world.seed('summary-rules', { id: 'broken', data: { name: 'x', enabled: true, updatedAt: 1 } })
    await store.load()
    expect(store.list().map((r) => r.id)).toEqual(['sum-1'])
  })

  it('listForOwner shows own personal rules plus every global one', async () => {
    await store.create(makeInput({ name: 'global' }), 'admin')
    await store.create(makeInput({ name: 'mine' }), 'user-a', 'user-a')
    await store.create(makeInput({ name: 'theirs' }), 'user-b', 'user-b')
    expect(
      store
        .listForOwner('user-a')
        .map((r) => r.name)
        .toSorted(),
    ).toEqual(['global', 'mine'])
  })

  it('listEnabled hides a disabled rule', async () => {
    const rule = await store.create(makeInput(), 'admin')
    await store.setEnabled(rule.id, false)
    expect(store.listEnabled()).toHaveLength(0)
    expect(store.list()).toHaveLength(1)
  })
})
