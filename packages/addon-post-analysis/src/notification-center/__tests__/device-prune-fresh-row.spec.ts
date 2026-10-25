/**
 * The prune writes from the DURABLE row, never from this node's mirror.
 *
 * CRUD is served on whichever node is asked; the evaluating node sees such an
 * edit only on its next reload tick. A prune planned from the mirror and
 * written as a whole row would silently revert an edit the operator saved a
 * moment earlier on another node ("remove camera X, add Y, save, delete X").
 * So every affected row is re-read from the store immediately before its
 * write, and the edit is re-planned from that fresh copy.
 */
import { NcAlarmSettingsSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcRuleStore } from '../rule-store.js'
import { ncTable } from './support/nc-test-deps.js'
import { NcSummaryStore } from '../summary/summary-store.js'
import { TimelapseStore } from '../timelapse/timelapse-store.js'
import { rule, summary, timelapse } from './device-prune-fixtures.js'
import { answerTwiceWithout, FakeAlarm, makePruneHarness } from './device-prune-harness.js'

const DEAD = 102
const LIVE = 101
const ADDED = 700

describe('deleted-device prune — writes from the durable row', () => {
  it('rule: an edit saved on another node after this mirror loaded survives the event prune', async () => {
    const h = await makePruneHarness()
    const created = await h.rules.create(
      rule('x', { conditions: { devices: [LIVE, DEAD] } }),
      'admin',
    )
    const other = NcRuleStore.of(h.world.records, makeSilentLogger())
    await other.load()
    await other.update(created.id, {
      name: 'renamed',
      conditions: { devices: [LIVE, DEAD, ADDED] },
    })
    h.gone.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    await other.load()
    expect(other.get(created.id)?.name).toBe('renamed')
    expect(other.get(created.id)?.conditions.devices).toEqual([LIVE, ADDED])
  })

  it('rule: the same on the reconcile tick', async () => {
    const h = await makePruneHarness()
    const created = await h.rules.create(
      rule('x', { conditions: { devices: [LIVE, DEAD] } }),
      'admin',
    )
    const other = NcRuleStore.of(h.world.records, makeSilentLogger())
    await other.load()
    await other.update(created.id, {
      name: 'renamed',
      conditions: { devices: [LIVE, DEAD, ADDED] },
    })
    h.gone.add(DEAD)
    await answerTwiceWithout(h, [LIVE, ADDED])
    await h.pruner.reconcileDevices()
    await other.load()
    expect(other.get(created.id)?.name).toBe('renamed')
    expect(other.get(created.id)?.conditions.devices).toEqual([LIVE, ADDED])
  })

  it('rule: one DELETED on another node is not resurrected by the prune', async () => {
    const h = await makePruneHarness()
    const created = await h.rules.create(
      rule('x', { conditions: { devices: [LIVE, DEAD] } }),
      'admin',
    )
    const other = NcRuleStore.of(h.world.records, makeSilentLogger())
    await other.load()
    await other.delete(created.id)
    h.gone.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    expect(ncTable(h.world, 'rules').has(created.id)).toBe(false)
    expect(h.ledger.list()).toEqual([])
  })

  it('rule: the operator already removed the dead id elsewhere → no write, no record', async () => {
    const h = await makePruneHarness()
    const created = await h.rules.create(
      rule('x', { conditions: { devices: [LIVE, DEAD] } }),
      'admin',
    )
    const other = NcRuleStore.of(h.world.records, makeSilentLogger())
    await other.load()
    await other.update(created.id, { conditions: { devices: [LIVE] } })
    h.gone.add(DEAD)
    const writes = h.writes()
    await h.pruner.onDeviceDeleted(DEAD)
    expect(h.writes()).toBe(writes)
    expect(h.ledger.list()).toEqual([])
  })

  it('timelapse: a fresh edit survives', async () => {
    const h = await makePruneHarness()
    const created = await h.timelapse.create(timelapse('t', { deviceIds: [LIVE, DEAD] }), 'admin')
    const other = TimelapseStore.of(h.world.records, makeSilentLogger())
    await other.load()
    await other.update(created.id, { name: 'renamed', deviceIds: [LIVE, DEAD, ADDED] })
    h.gone.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    await other.load()
    expect(other.get(created.id)?.name).toBe('renamed')
    expect(other.get(created.id)?.deviceIds).toEqual([LIVE, ADDED])
  })

  it('summary: a fresh edit survives', async () => {
    const h = await makePruneHarness()
    const created = await h.summary.create(summary('s', { deviceIds: [LIVE, DEAD] }), 'admin')
    const other = NcSummaryStore.of(h.world.records, makeSilentLogger())
    await other.load()
    await other.update(created.id, { name: 'renamed', deviceIds: [LIVE, DEAD, ADDED] })
    h.gone.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    await other.load()
    expect(other.get(created.id)?.name).toBe('renamed')
    expect(other.get(created.id)?.deviceIds).toEqual([LIVE, ADDED])
  })

  it('alarm: lists changed while the prune ran are re-read before its write', async () => {
    const h = await makePruneHarness()
    const alarm = new FakeAlarm(
      NcAlarmSettingsSchema.parse({
        exitDelaySec: 0,
        entryDelaySec: 0,
        triggeredDurationSec: 0,
        blocking: [],
        secureOnArmOff: [],
        announceTargets: [],
        nonBlocking: [{ mode: 'away', deviceIds: [LIVE, DEAD] }],
      }),
    )
    h.alarm = alarm
    // A rule write happens first; the operator edits the panel meanwhile.
    await h.rules.create(rule('x', { conditions: { devices: [LIVE, DEAD] } }), 'admin')
    h.onRuleWrite = () => {
      alarm.current = {
        ...alarm.current,
        nonBlocking: [
          { mode: 'away', deviceIds: [LIVE, DEAD, ADDED] },
          { mode: 'night', deviceIds: [ADDED] },
        ],
      }
    }
    h.gone.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    expect(alarm.current.nonBlocking).toEqual([
      { mode: 'away', deviceIds: [LIVE, ADDED] },
      { mode: 'night', deviceIds: [ADDED] },
    ])
  })

  it('a stored row that no longer validates is skipped ONCE — no second read per tick', async () => {
    const h = await makePruneHarness()
    const created = await h.rules.create(
      rule('x', { conditions: { devices: [LIVE, DEAD] } }),
      'admin',
    )
    // The durable row goes bad; this node's mirror still holds the good copy.
    h.world.seed('rules', { id: created.id, data: { junk: 1 } })
    h.gone.add(DEAD)
    await answerTwiceWithout(h, [LIVE])
    await h.pruner.reconcileDevices()
    const reads = h.secondReads
    for (let tick = 0; tick < 3; tick += 1) {
      await h.directory.refresh()
      await h.pruner.reconcileDevices()
    }
    expect(h.secondReads).toBe(reads)
    const warns = h.lines.filter(
      (l) => l.message === 'prune skipped — the stored rule does not validate',
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]?.tags).toEqual({ deviceId: DEAD })
    // The row changes (a new write) → it is planned again.
    await new Promise((resolve) => setTimeout(resolve, 2))
    await h.rules.update(created.id, { name: 'fixed' })
    await h.directory.refresh()
    await h.pruner.reconcileDevices()
    expect(h.rules.get(created.id)?.conditions.devices).toEqual([LIVE])
  })
})
