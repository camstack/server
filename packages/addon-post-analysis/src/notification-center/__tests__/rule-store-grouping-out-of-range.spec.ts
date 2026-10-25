/**
 * A stored `groupingSec` outside [NC_GROUPING_MIN_SEC, NC_GROUPING_MAX_SEC] must not take the
 * whole rule down with it.
 *
 * Incident 2026-10-22: the operator's system-event rule "Eventi di sistema — dispositivi"
 * (`stream-offline`, `stream-online`, `detection-blind`) had been stored with `groupingSec: 0`
 * since the 2026-10-18 records adoption. `NcRuleSchema` refuses 0 (min 5), so every load skipped
 * the row as "malformed" — counted, never named — and the rule vanished from the engine AND
 * from `listRules`. A camera lost power for 2 h 15 m and its `stream-offline` matched NO rule.
 *
 * `0` only ever meant "no window", and a grouping window cannot even apply to a system-event
 * rule. The read projection now treats a non-positive window as absent and clamps a positive
 * out-of-range one, says so once per rule, and a row that still fails is named with its reason.
 */
import type { InMemoryRecords } from '@camstack/types'
import { NC_GROUPING_MAX_SEC } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { ncRecordKinds } from '../record-kinds.js'
import { NcRuleStore } from '../rule-store.js'
import { makeNcRecords } from './support/nc-test-deps.js'

const REPAIRED_LINE = 'rule carries an out-of-range groupingSec — repaired on read'
const SKIPPED_LINE = 'notification rule rows skipped as malformed'

/** The prod row, as `storageAdmin.readRecords` returned it on 2026-10-22 (target id kept generic). */
function streamOfflineRule(
  id: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    name: 'Eventi di sistema — dispositivi',
    enabled: true,
    delivery: 'system-event',
    conditions: {
      systemEvent: {
        kinds: ['stream-offline', 'stream-online', 'detection-blind'],
        deviceTypes: ['camera'],
      },
    },
    targets: [{ targetId: 'tgt-1' }],
    media: { attach: 'none' },
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    priority: 3,
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 1,
    disabledTargetIds: [],
    ...overrides,
  }
}

/** A RAW records row, the id being the record key — exactly how the engine holds it. */
function seed(world: InMemoryRecords, rule: Record<string, unknown>): void {
  const { id, ...body } = rule
  world.seed('rules', { id: String(id), data: body })
}

function makeStore(
  world: InMemoryRecords,
  logger: ReturnType<typeof makeLogRecorder>['logger'],
): NcRuleStore {
  return new NcRuleStore({ kind: world.records.kind(ncRecordKinds.rules), logger })
}

describe('NcRuleStore.load — a stored groupingSec out of range', () => {
  it('keeps a system-event rule stored with groupingSec: 0, without the window', async () => {
    const world = makeNcRecords()
    seed(world, streamOfflineRule('r-stream', { groupingSec: 0 }))
    const rec = makeLogRecorder()
    const store = makeStore(world, rec.logger)

    await store.load()

    const rule = store.get('r-stream')
    expect(rule).not.toBeNull()
    expect(rule?.conditions.systemEvent?.kinds).toContain('stream-offline')
    expect(rule?.groupingSec).toBeUndefined()
    expect(store.list().map((r) => r.id)).toEqual(['r-stream'])
    expect(rec.entries.filter((e) => e.message === SKIPPED_LINE)).toEqual([])
    const repaired = rec.entries.filter((e) => e.message === REPAIRED_LINE)
    expect(repaired).toHaveLength(1)
    expect(repaired[0]?.extras?.meta).toMatchObject({ ruleId: 'r-stream', from: 0, to: null })
  })

  it('says the repair once per rule, not on every refresh tick', async () => {
    const world = makeNcRecords()
    seed(world, streamOfflineRule('r-stream', { groupingSec: 0 }))
    const rec = makeLogRecorder()
    const store = makeStore(world, rec.logger)

    await store.load()
    await store.load()

    expect(rec.entries.filter((e) => e.message === REPAIRED_LINE)).toHaveLength(1)
    expect(store.get('r-stream')).not.toBeNull()
  })

  it('clamps a positive window above the maximum on a groupable rule', async () => {
    const world = makeNcRecords()
    seed(
      world,
      streamOfflineRule('r-person', {
        name: 'person',
        delivery: 'immediate',
        conditions: { classes: ['person'] },
        groupingSec: NC_GROUPING_MAX_SEC + 30,
      }),
    )
    const rec = makeLogRecorder()
    const store = makeStore(world, rec.logger)

    await store.load()

    expect(store.get('r-person')?.groupingSec).toBe(NC_GROUPING_MAX_SEC)
    expect(rec.entries.find((e) => e.message === REPAIRED_LINE)?.extras?.meta).toMatchObject({
      ruleId: 'r-person',
      from: NC_GROUPING_MAX_SEC + 30,
      to: NC_GROUPING_MAX_SEC,
    })
  })

  it('names a row it still cannot parse, with the reason', async () => {
    const world = makeNcRecords()
    seed(world, streamOfflineRule('r-broken', { priority: 'urgent' }))
    const rec = makeLogRecorder()
    const store = makeStore(world, rec.logger)

    await store.load()

    expect(store.get('r-broken')).toBeNull()
    const skipped = rec.entries.find((e) => e.message === SKIPPED_LINE)
    expect(skipped?.level).toBe('warn')
    expect(skipped?.extras?.meta).toMatchObject({
      skipped: 1,
      rows: [{ ruleId: 'r-broken', name: 'Eventi di sistema — dispositivi' }],
    })
    const rows = skipped?.extras?.meta?.['rows']
    expect(JSON.stringify(rows)).toContain('priority')
  })
})
