/**
 * D906 through the real store and engine: an INSTANT system rule stored with
 * one edge of a paired class is read as the class, so the recovery now
 * matches; a SCHEDULED summary rule is never widened — it reports the bad
 * state at its time, not edges and never recoveries.
 */
import type { InMemoryRecords, NcSystemEventKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { ncRecordKinds } from '../record-kinds.js'
import { evaluateRule, NC_SYSTEM_DEVICE_ID, type NcRuleSubject } from '../rule-engine.js'
import { NcRuleStore } from '../rule-store.js'
import { sectionsOfRule } from '../state-summary/state-model.js'
import { makeNcRecords } from './support/nc-test-deps.js'

const WIDENED_LINE = 'instant system rule read as its whole event class — both edges'

function seed(world: InMemoryRecords, id: string, overrides: Record<string, unknown>): void {
  world.seed('rules', {
    id,
    data: {
      name: `rule ${id}`,
      enabled: true,
      delivery: 'system-event',
      targets: [{ targetId: 'tgt-1' }],
      createdBy: 'admin',
      createdAt: 1,
      updatedAt: 1,
      disabledTargetIds: [],
      ...overrides,
    },
  })
}

function streamSubject(kind: NcSystemEventKind): NcRuleSubject {
  return {
    kind: 'system-event',
    recordId: `event-${kind}`,
    deviceId: NC_SYSTEM_DEVICE_ID,
    timestamp: 1_000,
    classNames: [],
    zones: [],
    systemEvent: { kind, subject: 'stream:108', data: {}, deviceId: 108, deviceType: 'camera' },
  }
}

async function load(world: InMemoryRecords): Promise<{
  store: NcRuleStore
  rec: ReturnType<typeof makeLogRecorder>
}> {
  const rec = makeLogRecorder()
  const store = new NcRuleStore({
    kind: world.records.kind(ncRecordKinds.rules),
    logger: rec.logger,
  })
  await store.load()
  return { store, rec }
}

describe('D906 — paired events as one class, through the store', () => {
  it('an immediate rule stored with only stream-offline now matches stream-online', async () => {
    const world = makeNcRecords()
    seed(world, 'r-1', { conditions: { systemEvent: { kinds: ['stream-offline'] } } })
    const { store, rec } = await load(world)

    const rule = store.get('r-1')
    expect(rule?.conditions.systemEvent?.kinds).toEqual(['stream-offline', 'stream-online'])
    expect(rule && evaluateRule(rule, streamSubject('stream-online')).matched).toBe(true)
    expect(rule && evaluateRule(rule, streamSubject('stream-offline')).matched).toBe(true)
    const said = rec.entries.filter((e) => e.message === WIDENED_LINE)
    expect(said).toHaveLength(1)
    expect(said[0]?.extras?.meta).toMatchObject({ ruleId: 'r-1', added: ['stream-online'] })

    await store.load()
    expect(rec.entries.filter((e) => e.message === WIDENED_LINE)).toHaveLength(1)
  })

  it('a save writes the class', async () => {
    const world = makeNcRecords()
    seed(world, 'r-1', { conditions: { systemEvent: { kinds: ['recording-stalled'] } } })
    const { store } = await load(world)
    await store.update('r-1', { name: 'renamed' })
    const reread = await load(world)
    expect(reread.store.get('r-1')?.conditions.systemEvent?.kinds).toEqual([
      'recording-stalled',
      'recording-healthy',
    ])
    expect(reread.rec.entries.filter((e) => e.message === WIDENED_LINE)).toEqual([])
  })

  it('a summary rule is never widened, so it never includes a recovery', async () => {
    const world = makeNcRecords()
    seed(world, 'r-evening', {
      conditions: { systemEvent: { kinds: ['device-offline', 'device-battery-low'] } },
      systemEventDelivery: {
        mode: 'summary',
        schedule: {
          windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1200, endMinute: 1260 }],
        },
      },
    })
    const { store, rec } = await load(world)
    const rule = store.get('r-evening')
    expect(rule).not.toBeNull()
    expect(rule?.conditions.systemEvent?.kinds).toEqual(['device-offline', 'device-battery-low'])
    expect(rec.entries.filter((e) => e.message === WIDENED_LINE)).toEqual([])
    // What it reports is the STATE of these groups at its time (D647).
    expect(rule?.conditions.systemEvent && sectionsOfRule(rule.conditions.systemEvent)).toEqual([
      'device-state',
      'battery',
    ])
  })
})
