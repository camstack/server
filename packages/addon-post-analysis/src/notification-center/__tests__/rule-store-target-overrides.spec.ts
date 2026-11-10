/**
 * #487 — `targetOverrides` is stored on the rule, survives a reload, and a
 * partial `updateRule` patch leaves it untouched unless the patch names it
 * (the known `{ ...existing, ...patch }` trap). A rule stored before the field
 * reads exactly as it did: no key, no migration.
 */
import type { InMemoryRecords, NcRuleInput } from '@camstack/types'
import { NcRulePatchSchema, NcRuleInputSchema } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { ncRecordKinds } from '../record-kinds.js'
import { NcRuleStore } from '../rule-store.js'
import { makeNcRecords } from './support/nc-test-deps.js'

const OVERRIDES = {
  'tgt-echo': {
    template: { title: 'Pacco!' },
    priority: 5,
    schedule: { windows: [{ days: [1], startMinute: 360, endMinute: 540 }] },
  },
}

function input(extra: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'Parcel',
    delivery: 'immediate',
    targets: [{ targetId: 'tgt-phone' }, { targetId: 'tgt-echo' }],
    conditions: { classes: ['person'], zones: { ids: ['gate'] } },
    ...extra,
  })
}

describe('NcRuleStore — targetOverrides (#487)', () => {
  let world: InMemoryRecords
  let store: NcRuleStore

  beforeEach(() => {
    world = makeNcRecords()
    store = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
      newId: () => 'rule-1',
    })
  })

  it('round-trips through a reload', async () => {
    await store.create(input({ targetOverrides: OVERRIDES }), 'admin')
    const fresh = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
    })
    await fresh.load()
    expect(fresh.get('rule-1')?.targetOverrides).toEqual(OVERRIDES)
  })

  it('a partial patch that does not name it keeps it — and keeps the conditions', async () => {
    await store.create(input({ targetOverrides: OVERRIDES }), 'admin')
    const updated = await store.update('rule-1', NcRulePatchSchema.parse({ name: 'renamed' }))
    expect(updated.targetOverrides).toEqual(OVERRIDES)
    expect(updated.conditions.zones).toEqual({ ids: ['gate'] })
  })

  it('a patch that names it replaces it whole; `{}` empties it', async () => {
    await store.create(input({ targetOverrides: OVERRIDES }), 'admin')
    const replaced = await store.update(
      'rule-1',
      NcRulePatchSchema.parse({ targetOverrides: { 'tgt-phone': { priority: 1 } } }),
    )
    expect(replaced.targetOverrides).toEqual({ 'tgt-phone': { priority: 1 } })
    const emptied = await store.update('rule-1', NcRulePatchSchema.parse({ targetOverrides: {} }))
    expect(emptied.targetOverrides).toEqual({})
  })

  it('a rule saved without the field has none', async () => {
    const created = await store.create(input(), 'admin')
    expect(created.targetOverrides).toBeUndefined()
  })
})
