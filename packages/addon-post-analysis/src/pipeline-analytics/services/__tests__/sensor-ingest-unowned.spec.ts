/**
 * A sensor no camera takes a timeline row for (D630 §6): the ingest writes no
 * row — no camera owns one — but the state change still reaches the
 * Notification Center as the sensor's own event, so a contact rule can fire
 * (and arm-gated rules can trigger the alarm). Before, `no-camera` was a pure
 * drop: an unlinked door contact could never notify.
 *
 * "No camera takes a row" has two truths, and the event says which:
 * linked to none (`linkedCameraIds: []`), or linked only by cameras that did
 * not opt it into tracked events (those cameras). And it is only ever decided
 * off an index that ANSWERED — an unknown index evaluates nothing (D49).
 */
import { describe, it, expect, vi } from 'vitest'
import type { SensorEvent } from '@camstack/types'
import {
  CameraIndexUnknownDrops,
  DEFAULT_INDEX_UNKNOWN_SUMMARY_WINDOW_MS,
} from '../camera-index-unknown-drops.js'
import {
  ingestSensorStateChange,
  LinkedCamerasCache,
  type SensorCameraLookup,
  type UnownedSensorEvent,
} from '../event-kinds.js'

function fakeCache(opts: {
  linked: readonly number[]
  all?: readonly number[]
  isCamera: boolean
  answered?: boolean
}): SensorCameraLookup {
  return {
    camerasFor: vi.fn(async () => opts.linked),
    allCamerasFor: vi.fn(async () => opts.all ?? opts.linked),
    isCamera: vi.fn(async () => opts.isCamera),
    answered: vi.fn(async () => opts.answered ?? true),
  }
}

const CONTACT_OPENED = { deviceId: 3243, capName: 'contact', slice: { entryOpen: true } }

function expectedEvent(): SensorEvent {
  return {
    id: 'id-1',
    deviceId: 3243,
    sourceDeviceId: 3243,
    kind: 'contact',
    value: { entryOpen: true },
    timestamp: 1000,
  }
}

describe('a sensor no camera takes a row for', () => {
  it('truly unlinked: no timeline row, the sensor-level event carries []', async () => {
    const sink = { insert: vi.fn(async () => undefined) }
    const unowned: UnownedSensorEvent[] = []
    const dropped = vi.fn()
    const n = await ingestSensorStateChange(
      {
        sink,
        cache: fakeCache({ linked: [], isCamera: false }),
        onUnowned: (u) => unowned.push(u),
        onDropped: dropped,
        makeId: () => 'id-1',
      },
      CONTACT_OPENED,
      1000,
    )
    expect(n).toBe(0)
    expect(sink.insert).not.toHaveBeenCalled()
    expect(unowned).toEqual([{ event: expectedEvent(), linkedCameraIds: [] }])
    expect(dropped).not.toHaveBeenCalled()
  })

  it('linked only by opted-out cameras: no row, one event carrying those cameras', async () => {
    const sink = { insert: vi.fn(async () => undefined) }
    const unowned: UnownedSensorEvent[] = []
    const n = await ingestSensorStateChange(
      {
        sink,
        cache: fakeCache({ linked: [], all: [101, 102], isCamera: false }),
        onUnowned: (u) => unowned.push(u),
        makeId: () => 'id-1',
      },
      CONTACT_OPENED,
      1000,
    )
    expect(n).toBe(0)
    expect(sink.insert).not.toHaveBeenCalled()
    expect(unowned).toEqual([{ event: expectedEvent(), linkedCameraIds: [101, 102] }])
  })

  it('still reports the drop when no one takes the sensor-level event', async () => {
    const sink = { insert: vi.fn(async () => undefined) }
    const dropped = vi.fn()
    const n = await ingestSensorStateChange(
      { sink, cache: fakeCache({ linked: [], isCamera: false }), onDropped: dropped },
      CONTACT_OPENED,
      1000,
    )
    expect(n).toBe(0)
    expect(sink.insert).not.toHaveBeenCalled()
    expect(dropped).toHaveBeenCalledWith('no-camera', 'contact')
  })

  it('a camera-native cap stays dropped — it is not a sensor-level event', async () => {
    const unowned: UnownedSensorEvent[] = []
    const dropped = vi.fn()
    await ingestSensorStateChange(
      {
        sink: { insert: vi.fn(async () => undefined) },
        cache: fakeCache({ linked: [], isCamera: true }),
        onUnowned: (u) => unowned.push(u),
        onDropped: dropped,
      },
      { deviceId: 104, capName: 'motion', slice: { detected: true } },
      1000,
    )
    expect(unowned).toEqual([])
    expect(dropped).toHaveBeenCalledWith('camera-native-cap', expect.any(String))
  })

  it('a throwing hook propagates — never swallowed — to the caller’s logged catch', async () => {
    await expect(
      ingestSensorStateChange(
        {
          sink: { insert: vi.fn(async () => undefined) },
          cache: fakeCache({ linked: [], isCamera: false }),
          onUnowned: () => {
            throw new Error('boom')
          },
        },
        CONTACT_OPENED,
        1000,
      ),
    ).rejects.toThrow('boom')
  })
})

