/**
 * A deleted delivery TARGET (`nc.deleteMyTarget` emits nothing) is found by the
 * reload-tick reconcile against the target catalog the DELIVERY path already
 * cached (`NcDispatcher.catalogSnapshot`) — the prune never reads a catalog of
 * its own (fix round 1: no cluster fan-out every 30 s).
 *
 * Two answers must agree, and an answer is a cache GENERATION: re-reading the
 * same cached catalog on ten ticks is one answer, not ten. The catalog is a
 * concat fan-out across providers, so it can be PARTIAL: a target is pruned
 * only when its own provider answered in both.
 */
import { describe, expect, it } from 'vitest'
import { rule, summary } from './device-prune-fixtures.js'
import { makePruneHarness, publishCatalog, target } from './device-prune-harness.js'

describe('deleted-target prune', () => {
  it('two cache generations without the target → pruned; the last target keeps + disables', async () => {
    const h = await makePruneHarness()
    const shrink = await h.rules.create(
      rule('a', { targets: [{ targetId: 't-1' }, { targetId: 't-dead' }] }),
      'admin',
    )
    const last = await h.rules.create(rule('b', { targets: [{ targetId: 't-dead' }] }), 'admin')
    publishCatalog(h, [target('t-1'), target('t-dead')])
    await h.pruner.reconcileTargets()
    publishCatalog(h, [target('t-1')])
    await h.pruner.reconcileTargets()
    // One answer without it is not two.
    expect(h.rules.get(shrink.id)?.targets).toHaveLength(2)
    publishCatalog(h, [target('t-1')])
    await h.pruner.reconcileTargets()
    expect(h.rules.get(shrink.id)?.targets).toEqual([{ targetId: 't-1' }])
    expect(h.rules.get(last.id)?.targets).toEqual([{ targetId: 't-dead' }])
    expect(h.rules.get(last.id)?.enabled).toBe(false)
    expect(h.ledger.listFor('rule', last.id)[0]).toMatchObject({
      subjectKind: 'target',
      outcome: 'kept-disabled',
    })
  })

  it('the SAME cached generation read on many ticks is one answer', async () => {
    const h = await makePruneHarness()
    const created = await h.rules.create(
      rule('a', { targets: [{ targetId: 't-1' }, { targetId: 't-dead' }] }),
      'admin',
    )
    publishCatalog(h, [target('t-1'), target('t-dead')])
    await h.pruner.reconcileTargets()
    publishCatalog(h, [target('t-1')])
    for (let tick = 0; tick < 10; tick += 1) await h.pruner.reconcileTargets()
    expect(h.rules.get(created.id)?.targets).toHaveLength(2)
  })

  it('no fresh cached catalog (stale, or never read) → nothing, and nothing read', async () => {
    const h = await makePruneHarness()
    const created = await h.rules.create(
      rule('a', { targets: [{ targetId: 't-1' }, { targetId: 't-dead' }] }),
      'admin',
    )
    publishCatalog(h, [target('t-1'), target('t-dead')])
    await h.pruner.reconcileTargets()
    h.catalog = null
    for (let tick = 0; tick < 5; tick += 1) await h.pruner.reconcileTargets()
    expect(h.rules.get(created.id)?.targets).toHaveLength(2)
  })

  it('a target whose PROVIDER went quiet is not pruned (partial catalog)', async () => {
    const h = await makePruneHarness()
    const created = await h.summary.create(
      summary('s', { targets: [{ targetId: 't-1' }, { targetId: 'ha-1' }] }),
      'admin',
    )
    publishCatalog(h, [target('t-1'), target('ha-1', 'homeassistant')])
    await h.pruner.reconcileTargets()
    // Home Assistant restarting: its whole slice of the catalog is missing.
    publishCatalog(h, [target('t-1')])
    await h.pruner.reconcileTargets()
    publishCatalog(h, [target('t-1')])
    await h.pruner.reconcileTargets()
    expect(h.summary.get(created.id)?.targets).toHaveLength(2)
  })

  it('a missing target that can never be pruned is SAID, once', async () => {
    const h = await makePruneHarness()
    await h.rules.create(
      rule('a', { targets: [{ targetId: 't-1' }, { targetId: 'gone-before-boot' }] }),
      'admin',
    )
    for (let tick = 0; tick < 3; tick += 1) {
      publishCatalog(h, [target('t-1')])
      await h.pruner.reconcileTargets()
    }
    const said = h.lines.filter(
      (l) => l.message === 'referenced target is missing but cannot be pruned',
    )
    expect(said).toHaveLength(1)
    expect(said[0]?.meta).toMatchObject({
      targetId: 'gone-before-boot',
      reason: 'provider-never-seen',
    })
  })
})
