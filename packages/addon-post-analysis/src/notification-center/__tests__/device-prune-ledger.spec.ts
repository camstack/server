/**
 * The prune ledger's own guarantees (review minors, fix round 1):
 *  - a `kept*` row is never overwritten by a later `removed` note for the same
 *    (rule, field, subject) — that would drop the disable-once guard;
 *  - a write that lands while a load is in flight is not evicted by it.
 */
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords, type NcFaultRules, withNcFaults } from './support/nc-test-deps.js'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcPruneNote } from '../device-prune.js'
import { NcPruneLedger } from '../device-prune-ledger.js'

const KEPT: NcPruneNote = {
  kind: 'rule',
  ruleId: 'r1',
  subjectKind: 'device',
  subject: '102',
  field: 'conditions.devices',
  outcome: 'kept-disabled',
}

async function ledger(
  around?: NcFaultRules['aroundQuery'],
): Promise<{ readonly l: NcPruneLedger; readonly world: InMemoryRecords }> {
  const world = makeNcRecords()
  const seen = around === undefined ? world : withNcFaults(world, { aroundQuery: around })
  const l = new NcPruneLedger({ records: seen.records, logger: makeSilentLogger() })
  await l.load()
  return { l, world }
}

describe('NcPruneLedger', () => {
  it('a later removal never overwrites the kept row — the guard stays', async () => {
    const { l } = await ledger()
    await l.record([KEPT], 'event', 1)
    await l.record([{ ...KEPT, outcome: 'removed' }], 'reconcile', 2)
    expect(l.hasKept({ kind: 'rule', ruleId: 'r1', subjectKind: 'device', subject: '102' })).toBe(
      true,
    )
    expect(l.list()).toEqual([expect.objectContaining({ outcome: 'kept-disabled', at: 1 })])
  })

  it('a write landing during a load is not evicted by that load', async () => {
    let recordDuring: Promise<void> | null = null
    let armed = false
    let target: NcPruneLedger | null = null
    const { l } = await ledger(async (_kind, read) => {
      const rows = await read()
      if (armed && target !== null) {
        // The load has its answer; a write lands before it applies it.
        recordDuring = target.record([KEPT], 'event', 3)
        await recordDuring
      }
      return rows
    })
    target = l
    armed = true
    await l.load()
    expect(recordDuring).not.toBeNull()
    expect(l.list()).toHaveLength(1)
  })

  it('a key REWRITTEN while a load is in flight keeps the newer write', async () => {
    let armed = false
    let target: NcPruneLedger | null = null
    const { l } = await ledger(async (_kind, read) => {
      const rows = await read()
      if (armed && target !== null) {
        // The answer holds the OLD row; the same key is rewritten before it lands.
        await target.record([KEPT], 'event', 9)
      }
      return rows
    })
    target = l
    await l.record([{ ...KEPT, outcome: 'removed' }], 'event', 1)
    armed = true
    await l.load()
    expect(l.list()).toEqual([expect.objectContaining({ outcome: 'kept-disabled', at: 9 })])
  })
})

describe('NcPruneLedger on records (the legacy table is gone)', () => {
  it('loads the adopted row from the records kind', async () => {
    const world = makeNcRecords()
    // What the adoption wrote: one kept row, on the records kind.
    const row = { ...KEPT, at: 5, source: 'event' as const }
    world.seed('device-prunes', {
      id: `${row.kind}:${row.ruleId}:${row.field}:${row.subject}`,
      deviceId: 102,
      data: { ruleId: row.ruleId, at: row.at, row },
    })
    const l = new NcPruneLedger({ records: world.records, logger: makeSilentLogger() })
    await l.load()
    expect(l.isLoaded()).toBe(true)
    expect(l.hasKept({ kind: 'rule', ruleId: 'r1', subjectKind: 'device', subject: '102' })).toBe(
      true,
    )
  })
})
