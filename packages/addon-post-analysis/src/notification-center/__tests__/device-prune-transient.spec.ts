/**
 * A device that is only GONE FOR A MOMENT must never be pruned.
 *
 * Every case here is a way the system can look like a device was deleted when
 * it was not: a respawn, a migration swap, a hub restart, a failed read. The
 * prune is destructive (a rule loses a camera, or is switched off), so D49
 * applies in full — a read that fails changes nothing, and the reading that
 * would DESTROY work needs a second read to agree.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { rule } from './device-prune-fixtures.js'
import { answerTwiceWithout, makePruneHarness, type PruneHarness } from './device-prune-harness.js'

const DEAD = 102
const LIVE = 101

describe('deleted-device prune — the event path', () => {
  let h: PruneHarness

  beforeEach(async () => {
    h = await makePruneHarness()
    await h.rules.create(rule('x', { conditions: { devices: [LIVE, DEAD] } }), 'admin')
  })

  const devicesOf = (): readonly number[] | undefined => h.rules.list()[0]?.conditions.devices

  it('prunes when the second read agrees the device row is gone', async () => {
    h.gone.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    expect(devicesOf()).toEqual([LIVE])
    const line = h.lines.find((l) => l.message === 'deleted device pruned from notification rule')
    expect(line?.tags).toEqual({ deviceId: DEAD })
    expect(line?.meta).toMatchObject({ kind: 'rule', field: 'conditions.devices', source: 'event' })
  })

  it('DeviceUnregistered while getDevice still returns the device → no write', async () => {
    await h.pruner.onDeviceDeleted(DEAD)
    expect(devicesOf()).toEqual([LIVE, DEAD])
    expect(h.ledger.list()).toEqual([])
  })

  it('getDevice throws → no write', async () => {
    h.gone.add(DEAD)
    h.unreadable.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    expect(devicesOf()).toEqual([LIVE, DEAD])
  })

  it('a prune ledger that never loaded (its guard cannot answer) → no write', async () => {
    const fresh = await makePruneHarness({ ledgerLoadFails: true })
    await fresh.rules.create(rule('x', { conditions: { devices: [LIVE, DEAD] } }), 'admin')
    fresh.gone.add(DEAD)
    await fresh.pruner.onDeviceDeleted(DEAD)
    expect(fresh.rules.list()[0]?.conditions.devices).toEqual([LIVE, DEAD])
  })
})

describe('deleted-device prune — the reconcile tick', () => {
  let h: PruneHarness

  beforeEach(async () => {
    h = await makePruneHarness()
    await h.rules.create(rule('x', { conditions: { devices: [LIVE, DEAD] } }), 'admin')
    h.gone.add(DEAD)
  })

  const devicesOf = (): readonly number[] | undefined => h.rules.list()[0]?.conditions.devices

  it('prunes an id missing from two answered refreshes, once getDevice agrees', async () => {
    await answerTwiceWithout(h, [LIVE])
    await h.pruner.reconcileDevices()
    expect(devicesOf()).toEqual([LIVE])
  })

  it('missing in only ONE refresh, back in the next → no prune', async () => {
    h.devices = [LIVE]
    await h.directory.refresh()
    h.devices = [LIVE, DEAD]
    await h.directory.refresh()
    await h.pruner.reconcileDevices()
    expect(devicesOf()).toEqual([LIVE, DEAD])
  })

  it('a single answered refresh is not two — no prune', async () => {
    h.devices = [LIVE]
    await h.directory.refresh()
    await h.pruner.reconcileDevices()
    expect(devicesOf()).toEqual([LIVE, DEAD])
  })

  it('a failed or EMPTY refresh is not an answer — no prune', async () => {
    h.devices = [LIVE]
    await h.directory.refresh()
    h.devices = new Error('device-manager unreachable')
    await h.directory.refresh()
    await h.pruner.reconcileDevices()
    h.devices = []
    await h.directory.refresh()
    await h.pruner.reconcileDevices()
    expect(devicesOf()).toEqual([LIVE, DEAD])
  })

  it('absent twice but getDevice still answers the row → no prune (migration swap)', async () => {
    h.gone.delete(DEAD)
    await answerTwiceWithout(h, [LIVE])
    await h.pruner.reconcileDevices()
    expect(devicesOf()).toEqual([LIVE, DEAD])
  })

  it('absent twice but getDevice throws → no prune', async () => {
    h.unreadable.add(DEAD)
    await answerTwiceWithout(h, [LIVE])
    await h.pruner.reconcileDevices()
    expect(devicesOf()).toEqual([LIVE, DEAD])
  })

  it('a ledger that never loaded prunes nothing (its guard cannot answer)', async () => {
    const fresh = await makePruneHarness({ ledgerLoadFails: true })
    await fresh.rules.create(rule('x', { conditions: { devices: [LIVE, DEAD] } }), 'admin')
    fresh.gone.add(DEAD)
    await answerTwiceWithout(fresh, [LIVE])
    await fresh.pruner.reconcileDevices()
    expect(fresh.rules.list()[0]?.conditions.devices).toEqual([LIVE, DEAD])
  })
})