describe('an unknown camera index evaluates nothing (D49)', () => {
  it('cold start, camera list throws: a camera’s own motion never reaches onUnowned', async () => {
    const cache = new LinkedCamerasCache({
      cameras: {
        listCameraIds: async () => {
          throw new Error('device-manager unreachable')
        },
      },
      linkedDevices: { getLinkedDevices: async () => ({ mode: 'manual', devices: [] }) },
    })
    const unowned: UnownedSensorEvent[] = []
    const dropped: string[] = []
    await ingestSensorStateChange(
      {
        sink: { insert: vi.fn(async () => undefined) },
        cache,
        onUnowned: (u) => unowned.push(u),
        onDropped: (reason) => dropped.push(reason),
      },
      // Camera 104's native motion. With no camera list, `isCamera` is false
      // and this looks exactly like an unlinked sensor.
      { deviceId: 104, capName: 'motion', slice: { detected: true } },
      1000,
    )
    expect(unowned).toEqual([])
    expect(dropped).toEqual(['camera-index-unknown'])
  })

  it('a camera whose links could not be read leaves the index unanswered', async () => {
    const cache = new LinkedCamerasCache({
      cameras: { listCameraIds: async () => [101] },
      linkedDevices: {
        getLinkedDevices: async () => {
          throw new Error('links unreadable')
        },
      },
    })
    const unowned: UnownedSensorEvent[] = []
    const dropped: string[] = []
    await ingestSensorStateChange(
      {
        sink: { insert: vi.fn(async () => undefined) },
        cache,
        onUnowned: (u) => unowned.push(u),
        onDropped: (reason) => dropped.push(reason),
      },
      CONTACT_OPENED,
      1000,
    )
    expect(unowned).toEqual([])
    expect(dropped).toEqual(['camera-index-unknown'])
  })
})

describe('LinkedCamerasCache.allCamerasFor ignores the tracked-events opt-in', () => {
  it('camerasFor keeps the opt-in, allCamerasFor lists every linking camera', async () => {
    const links: Record<number, { deviceId: number; producesTrackedEvents?: boolean }[]> = {
      101: [{ deviceId: 3243, producesTrackedEvents: false }],
      102: [{ deviceId: 3243 }],
      108: [{ deviceId: 3243, producesTrackedEvents: false }],
    }
    const cache = new LinkedCamerasCache({
      cameras: { listCameraIds: async () => [101, 102, 108] },
      linkedDevices: {
        getLinkedDevices: async ({ deviceId }) => ({
          mode: 'manual',
          devices: (links[deviceId] ?? []).map((d) => ({
            ...d,
            name: `d${d.deviceId}`,
            location: null,
            features: [],
          })),
        }),
      },
    })
    expect(await cache.camerasFor(3243)).toEqual([102])
    expect(await cache.allCamerasFor(3243)).toEqual([101, 102, 108])
    expect(await cache.answered()).toBe(true)
  })
})

