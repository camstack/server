/**
 * The mirror must not re-read a thousand rows because one device changed.
 *
 * The census this pins, live hub 2026-08-27, 120-second boot window:
 *
 *     DeviceRowStore.list < DeviceRowStore.listFleet < listAll
 *     calls 4 904      rows 4 987 368      perMin 2 451     (= 1 017.0 rows/call)
 *
 * Every assertion is on WHAT THE MIRROR ASKED THE FLEET FOR, never on the
 * state it ended up in. A full-fleet read and a one-id read leave the mirror
 * holding the same values, so asserting on the values passes either way —
 * which is exactly how a 4 904-call storm survived a single-flight gate and a
 * green suite.
 *
 * Disarm checks, for the record:
 *  - make `classifyDeviceEvent` always return `{kind:'fleet'}` → the first two
 *    tests fail with `null` (the whole fleet) where an id set is required.
 *  - drop the `MIRROR_IRRELEVANT_META_FIELDS` branch → the `name` test fails
 *    with one read where zero are correct.
 *  - drop the "asked for and did not come back ⇒ delete" branch → the removal
 *    test fails, still reporting the dead device's parent.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { classifyDeviceEvent, DeviceMetaMirror } from '../device-meta-mirror.js'

interface FleetRow {
  readonly id: number
  readonly type: string
  readonly location: string | null
  readonly parentDeviceId: number | null
}

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

const NO_LIVE_DEVICES = {
  parentDeviceId: (): number | null => null,
  type: (): string | null => null,
  location: (): string | null => null,
}

/** A fleet of `size` devices, every one a child of device 1. */
function fleetOf(size: number): FleetRow[] {
  const out: FleetRow[] = [{ id: 1, type: 'container', location: 'hall', parentDeviceId: null }]
  for (let id = 2; id <= size; id++) {
    out.push({ id, type: 'camera', location: 'hall', parentDeviceId: 1 })
  }
  return out
}

function makeMirror(rows: FleetRow[]): {
  mirror: DeviceMetaMirror
  asked: Array<readonly number[] | null>
  setFleet: (next: FleetRow[]) => void
} {
  let fleet = rows
  const asked: Array<readonly number[] | null> = []
  const mirror = new DeviceMetaMirror(
    async (deviceIds) => {
      asked.push(deviceIds === null ? null : [...deviceIds])
      if (deviceIds === null) return fleet
      const wanted = new Set(deviceIds)
      return fleet.filter((r) => wanted.has(r.id))
    },
    NO_LIVE_DEVICES,
    makeLogger(),
  )
  return {
    mirror,
    asked,
    setFleet: (next: FleetRow[]) => {
      fleet = next
    },
  }
}

describe('DeviceMetaMirror — the read is as narrow as the event', () => {
  it('one device event asks for ONE device, not the fleet', async () => {
    const h = makeMirror(fleetOf(1017))
    await h.mirror.refreshAll()
    h.asked.length = 0

    h.mirror.onDeviceEvent({ deviceId: 102, name: 'Front door', parentDeviceId: 1 })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))

    expect(h.asked[0], 'a device event must never widen to the whole fleet').toEqual([102])
  })

  it('a burst of device events collapses into ONE read of the union', async () => {
    // Hold the first read open so the burst has something to collapse into.
    let release = (): void => {}
    const gateOpen = new Promise<void>((resolve) => {
      release = resolve
    })
    const asked: Array<readonly number[] | null> = []
    let first = true
    const mirror = new DeviceMetaMirror(
      async (deviceIds) => {
        asked.push(deviceIds === null ? null : [...deviceIds])
        if (first) {
          first = false
          await gateOpen
        }
        return []
      },
      NO_LIVE_DEVICES,
      makeLogger(),
    )
    mirror.onDeviceEvent({ deviceId: 10 })
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    mirror.onDeviceEvent({ deviceId: 11 })
    mirror.onDeviceEvent({ deviceId: 12 })
    mirror.onDeviceEvent({ deviceId: 11 })
    expect(asked, 'the burst must not start reads of its own').toHaveLength(1)

    release()
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    expect([...(asked[1] ?? [])].sort((a, b) => Number(a) - Number(b))).toEqual([11, 12])
  })

  it('an event naming a field the mirror does not hold reads NOTHING', async () => {
    const h = makeMirror(fleetOf(1017))
    await h.mirror.refreshAll()
    h.asked.length = 0

    for (const field of ['name', 'role', 'display', 'metadata', 'integrationId', 'disabled']) {
      h.mirror.onDeviceEvent({ deviceId: 102, field, value: 'whatever' })
    }
    await Promise.resolve()
    await Promise.resolve()

    expect(h.asked, 'a rename cannot change parent/type/location — it must cost nothing').toEqual(
      [],
    )
  })

  it('an event naming a field the mirror DOES hold reads that one device', async () => {
    const h = makeMirror(fleetOf(1017))
    await h.mirror.refreshAll()
    h.asked.length = 0

    h.mirror.onDeviceEvent({ deviceId: 102, field: 'location', value: 'Garage' })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))

    expect(h.asked[0]).toEqual([102])
  })

  it('an unrecognised field still reads that one device — the list is a DENYLIST', async () => {
    const h = makeMirror(fleetOf(1017))
    await h.mirror.refreshAll()
    h.asked.length = 0

    h.mirror.onDeviceEvent({ deviceId: 102, field: 'someFieldAddedNextYear', value: 1 })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))

    expect(h.asked[0], 'a field nobody classified must cost a row, never correctness').toEqual([
      102,
    ])
  })

  it('only the warm reads the whole fleet', async () => {
    const h = makeMirror(fleetOf(1017))

    await h.mirror.refreshAll()

    expect(h.asked).toEqual([null])
    expect(h.mirror.list()).toHaveLength(1017)
  })
})

