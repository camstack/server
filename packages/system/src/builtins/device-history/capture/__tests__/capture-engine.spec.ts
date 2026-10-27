import { DeviceType, HISTORY_CATALOG, HISTORY_ITEM_CATALOG } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Harness, makeHarness } from '../../__tests__/support/harness.js'
import { emitState, rawOf, seriesOf } from '../../__tests__/support/read-helpers.js'
import type { HistoryCatalog } from '../capture-engine.js'

let h: Harness
afterEach(async () => {
  await h.close()
})

const BATTERY = 'cap:battery.level'

describe('capture is driven by the generated catalog', () => {
  it('records only catalogued fields of catalogued caps', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'battery', { level: 80, cycles: 3, charging: false })
    emitState(h, 1, 'a-cap-with-no-history-block', { value: 5 })
    await h.settle()
    const keys = h.runtime.registry
      .all()
      .map((s) => s.key)
      .sort()
    expect(keys).toEqual([BATTERY])
    expect(await rawOf(h, BATTERY, 1)).toEqual([{ ts: h.now(), value: 80 }])
  })

  it('declares a metric for every catalog field and keyed-item field at boot', async () => {
    h = await makeHarness()
    const catalogFields =
      Object.values(HISTORY_CATALOG).reduce((n, f) => n + Object.keys(f).length, 0) +
      Object.values(HISTORY_ITEM_CATALOG).reduce((n, i) => n + Object.keys(i.fields).length, 0)
    expect(h.runtime.registry.allMetrics().filter((m) => m.source === 'cap')).toHaveLength(
      catalogFields,
    )
  })

  it('never records null or absent as zero', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'battery', { level: null })
    emitState(h, 1, 'battery', {})
    await h.settle()
    expect(await rawOf(h, BATTERY, 1)).toEqual([])
  })

  it('stores a boolean field as 1 and 0', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'contact', { entryOpen: true })
    h.advance(1_000)
    emitState(h, 1, 'contact', { entryOpen: false })
    await h.settle()
    expect((await rawOf(h, 'cap:contact.entryOpen', 1)).map((p) => p.value)).toEqual([1, 0])
  })
})

describe('real devices only', () => {
  it('does not record a hub or a container, and counts why', async () => {
    h = await makeHarness({
      devices: { 1: DeviceType.Hub, 2: DeviceType.Container, 3: DeviceType.Sensor },
    })
    for (const id of [1, 2, 3]) emitState(h, id, 'battery', { level: 50 })
    await h.settle()
    expect(seriesOf(h, BATTERY, 1)).toBeUndefined()
    expect(seriesOf(h, BATTERY, 2)).toBeUndefined()
    expect(seriesOf(h, BATTERY, 3)).toBeDefined()
    expect(h.runtime.status().capture.skipped['not-a-real-device']).toBe(2)
  })

  it('does not record a motion field for a camera but does for a sensor', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Camera, 2: DeviceType.Sensor } })
    emitState(h, 1, 'motion', { detected: true })
    emitState(h, 2, 'motion', { detected: true })
    await h.settle()
    expect(seriesOf(h, 'cap:motion.detected', 1)).toBeUndefined()
    expect(seriesOf(h, 'cap:motion.detected', 2)).toBeDefined()
    expect(h.runtime.status().capture.skipped['excluded-device-type']).toBe(1)
  })

  it('parks an event for a device the directory does not know yet, then records it', async () => {
    h = await makeHarness()
    // The hub knows the device; the directory (listed at boot) does not yet.
    h.devices.set(9, DeviceType.Sensor)
    emitState(h, 9, 'battery', { level: 44 })
    expect(h.runtime.status().capture.pointsEmitted).toBe(0)
    await vi.waitFor(() => expect(h.runtime.status().capture.pointsEmitted).toBe(1))
    await h.settle()
    expect(await rawOf(h, BATTERY, 9)).toHaveLength(1)
  })

  it('drops the parked event, and says so, when the device never appears', async () => {
    h = await makeHarness()
    emitState(h, 77, 'battery', { level: 44 })
    await vi.waitFor(() => expect(h.runtime.status().capture.skipped['unknown-device']).toBe(1))
    expect(h.runtime.status().capture.pointsEmitted).toBe(0)
  })
})

describe('change-only', () => {
  it('writes one point for a repeated value and a second for a change', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'battery', { level: 80 })
    h.advance(60_000)
    emitState(h, 1, 'battery', { level: 80 })
    h.advance(60_000)
    emitState(h, 1, 'battery', { level: 79 })
    await h.settle()
    expect((await rawOf(h, BATTERY, 1)).map((p) => p.value)).toEqual([80, 79])
    expect(h.runtime.status().capture.skipped['unchanged']).toBe(1)
  })

  it('remembers the last recorded value across a restart, so a restart repeats nothing', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'battery', { level: 80 })
    await h.settle()
    await h.restart()
    h.advance(60_000)
    emitState(h, 1, 'battery', { level: 80 })
    await h.settle()
    expect(await rawOf(h, BATTERY, 1)).toHaveLength(1)
    emitState(h, 1, 'battery', { level: 79 })
    await h.settle()
    expect(await rawOf(h, BATTERY, 1)).toHaveLength(2)
  })
})

