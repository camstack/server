import { DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { type Harness, makeHarness } from '../../__tests__/support/harness.js'
import { emitState, rawOf } from '../../__tests__/support/read-helpers.js'

let h: Harness
afterEach(async () => {
  await h.close()
})

const BATTERY = 'cap:battery.level'
const FIVE_MIN = 300_000

describe('reconcile', () => {
  it('fills a change whose event was dropped, stamped at the reconcile time', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'battery', { level: 80 })
    await h.settle()
    // The event announcing 70 never arrives; the mirror knows it.
    h.advance(FIVE_MIN)
    h.setSnapshots({ '1': { battery: { level: 70 } } })
    await h.runtime.reconcile()
    await h.settle()
    const points = await rawOf(h, BATTERY, 1)
    expect(points.map((p) => p.value)).toEqual([80, 70])
    expect(points[1]?.ts).toBe(h.now())
    expect(h.runtime.status().capture.reconciledPoints).toBe(1)
  })

  it('records the baseline of a series it has never seen', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    h.setSnapshots({ '1': { battery: { level: 55 } } })
    await h.runtime.reconcile()
    await h.settle()
    expect((await rawOf(h, BATTERY, 1)).map((p) => p.value)).toEqual([55])
  })

  it('adds nothing when the mirror agrees with what is recorded', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'battery', { level: 80 })
    await h.settle()
    h.advance(FIVE_MIN)
    h.setSnapshots({ '1': { battery: { level: 80 } } })
    await h.runtime.reconcile()
    await h.settle()
    expect(await rawOf(h, BATTERY, 1)).toHaveLength(1)
    expect(h.runtime.status().capture.reconciledPoints).toBe(0)
  })

  it('a FAILED read changes nothing: no point, no run counted, and it says so (D49)', async () => {
    h = await makeHarness({
      devices: { 1: DeviceType.Sensor },
      snapshots: new Error('hub unreachable'),
    })
    const status = h.runtime.status()
    expect(status.capture.reconcileFailures).toBe(1)
    expect(status.capture.reconcileRuns).toBe(0)
    expect(status.capture.lastReconcileAt).toBeNull()
    expect(status.ready).toBe(false)
    expect(status.capture.pointsEmitted).toBe(0)
    expect(
      h.logs.some((l) => l.level === 'warn' && l.message.includes('reconcile read failed')),
    ).toBe(true)
    // The next pass, with the hub back, works.
    h.setSnapshots({ '1': { battery: { level: 12 } } })
    await h.runtime.reconcile()
    await h.settle()
    expect((await rawOf(h, BATTERY, 1)).map((p) => p.value)).toEqual([12])
    expect(h.runtime.status().ready).toBe(true)
  })

  it('skips a hub, an opted-out device and a camera motion field', async () => {
    h = await makeHarness({
      devices: { 1: DeviceType.Hub, 2: DeviceType.Sensor, 3: DeviceType.Camera },
    })
    await h.runtime.setEnabled(2, false)
    h.setSnapshots({
      '1': { battery: { level: 1 } },
      '2': { battery: { level: 2 } },
      '3': { motion: { detected: true } },
    })
    await h.runtime.reconcile()
    await h.settle()
    expect(h.runtime.registry.all()).toHaveLength(0)
  })
})
