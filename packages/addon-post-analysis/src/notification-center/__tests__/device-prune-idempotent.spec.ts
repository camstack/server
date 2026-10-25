/**
 * The prune runs on every reload tick, so it must be a no-op on its own
 * output, and it must never fight the operator.
 */
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcPruneLedger } from '../device-prune-ledger.js'
import { rule, timelapse } from './device-prune-fixtures.js'
import { answerTwiceWithout, makePruneHarness } from './device-prune-harness.js'

const DEAD = 102
const LIVE = 101

describe('deleted-device prune — idempotent, and never against the operator', () => {
  it('a second run writes nothing', async () => {
    const h = await makePruneHarness()
    await h.rules.create(rule('x', { conditions: { devices: [LIVE, DEAD] } }), 'admin')
    await h.rules.create(rule('y', { conditions: { devices: [DEAD] } }), 'admin')
    h.gone.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    const writes = h.writes()
    await h.pruner.onDeviceDeleted(DEAD)
    await answerTwiceWithout(h, [LIVE])
    await h.pruner.reconcileDevices()
    expect(h.writes()).toBe(writes)
  })

  it('the last device is kept, the rule disabled ONCE, and a re-enable is never overridden', async () => {
    const h = await makePruneHarness()
    const created = await h.rules.create(rule('y', { conditions: { devices: [DEAD] } }), 'admin')
    h.gone.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    const disabled = h.rules.get(created.id)
    expect(disabled?.enabled).toBe(false)
    expect(disabled?.conditions.devices).toEqual([DEAD])
    expect(h.ledger.listFor('rule', created.id)).toEqual([
      expect.objectContaining({ outcome: 'kept-disabled', subject: '102', at: 5_000 }),
    ])
    const warn = h.lines.find((l) => l.level === 'warn')
    expect(warn?.message).toBe('notification rule disabled — its last device was deleted')
    expect(warn?.tags).toEqual({ deviceId: DEAD })

    // The operator switches it back on (their explicit choice).
    await h.rules.setEnabled(created.id, true)
    await h.pruner.onDeviceDeleted(DEAD)
    await answerTwiceWithout(h, [LIVE])
    await h.pruner.reconcileDevices()
    expect(h.rules.get(created.id)?.enabled).toBe(true)
  })

  it('the disable-once guard survives a restart (it is durable)', async () => {
    const h = await makePruneHarness()
    const created = await h.rules.create(rule('y', { conditions: { devices: [DEAD] } }), 'admin')
    h.gone.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    await h.rules.setEnabled(created.id, true)
    // A fresh ledger over the same store — a restarted process.
    const restarted = new NcPruneLedger({
      records: h.world.records,
      logger: makeSilentLogger(),
    })
    await restarted.load()
    expect(
      restarted.hasKept({
        kind: 'rule',
        ruleId: created.id,
        subjectKind: 'device',
        subject: '102',
      }),
    ).toBe(true)
  })

  it('a dead id re-added by a stale full save is pruned again on the next tick', async () => {
    const h = await makePruneHarness()
    const created = await h.rules.create(
      rule('x', { conditions: { devices: [LIVE, DEAD] } }),
      'admin',
    )
    h.gone.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    expect(h.rules.get(created.id)?.conditions.devices).toEqual([LIVE])
    // An editor that loaded the rule before the prune saves its whole object.
    await h.rules.update(created.id, { conditions: { devices: [LIVE, DEAD] } })
    await answerTwiceWithout(h, [LIVE])
    await h.pruner.reconcileDevices()
    expect(h.rules.get(created.id)?.conditions.devices).toEqual([LIVE])
  })

  it('a timelapse loses the device AND its generatedByDevice stamp', async () => {
    const h = await makePruneHarness()
    const created = await h.timelapse.create(timelapse('t', { deviceIds: [LIVE, DEAD] }), 'admin')
    await h.timelapse.markGenerated(created.id, DEAD, 42)
    await h.timelapse.markGenerated(created.id, LIVE, 43)
    h.gone.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    const after = h.timelapse.get(created.id)
    expect(after?.deviceIds).toEqual([LIVE])
    expect(after?.generatedByDevice).toEqual({ '101': 43 })
  })

  it('a rule write that FAILS records nothing, so the next tick retries it', async () => {
    const h = await makePruneHarness()
    await h.rules.create(rule('y', { conditions: { devices: [LIVE, DEAD] } }), 'admin')
    h.gone.add(DEAD)
    h.onRuleWrite = () => {
      throw new Error('disk full')
    }
    await h.pruner.onDeviceDeleted(DEAD)
    expect(h.ledger.list()).toEqual([])
    h.onRuleWrite = null
    await h.pruner.onDeviceDeleted(DEAD)
    expect(h.rules.list()[0]?.conditions.devices).toEqual([LIVE])
  })
})