describe('deadband and the capture floor', () => {
  const catalog: HistoryCatalog = {
    thermo: {
      temp: { kind: 'gauge', unit: '°C', deadband: 0.5, minIntervalMs: 0 },
      lux: { kind: 'gauge', unit: 'lx', deadbandPct: 10, minIntervalMs: 0 },
      level: { kind: 'gauge', unit: '%' },
    },
  }

  it('drops a change below the absolute deadband but keeps a drift that adds up', async () => {
    h = await makeHarness({ catalog, devices: { 1: DeviceType.Sensor } })
    for (const temp of [20, 20.3, 20.4, 20.6]) {
      emitState(h, 1, 'thermo', { temp })
      h.advance(1_000)
    }
    await h.settle()
    expect((await rawOf(h, 'cap:thermo.temp', 1)).map((p) => p.value)).toEqual([20, 20.6])
    expect(h.runtime.status().capture.skipped['deadband']).toBe(2)
  })

  it('applies a relative deadband to the last recorded value', async () => {
    h = await makeHarness({ catalog, devices: { 1: DeviceType.Sensor } })
    for (const lux of [1000, 1050, 1101]) {
      emitState(h, 1, 'thermo', { lux })
      h.advance(1_000)
    }
    await h.settle()
    expect((await rawOf(h, 'cap:thermo.lux', 1)).map((p) => p.value)).toEqual([1000, 1101])
  })

  it('holds a change inside the floor pending, then emits it where the floor ends', async () => {
    h = await makeHarness({ catalog, devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'thermo', { level: 10 })
    h.advance(3_000)
    emitState(h, 1, 'thermo', { level: 20 })
    h.advance(2_000)
    emitState(h, 1, 'thermo', { level: 30 })
    await h.settle()
    expect((await rawOf(h, 'cap:thermo.level', 1)).map((p) => p.value)).toEqual([10])
    expect(h.runtime.capture.pendingCount()).toBe(1)
    h.advance(10_000)
    await h.settle()
    const points = await rawOf(h, 'cap:thermo.level', 1)
    expect(points.map((p) => p.value)).toEqual([10, 30])
    expect(points[1]?.ts).toBe((points[0]?.ts ?? 0) + 10_000)
    expect(h.runtime.status().capture.trailingEmitted).toBe(1)
  })

  it('forgets a pending change when the value comes back to the recorded one', async () => {
    h = await makeHarness({ catalog, devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'thermo', { level: 10 })
    h.advance(1_000)
    emitState(h, 1, 'thermo', { level: 20 })
    h.advance(1_000)
    emitState(h, 1, 'thermo', { level: 10 })
    expect(h.runtime.capture.pendingCount()).toBe(0)
    h.advance(20_000)
    await h.settle()
    expect(await rawOf(h, 'cap:thermo.level', 1)).toHaveLength(1)
  })
})

describe('per-device opt-out', () => {
  it('stops capture and counts it, and resumes when re-enabled', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'battery', { level: 80 })
    await h.settle()
    await h.runtime.setEnabled(1, false)
    expect(h.runtime.isEnabled(1)).toBe(false)
    h.advance(60_000)
    emitState(h, 1, 'battery', { level: 70 })
    await h.settle()
    expect((await rawOf(h, BATTERY, 1)).map((p) => p.value)).toEqual([80])
    expect(h.runtime.status().capture.skipped['opted-out']).toBe(1)
    expect(h.runtime.status().optedOutDevices).toBe(1)
    await h.runtime.setEnabled(1, true)
    h.advance(60_000)
    emitState(h, 1, 'battery', { level: 60 })
    await h.settle()
    expect((await rawOf(h, BATTERY, 1)).map((p) => p.value)).toEqual([80, 60])
  })

  it('survives a restart: the switch is stored, and clearing it is stored too', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor, 2: DeviceType.Sensor } })
    await h.runtime.setEnabled(1, false)
    await h.runtime.setEnabled(2, false)
    await h.restart()
    expect(h.runtime.isEnabled(1)).toBe(false)
    expect(h.runtime.isEnabled(2)).toBe(false)
    await h.runtime.setEnabled(1, true)
    await h.restart()
    expect(h.runtime.isEnabled(1)).toBe(true)
    expect(h.runtime.isEnabled(2)).toBe(false)
  })

  it('keeps the history of an opted-out device', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'battery', { level: 80 })
    await h.settle()
    await h.runtime.setEnabled(1, false)
    await h.settle()
    expect(await rawOf(h, BATTERY, 1)).toHaveLength(1)
  })
})