describe('DeviceMetaMirror — a scoped refresh keeps what a full rebuild guaranteed', () => {
  it('an id asked for that does NOT come back is removed from the mirror', async () => {
    const h = makeMirror(fleetOf(5))
    await h.mirror.refreshAll()
    expect(h.mirror.parentOf(4)).toBe(1)
    expect(h.mirror.typeOf(4)).toBe('camera')

    h.setFleet(fleetOf(5).filter((r) => r.id !== 4))
    h.mirror.onDeviceEvent({ deviceId: 4, providerId: 'addon-a', parentDeviceId: 1 })
    await vi.waitFor(() => expect(h.mirror.typeOf(4)).toBeNull())

    expect(h.mirror.parentOf(4), 'a removed device must not keep inheriting a grant').toBeNull()
    expect(h.mirror.list().map((d) => d.id)).not.toContain(4)
    expect(h.mirror.typeOf(3), 'the rest of the fleet is untouched').toBe('camera')
  })

  it('a scoped refresh never touches a device it was not asked about', async () => {
    const h = makeMirror(fleetOf(5))
    await h.mirror.refreshAll()

    h.setFleet([{ id: 3, type: 'doorbell', location: 'Porta', parentDeviceId: 2 }])
    h.mirror.onDeviceEvent({ deviceId: 3, field: 'type', value: 'doorbell' })
    await vi.waitFor(() => expect(h.mirror.typeOf(3)).toBe('doorbell'))

    expect(h.mirror.parentOf(3)).toBe(2)
    expect(h.mirror.typeOf(5), 'device 5 was not in the answer and was not asked about').toBe(
      'camera',
    )
    expect(h.mirror.list()).toHaveLength(5)
  })

  it('a read that THROWS changes nothing (D49)', async () => {
    const asked: Array<readonly number[] | null> = []
    let fail = false
    const mirror = new DeviceMetaMirror(
      async (deviceIds) => {
        asked.push(deviceIds === null ? null : [...deviceIds])
        if (fail) throw new Error('listAll timed out')
        return fleetOf(5)
      },
      NO_LIVE_DEVICES,
      makeLogger(),
    )
    await mirror.refreshAll()
    expect(mirror.parentOf(4)).toBe(1)

    fail = true
    mirror.onDeviceEvent({ deviceId: 4 })
    await vi.waitFor(() => expect(asked).toHaveLength(2))

    expect(mirror.parentOf(4), 'a failed read must never look like a removal').toBe(1)
    expect(mirror.typeOf(4)).toBe('camera')
  })

  it('the ancestor chain is bounded even when the persisted parentage cycles', async () => {
    const asked: Array<readonly number[] | null> = []
    const mirror = new DeviceMetaMirror(
      async (deviceIds) => {
        asked.push(deviceIds === null ? null : [...deviceIds])
        return [
          { id: 1, type: 'container', location: null, parentDeviceId: 2 },
          { id: 2, type: 'container', location: null, parentDeviceId: 1 },
        ]
      },
      NO_LIVE_DEVICES,
      makeLogger(),
    )
    await mirror.refreshAll()

    expect(mirror.ancestorsOf(1).length).toBeLessThanOrEqual(8)
  })
})

describe('classifyDeviceEvent', () => {
  it('an unreadable payload widens to the fleet — never a silent skip', () => {
    expect(classifyDeviceEvent(undefined)).toEqual({ kind: 'fleet' })
    expect(classifyDeviceEvent('nope')).toEqual({ kind: 'fleet' })
    expect(classifyDeviceEvent({ providerId: 'x' })).toEqual({ kind: 'fleet' })
    expect(classifyDeviceEvent({ deviceId: Number.NaN })).toEqual({ kind: 'fleet' })
  })

  it('a mirrored-field payload names its one device', () => {
    expect(classifyDeviceEvent({ deviceId: 7, field: 'location', value: null })).toEqual({
      kind: 'device',
      deviceId: 7,
    })
  })

  it('an irrelevant field is refused BEFORE the deviceId is even read', () => {
    // The order matters: a `name` change on an unreadable payload must still be
    // free, not a fleet read.
    expect(classifyDeviceEvent({ field: 'name' })).toEqual({ kind: 'none' })
  })
})
