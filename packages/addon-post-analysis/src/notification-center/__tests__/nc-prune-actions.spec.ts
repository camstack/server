/**
 * `nc.listPrunes` — what the deleted-device / deleted-target prune did, for the
 * banner both UIs show on a rule it switched off. Admin-only, like the other
 * `nc.*` admin reads; a node with no centre refuses rather than answering an
 * empty list (D315: an unanswered read must never look like "nothing pruned").
 */
import { ncRecordKinds } from '../record-kinds.js'
import { makeNcRecords } from './support/nc-test-deps.js'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcPruneRecord } from '../device-prune-ledger.js'
import { makeNcActionHandlers, type NcActionHandlers, ncActions } from '../nc-actions.js'
import { NcRuleAiStore } from '../rule-ai-store.js'
import { NcRuleStore } from '../rule-store.js'

const RECORD: NcPruneRecord = {
  kind: 'rule',
  ruleId: 'r1',
  subjectKind: 'device',
  subject: '102',
  field: 'conditions.devices',
  outcome: 'kept-disabled',
  at: 5_000,
  source: 'event',
}

function handlers(listPrunes?: () => Promise<readonly NcPruneRecord[]>): NcActionHandlers {
  const world = makeNcRecords()
  return makeNcActionHandlers({
    ruleStore: new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
    }),
    ruleAiStore: new NcRuleAiStore({
      kind: world.records.kind(ncRecordKinds['rule-ai']),
      logger: makeSilentLogger(),
    }),
    logger: makeSilentLogger(),
    listCallerTargetIds: async () => [],
    snooze: {
      list: () => [],
      create: async () => Promise.reject(new Error('n/a')),
      cancel: async () => undefined,
    },
    ...(listPrunes !== undefined ? { listPrunes } : {}),
  })
}

describe('nc.listPrunes', () => {
  it('is declared admin-only', () => {
    expect(ncActions['nc.listPrunes'].auth).toBe('admin')
  })

  it('answers the recorded prunes to an admin', async () => {
    const result = await handlers(async () => [RECORD])['nc.listPrunes'](
      {},
      { userId: 'a', isAdmin: true },
    )
    expect(result.prunes).toEqual([RECORD])
  })

  it('refuses a non-admin, and an absent caller', async () => {
    const h = handlers(async () => [RECORD])
    await expect(h['nc.listPrunes']({}, { userId: 'u', isAdmin: false })).rejects.toThrow(/admin/)
    await expect(h['nc.listPrunes']({})).rejects.toThrow()
  })

  it('refuses on a node with no centre instead of answering an empty list', async () => {
    await expect(handlers()['nc.listPrunes']({}, { userId: 'a', isAdmin: true })).rejects.toThrow(
      /not wired/,
    )
  })
})