describe('after one complete build the mirror stays authoritative (D49)', () => {
  type Links = Record<number, { deviceId: number; producesTrackedEvents?: boolean }[]>
  /** A cache rebuilt on EVERY read (`ttlMs: 0`), whose reads the test flips. */
  function flakyCache(state: {
    listThrows: boolean
    unreadable: Set<number>
    cameras: number[]
    links: Links
  }): { cache: LinkedCamerasCache; errors: { scope: string; cameraId?: number }[] } {
    const errors: { scope: string; cameraId?: number }[] = []
    const cache = new LinkedCamerasCache({
      ttlMs: 0,
      cameras: {
        listCameraIds: async () => {
          if (state.listThrows) throw new Error('listAll failed')
          return state.cameras
        },
      },
      linkedDevices: {
        getLinkedDevices: async ({ deviceId }) => {
          if (state.unreadable.has(deviceId)) throw new Error('links unreadable')
          return {
            mode: 'manual',
            devices: (state.links[deviceId] ?? []).map((d) => ({
              ...d,
              name: `d${d.deviceId}`,
              location: null,
              features: [],
            })),
          }
        },
      },
      onError: (scope, _err, cameraId) =>
        errors.push({ scope, ...(cameraId !== undefined ? { cameraId } : {}) }),
    })
    return { cache, errors }
  }

  it('a rebuild whose camera list throws keeps the answer: an unlinked contact still reaches onUnowned', async () => {
    const state = { listThrows: false, unreadable: new Set<number>(), cameras: [101], links: {} }
    const { cache, errors } = flakyCache(state)
    expect(await cache.answered()).toBe(true) // one complete build

    state.listThrows = true
    const unowned: UnownedSensorEvent[] = []
    const dropped: string[] = []
    await ingestSensorStateChange(
      {
        sink: { insert: vi.fn(async () => undefined) },
        cache,
        onUnowned: (u) => unowned.push(u),
        onDropped: (reason) => dropped.push(reason),
        makeId: () => 'id-1',
      },
      CONTACT_OPENED,
      1000,
    )
    expect(dropped).toEqual([])
    expect(unowned).toEqual([{ event: expectedEvent(), linkedCameraIds: [] }])
    expect(errors.some((e) => e.scope === 'listCameraIds')).toBe(true)
  })

  it('a camera whose links become unreadable keeps its previous links', async () => {
    const state = {
      listThrows: false,
      unreadable: new Set<number>(),
      cameras: [101, 102],
      links: { 101: [{ deviceId: 3243 }], 102: [] } as Links,
    }
    const { cache, errors } = flakyCache(state)
    expect(await cache.camerasFor(3243)).toEqual([101])

    state.unreadable.add(101)
    expect(await cache.camerasFor(3243)).toEqual([101])
    expect(await cache.allCamerasFor(3243)).toEqual([101])
    expect(await cache.answered()).toBe(true)
    // The failed read is reported against THAT camera.
    expect(errors).toContainEqual({ scope: 'getLinkedDevices', cameraId: 101 })
  })

  it('only a camera NEVER read leaves the index unanswered, and the gap names it', async () => {
    const state = {
      listThrows: false,
      unreadable: new Set<number>([102]),
      cameras: [101, 102],
      links: {} as Links,
    }
    const { cache } = flakyCache(state)
    expect(await cache.answered()).toBe(false)
    expect(cache.gap()).toEqual({ cameraListRead: true, unansweredCameraIds: [102] })
  })

  it('a cache that never read a camera list says so in its gap', async () => {
    const { cache } = flakyCache({
      listThrows: true,
      unreadable: new Set(),
      cameras: [],
      links: {},
    })
    expect(await cache.answered()).toBe(false)
    expect(cache.gap()).toEqual({ cameraListRead: false, unansweredCameraIds: [] })
  })
})

describe('camera-index-unknown drops are a windowed COUNT, never a line per event', () => {
  it('holds every drop until the window elapses, then one row per (device, cap)', () => {
    const drops = new CameraIndexUnknownDrops({ nowMs: 0 })
    for (let i = 0; i < 500; i++) drops.record(104, 'motion')
    drops.record(3243, 'contact')
    expect(drops.takeSummary(DEFAULT_INDEX_UNKNOWN_SUMMARY_WINDOW_MS - 1)).toEqual([])
    expect(drops.takeSummary(DEFAULT_INDEX_UNKNOWN_SUMMARY_WINDOW_MS)).toEqual([
      { deviceId: 104, capName: 'motion', count: 500 },
      { deviceId: 3243, capName: 'contact', count: 1 },
    ])
    // Taking resets the window and the counts.
    drops.record(104, 'motion')
    expect(drops.takeSummary(DEFAULT_INDEX_UNKNOWN_SUMMARY_WINDOW_MS + 1)).toEqual([])
  })
})
