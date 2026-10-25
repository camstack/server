/**
 * A reconcile that finds MANY devices gone at once is not seeing sixteen
 * deletions — it is seeing a broken registry, a wiped hub, or a migration. The
 * same shape as the declared-device withdrawal sweep: above the bound, prune
 * NOTHING and say so.
 */
import { describe, expect, it } from 'vitest'
import { NC_PRUNE_RECONCILE_LIMIT } from '../device-prune-runner.js'
import { rule } from './device-prune-fixtures.js'
import {
  answerTwiceWithout,
  makePruneHarness,
  publishCatalog,
  target,
} from './device-prune-harness.js'

const LIVE = 1

describe('deleted-device prune — the bound', () => {
  it('more than the limit missing at once → nothing written, a WARN', async () => {
    const h = await makePruneHarness()
    const dead = Array.from({ length: NC_PRUNE_RECONCILE_LIMIT + 1 }, (_, i) => 100 + i)
    await h.rules.create(rule('x', { conditions: { devices: [LIVE, ...dead] } }), 'admin')
    for (const id of dead) h.gone.add(id)
    await answerTwiceWithout(h, [LIVE])
    await h.pruner.reconcileDevices()
    expect(h.rules.list()[0]?.conditions.devices).toEqual([LIVE, ...dead])
    expect(h.secondReads).toBe(0)
    const warn = h.lines.find((l) => l.level === 'warn')
    expect(warn?.message).toBe(
      'deleted-device reconcile aborted — too many devices missing at once',
    )
    expect(warn?.meta).toMatchObject({ candidates: NC_PRUNE_RECONCILE_LIMIT + 1 })
  })

  it('exactly the limit is pruned', async () => {
    expect(NC_PRUNE_RECONCILE_LIMIT).toBe(16)
    const h = await makePruneHarness()
    const dead = Array.from({ length: NC_PRUNE_RECONCILE_LIMIT }, (_, i) => 100 + i)
    await h.rules.create(rule('x', { conditions: { devices: [LIVE, ...dead] } }), 'admin')
    for (const id of dead) h.gone.add(id)
    await answerTwiceWithout(h, [LIVE])
    await h.pruner.reconcileDevices()
    expect(h.rules.list()[0]?.conditions.devices).toEqual([LIVE])
  })

  it('an id already kept on a disabled rule costs no second read on every tick', async () => {
    const h = await makePruneHarness()
    await h.rules.create(rule('x', { conditions: { devices: [102] } }), 'admin')
    h.gone.add(102)
    await answerTwiceWithout(h, [LIVE])
    await h.pruner.reconcileDevices()
    const reads = h.secondReads
    await h.directory.refresh()
    await h.pruner.reconcileDevices()
    expect(h.secondReads).toBe(reads)
  })

  it('a persisting TARGET abort warns once, even with device passes in between', async () => {
    const h = await makePruneHarness()
    const dead = Array.from({ length: NC_PRUNE_RECONCILE_LIMIT + 1 }, (_, i) => `t-${i}`)
    await h.rules.create(
      rule('x', { targets: [{ targetId: 'live' }, ...dead.map((targetId) => ({ targetId }))] }),
      'admin',
    )
    publishCatalog(h, [target('live'), ...dead.map((id) => target(id))])
    await h.pruner.reconcileTargets()
    for (let tick = 0; tick < 4; tick += 1) {
      publishCatalog(h, [target('live')])
      await h.pruner.reconcileTargets()
      // A device pass that DOES act (within the bound) between them.
      const deadDevice = 500 + tick
      await h.rules.create(
        rule(`d${tick}`, { conditions: { devices: [LIVE, deadDevice] } }),
        'admin',
      )
      h.gone.add(deadDevice)
      await answerTwiceWithout(h, [LIVE])
      await h.pruner.reconcileDevices()
    }
    const warns = h.lines.filter(
      (l) => l.message === 'deleted-target reconcile aborted — too many targets missing at once',
    )
    expect(warns).toHaveLength(1)
  })
})
