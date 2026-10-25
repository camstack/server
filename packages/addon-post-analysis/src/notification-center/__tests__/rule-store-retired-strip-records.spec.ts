/**
 * Clearing a retired delivery key (`waitForEnhancement` / `groupIdleSec`) on a
 * records-backed rule store — the only store production has.
 *
 * The kind's schema does not know the retired keys, so a typed read-back
 * strips them. Deciding "is anything left to project" and "was the named key
 * stored" from that typed read said "nothing" every time: the cleared key
 * stayed on the row (and came back as a window at the next load), and a
 * window the OTHER retired key still carried was dropped or kept at the
 * cleared key's value.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { ncRecordKinds } from '../record-kinds.js'
import { NcRuleStore } from '../rule-store.js'

async function worldWith(
  stored: Record<string, unknown>,
): Promise<{ store: NcRuleStore; row: () => Promise<Record<string, unknown> | undefined> }> {
  const world = makeInMemoryRecords('pipeline-analytics')
  await world.records.declare(ncRecordKinds)
  world.seed('rules', {
    id: 'r1',
    data: {
      name: 'rule r1',
      enabled: true,
      delivery: 'immediate',
      targets: [{ targetId: 'tgt-1' }],
      conditions: { classes: ['person'], identities: ['id-1'] },
      createdBy: 'admin',
      createdAt: 1,
      updatedAt: 1,
      disabledTargetIds: [],
      ...stored,
    },
  })
  const store = NcRuleStore.of(world.records, makeSilentLogger(), () => 5_000)
  await store.load()
  return { store, row: async () => (await world.records.kind(ncRecordKinds.rules).get('r1'))?.data }
}

describe('NcRuleStore.update clear of a retired key (records)', () => {
  it('the cleared key leaves the stored row; the window the OTHER key carries survives', async () => {
    const { store, row } = await worldWith({ waitForEnhancement: true, groupIdleSec: 30 })
    expect(store.get('r1')?.groupingSec).toBe(20)
    const result = await store.update('r1', {}, ['waitForEnhancement'])
    expect(result.groupingSec).toBe(30)
    const stored = await row()
    expect(stored).not.toHaveProperty('waitForEnhancement')
    expect(stored?.['groupingSec']).toBe(30)
  })

  it('clearing the only key that carried the window removes it from the row too', async () => {
    const { store, row } = await worldWith({ waitForEnhancement: true })
    const result = await store.update('r1', {}, ['waitForEnhancement'])
    expect(result).not.toHaveProperty('groupingSec')
    const stored = await row()
    expect(stored).not.toHaveProperty('waitForEnhancement')
    expect(stored).not.toHaveProperty('groupingSec')
  })
})
