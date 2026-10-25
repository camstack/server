/**
 * A deleted device's battery and consumable alert rows go with it (D633's
 * prune path, D636).
 *
 * `NcDeviceAlerts.forget` existed with no caller and cleared only the RAM
 * battery reading — a leftover describing a design nobody wired. Alert rows of
 * deleted devices were never pruned, and a vacuum deleted with an open
 * `consumable:<id>:wheel` episode would have been restated by the reminder
 * tick for as long as the process remembered its reading.
 *
 * Same bar as every other prune: the second read must agree (D49), and the
 * reconcile looks at alert devices even when no rule names them — a battery
 * device is almost never on a rule.
 */
import { describe, expect, it } from 'vitest'
import { rule } from './device-prune-fixtures.js'
import { answerTwiceWithout, makePruneHarness } from './device-prune-harness.js'

const LIVE = 1

describe('deleted-device prune — device alerts', () => {
  it('the DeviceUnregistered door forgets the alerts of a CONFIRMED deletion', async () => {
    const h = await makePruneHarness()
    h.alerts.held = [4385, 3602]
    h.gone.add(4385)
    await h.pruner.onDeviceDeleted(4385)
    expect(h.alerts.forgotten).toEqual([4385])
    expect(h.alerts.held).toEqual([3602])
    const line = h.lines.find((l) => l.message === 'deleted device alerts forgotten')
    expect(line?.tags).toEqual({ deviceId: 4385 })
  })

  it('forgets nothing when the second read says the device still exists', async () => {
    const h = await makePruneHarness()
    h.alerts.held = [4385]
    await h.pruner.onDeviceDeleted(4385)
    expect(h.alerts.forgotten).toEqual([])
  })

  it('forgets nothing when the second read FAILS', async () => {
    const h = await makePruneHarness()
    h.alerts.held = [4385]
    h.unreadable.add(4385)
    await h.pruner.onDeviceDeleted(4385)
    expect(h.alerts.forgotten).toEqual([])
  })

  it('the reconcile forgets an alert device NO rule names, once absent twice and confirmed', async () => {
    const h = await makePruneHarness()
    await h.rules.create(rule('x', { conditions: { devices: [LIVE] } }), 'admin')
    h.alerts.held = [4385]
    h.gone.add(4385)
    await answerTwiceWithout(h, [LIVE])
    await h.pruner.reconcileDevices()
    expect(h.alerts.forgotten).toEqual([4385])
  })

  it('the reconcile leaves an alert device the directory still lists', async () => {
    const h = await makePruneHarness()
    h.alerts.held = [4385]
    h.gone.add(4385)
    await answerTwiceWithout(h, [LIVE, 4385])
    await h.pruner.reconcileDevices()
    expect(h.alerts.forgotten).toEqual([])
    expect(h.secondReads).toBe(0)
  })

  it('a device on a rule AND with alerts is pruned from both in one pass', async () => {
    const h = await makePruneHarness()
    await h.rules.create(rule('x', { conditions: { devices: [LIVE, 102] } }), 'admin')
    h.alerts.held = [102]
    h.gone.add(102)
    await answerTwiceWithout(h, [LIVE])
    await h.pruner.reconcileDevices()
    expect(h.rules.list()[0]?.conditions.devices).toEqual([LIVE])
    expect(h.alerts.forgotten).toEqual([102])
  })
})
