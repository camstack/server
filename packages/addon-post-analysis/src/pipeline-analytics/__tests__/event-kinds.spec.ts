/**
 * Part B — extensible per-device event kinds + sensor-event ingest.
 *
 * Covers:
 *  - composeEventKinds: built-ins always present; observed detection classes;
 *    sensor kinds from the camera's OWN bindings and from LINKED devices
 *    (binding-driven, EVENT_KIND_BY_CAP mapped, deduped per kind+source);
 *    graceful degradation on client errors
 *  - LinkedCamerasCache: reverse-index build, isCamera off the same build,
 *    TTL refresh, invalidate
 *  - ingestSensorStateChange: one row per camera the event belongs to (linked
 *    cameras + the emitting device when it IS a camera), the camera-native cap
 *    exclusion, the drop reasons, unmapped-cap gate, non-object slice → null
 */

import type { SensorEvent } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  composeEventKinds,
  composeEventKindsForDevices,
  ingestSensorStateChange,
  LinkedCamerasCache,
  type LinkedCamerasCacheDeps,
  type LinkedDeviceEntry,
  type LinkedDevicesClient,
  resolveLinkedMediaCameras,
} from '../services/event-kinds.js'

function linked(deviceId: number): LinkedDeviceEntry {
  return { deviceId, name: `dev-${deviceId}`, location: 'garden', features: [] }
}

function makeLinkedClient(map: Record<number, readonly LinkedDeviceEntry[]>): LinkedDevicesClient {
  return {
    getLinkedDevices: async ({ deviceId }) => ({
      mode: 'auto' as const,
      devices: map[deviceId] ?? [],
    }),
  }
}

const NO_LINKS = {
  linkedDevices: makeLinkedClient({}),
  bindings: { getBindings: async () => ({ entries: [] as { capName: string }[] }) },
}

describe('composeEventKinds', () => {
  it('composes motion + enabled detection macros/subs + linked sensor kinds', async () => {
    const kinds = await composeEventKinds(
      {
        linkedDevices: makeLinkedClient({ 1: [linked(10), linked(11)] }),
        bindings: {
          getBindings: async ({ deviceId }) => ({
            entries:
              deviceId === 10
                ? [{ capName: 'contact' }, { capName: 'battery' }]
                : deviceId === 11
                  ? [{ capName: 'flood' }]
                  : [],
          }),
        },
        enabledMacroClasses: async () => ['person', 'vehicle'],
        audioEnabled: async () => false,
      },
      1,
    )

    const byKind = new Map(kinds.map((k) => [`${k.kind}:${k.source.deviceId}`, k]))
    // Motion built-in.
    expect(byKind.get('motion:1')?.category).toBe('motion')
    // Detection macros are advertised even without observation.
    expect(byKind.get('person:1')?.level).toBe('macro')
    expect(byKind.get('vehicle:1')?.level).toBe('macro')
    // Sensor kinds from linked devices — mapped caps only, source = the sensor.
    expect(byKind.get('contact:10')).toMatchObject({
      category: 'sensor',
      iconId: 'door',
      parentKind: 'sensor',
      source: { capName: 'contact', deviceId: 10 },
    })
    expect(byKind.get('flood:11')?.iconId).toBe('water')
    // 'battery' is not a mapped sensor cap → no descriptor.
    expect(kinds.some((k) => k.source.capName === 'battery')).toBe(false)
  })

  it('a camera with vehicle enabled advertises vehicle + car/truck/bus (not just observed)', async () => {
    const kinds = await composeEventKinds(
      {
        ...NO_LINKS,
        enabledMacroClasses: async () => ['vehicle'],
        audioEnabled: async () => false,
      },
      1,
    )
    const byKind = new Map(kinds.map((k) => [k.kind, k]))
    expect(byKind.get('vehicle')?.level).toBe('macro')
    for (const sub of ['car', 'truck', 'bus']) {
      expect(byKind.get(sub)?.parentKind, sub).toBe('vehicle')
      expect(byKind.get(sub)?.level).toBe('sub')
    }
    // person macro NOT advertised (only vehicle was enabled).
    expect(byKind.has('person')).toBe(false)
  })

  it('a linked lock advertises the control/lock kind', async () => {
    const kinds = await composeEventKinds(
      {
        linkedDevices: makeLinkedClient({ 1: [linked(20)] }),
        bindings: {
          getBindings: async ({ deviceId }) => ({
            entries: deviceId === 20 ? [{ capName: 'lock-control' }] : [],
          }),
        },
        enabledMacroClasses: async () => [],
        audioEnabled: async () => false,
      },
      1,
    )
    const lock = kinds.find((k) => k.kind === 'lock')
    expect(lock).toMatchObject({
      category: 'control',
      parentKind: 'control',
      level: 'sub',
      source: { capName: 'lock-control', deviceId: 20 },
    })
  })

  it('audio enabled advertises the audio macro + its subs', async () => {
    const kinds = await composeEventKinds(
      { ...NO_LINKS, enabledMacroClasses: async () => [], audioEnabled: async () => true },
      1,
    )
    const byKind = new Map(kinds.map((k) => [k.kind, k]))
    expect(byKind.get('audio')?.level).toBe('macro')
    // Audio subs are namespaced so they never collide with detection subs.
    expect(kinds.some((k) => k.parentKind === 'audio' && k.kind.startsWith('audio-'))).toBe(true)
  })

  it('dedupes per (kind, source device) but keeps two sensors of the same kind', async () => {
    const kinds = await composeEventKinds(
      {
        linkedDevices: makeLinkedClient({ 1: [linked(10), linked(11)] }),
        bindings: {
          // Both LINKED devices bind 'contact' twice (duplicate binding
          // entries). The camera itself binds nothing.
          getBindings: async ({ deviceId }) => ({
            entries: deviceId === 1 ? [] : [{ capName: 'contact' }, { capName: 'contact' }],
          }),
        },
        enabledMacroClasses: async () => [],
        audioEnabled: async () => false,
      },
      1,
    )
    const contacts = kinds.filter((k) => k.kind === 'contact')
    expect(contacts).toHaveLength(2)
    expect(contacts.map((k) => k.source.deviceId).sort()).toEqual([10, 11])
  })

  it('degrades to motion when the linked-devices or config lookups fail', async () => {
    const errors: string[] = []
    const kinds = await composeEventKinds(
      {
        linkedDevices: {
          getLinkedDevices: async () => {
            throw new Error('device-manager unavailable')
          },
        },
        bindings: { getBindings: async () => ({ entries: [] }) },
        enabledMacroClasses: async () => {
          throw new Error('config down')
        },
        audioEnabled: async () => false,
        onError: (scope) => {
          errors.push(scope)
        },
      },
      1,
    )
    expect(kinds.map((k) => k.kind)).toEqual(['motion'])
    expect(errors.sort()).toEqual(['enabledMacroClasses', 'getLinkedDevices'])
  })

  // A sensor/control cap can be bound on the CAMERA itself (a composed
  // doorbell, D671; a native Reolink doorbell). The camera is then both the source and
  // the subject, and it must advertise the lane it can actually emit.
  it('advertises a sensor cap bound ON the camera itself, sourced to the camera', async () => {
    const kinds = await composeEventKinds(
      {
        linkedDevices: makeLinkedClient({ 101: [linked(616)] }),
        bindings: {
          getBindings: async ({ deviceId }) => ({
            // 101 = camera with the doorbell bound on itself.
            // 616 = the siren accessory, a switch.
            entries: deviceId === 101 ? [{ capName: 'doorbell' }] : [{ capName: 'switch' }],
          }),
        },
        enabledMacroClasses: async () => [],
        audioEnabled: async () => false,
      },
      101,
    )
    const byKind = new Map(kinds.map((k) => [`${k.kind}:${k.source.deviceId}`, k]))
    expect(byKind.get('doorbell:101')).toMatchObject({
      category: 'control',
      source: { capName: 'doorbell', deviceId: 101 },
    })
    // The linked siren still contributes its own kind — self-inclusion ADDS.
    expect(byKind.get('switch:616')?.source).toEqual({ capName: 'switch', deviceId: 616 })
  })

  it('never re-advertises a camera-native cap (motion) from the camera own bindings', async () => {
    const kinds = await composeEventKinds(
      {
        ...NO_LINKS,
        bindings: {
          getBindings: async () => ({ entries: [{ capName: 'motion' }] }),
        },
        enabledMacroClasses: async () => [],
        audioEnabled: async () => false,
      },
      101,
    )
    // Exactly ONE motion lane — the built-in. The camera's own `motion` cap
    // must NOT add a second, differently-named ('motion-sensor') copy.
    expect(kinds.map((k) => k.kind)).toEqual(['motion'])
  })
})

describe('LinkedCamerasCache', () => {
  it('builds the reverse index (sensor → cameras) lazily', async () => {
    const cache = new LinkedCamerasCache({
      cameras: { listCameraIds: async () => [1, 2] },
      linkedDevices: makeLinkedClient({ 1: [linked(10), linked(11)], 2: [linked(11)] }),
    })
    expect(await cache.camerasFor(11, 1_000)).toEqual([1, 2])
    expect(await cache.camerasFor(10, 1_000)).toEqual([1])
    expect(await cache.camerasFor(99, 1_000)).toEqual([])
  })

  it('answers isCamera off the SAME build (no extra enumeration)', async () => {
    let calls = 0
    const cache = new LinkedCamerasCache({
      cameras: {
        listCameraIds: async () => {
          calls++
          return [1, 2]
        },
      },
      linkedDevices: makeLinkedClient({ 1: [linked(10)] }),
    })
    expect(await cache.isCamera(1, 1_000)).toBe(true)
    expect(await cache.isCamera(10, 1_000)).toBe(false)
    expect(await cache.camerasFor(10, 1_000)).toEqual([1])
    expect(calls).toBe(1)
  })

  it('excludes a linked device that does NOT produce tracked events', async () => {
    const cache = new LinkedCamerasCache({
      cameras: { listCameraIds: async () => [1] },
      linkedDevices: {
        getLinkedDevices: async () => ({
          mode: 'auto' as const,
          devices: [
            {
              deviceId: 10,
              name: 'dev-10',
              location: null,
              features: [],
              producesTrackedEvents: true,
            },
            {
              deviceId: 11,
              name: 'dev-11',
              location: null,
              features: [],
              producesTrackedEvents: false,
            },
          ],
        }),
      },
    })
    // 10 produces tracked events → linked to camera 1.
    expect(await cache.camerasFor(10, 1_000)).toEqual([1])
    // 11 is linked but NOT selected as a tracked-event producer → excluded.
    expect(await cache.camerasFor(11, 1_000)).toEqual([])
  })

  it('serves stale within TTL and rebuilds after it', async () => {
    let generation = 0
    const cache = new LinkedCamerasCache({
      ttlMs: 60_000,
      cameras: { listCameraIds: async () => [1] },
      linkedDevices: {
        getLinkedDevices: async () => ({
          mode: 'auto' as const,
          devices: generation === 0 ? [linked(10)] : [linked(20)],
        }),
      },
    })
    expect(await cache.camerasFor(10, 1_000)).toEqual([1])
    generation = 1
    // Within TTL → still the cached topology.
    expect(await cache.camerasFor(20, 30_000)).toEqual([])
    // Past TTL → rebuilt.
    expect(await cache.camerasFor(20, 70_000)).toEqual([1])
    expect(await cache.camerasFor(10, 70_001)).toEqual([])
  })

  it('invalidate() forces the next lookup to rebuild', async () => {
    let calls = 0
    const cache = new LinkedCamerasCache({
      ttlMs: 60_000,
      cameras: {
        listCameraIds: async () => {
          calls++
          return [1]
        },
      },
      linkedDevices: makeLinkedClient({ 1: [linked(10)] }),
    })
    await cache.camerasFor(10, 1_000)
    await cache.camerasFor(10, 2_000)
    expect(calls).toBe(1)
    cache.invalidate()
    await cache.camerasFor(10, 3_000)
    expect(calls).toBe(2)
  })
})

describe('ingestSensorStateChange', () => {
  function makeSink(): { rows: SensorEvent[]; insert: (ev: SensorEvent) => Promise<void> } {
    const rows: SensorEvent[] = []
    return {
      rows,
      insert: async (ev) => {
        rows.push(ev)
      },
    }
  }

  function seededCache(
    map: Record<number, readonly number[]>,
    cameraIds: readonly number[] = [],
  ): LinkedCamerasCache {
    const cache = new LinkedCamerasCache({
      cameras: { listCameraIds: async () => [] },
      linkedDevices: makeLinkedClient({}),
    })
    cache.seed(new Map(Object.entries(map).map(([k, v]) => [Number(k), v])), Date.now(), cameraIds)
    return cache
  }

  it('inserts one row per linked camera with the mapped kind + slice snapshot', async () => {
    const sink = makeSink()
    let n = 0
    const inserted = await ingestSensorStateChange(
      { sink, cache: seededCache({ 10: [1, 2] }), makeId: () => `id-${n++}` },
      { deviceId: 10, capName: 'contact', slice: { entryOpen: true, lastChangedAt: 5 } },
      12_345,
    )
    expect(inserted).toBe(2)
    expect(sink.rows).toEqual([
      {
        id: 'id-0',
        deviceId: 1,
        sourceDeviceId: 10,
        kind: 'contact',
        value: { entryOpen: true, lastChangedAt: 5 },
        timestamp: 12_345,
      },
      {
        id: 'id-1',
        deviceId: 2,
        sourceDeviceId: 10,
        kind: 'contact',
        value: { entryOpen: true, lastChangedAt: 5 },
        timestamp: 12_345,
      },
    ])
  })

  it('fires onPersisted with the inserted row per linked camera (NC device-event hook)', async () => {
    const sink = makeSink()
    const persisted: SensorEvent[] = []
    let n = 0
    await ingestSensorStateChange(
      {
        sink,
        cache: seededCache({ 10: [1, 2] }),
        makeId: () => `id-${n++}`,
        onPersisted: (ev) => persisted.push(ev),
      },
      { deviceId: 10, capName: 'doorbell', slice: { lastPressedAt: 7, pressCountSinceStart: 1 } },
      99,
    )
    expect(persisted.map((e) => [e.id, e.deviceId, e.kind])).toEqual([
      ['id-0', 1, 'doorbell'],
      ['id-1', 2, 'doorbell'],
    ])
  })

  it('skips unmapped caps and unlinked devices', async () => {
    const sink = makeSink()
    const cache = seededCache({ 10: [1] })
    expect(
      await ingestSensorStateChange(
        { sink, cache },
        { deviceId: 10, capName: 'battery', slice: {} },
        1,
      ),
    ).toBe(0)
    expect(
      await ingestSensorStateChange(
        { sink, cache },
        { deviceId: 55, capName: 'contact', slice: {} },
        1,
      ),
    ).toBe(0)
    expect(sink.rows).toHaveLength(0)
  })

  // ── Camera-bound sensor caps (the 2026-08-07 gap) ────────────────────
  //
  // Camera 101 carries the `doorbell` cap bound ON ITSELF. Its only
  // linked device is the siren 616, which is `producesTrackedEvents: false`
  // and therefore absent from the reverse index. Before the fix
  // `camerasFor(101)` returned [] and a real press persisted NOTHING — no
  // SensorEvent row, so the NC `device-event` rule could never be evaluated.
  it('materialises a row FOR the camera when the sensor cap is bound on the camera itself', async () => {
    const sink = makeSink()
    const persisted: SensorEvent[] = []
    const inserted = await ingestSensorStateChange(
      {
        sink,
        cache: seededCache({}, [101, 102]),
        makeId: () => 'id-0',
        onPersisted: (ev) => persisted.push(ev),
      },
      {
        deviceId: 101,
        capName: 'doorbell',
        slice: { lastPressedAt: 12_345, pressCountSinceStart: 3 },
      },
      12_345,
    )
    expect(inserted).toBe(1)
    expect(sink.rows).toEqual([
      {
        id: 'id-0',
        deviceId: 101,
        sourceDeviceId: 101,
        kind: 'doorbell',
        value: { lastPressedAt: 12_345, pressCountSinceStart: 3 },
        timestamp: 12_345,
      },
    ])
    // The NC device-event hook fires with kind=doorbell on the camera.
    expect(persisted.map((e) => [e.deviceId, e.sourceDeviceId, e.kind])).toEqual([
      [101, 101, 'doorbell'],
    ])
  })

  it('does not duplicate when the camera is BOTH the source and a linked camera', async () => {
    const sink = makeSink()
    let n = 0
    const inserted = await ingestSensorStateChange(
      { sink, cache: seededCache({ 101: [101, 102] }, [101, 102]), makeId: () => `id-${n++}` },
      { deviceId: 101, capName: 'doorbell', slice: {} },
      1,
    )
    expect(inserted).toBe(2)
    expect(sink.rows.map((r) => r.deviceId)).toEqual([101, 102])
  })

  it('never self-ingests a camera-native cap (motion) — the camera already has that path', async () => {
    const sink = makeSink()
    const dropped: string[] = []
    const inserted = await ingestSensorStateChange(
      { sink, cache: seededCache({}, [101]), onDropped: (reason) => dropped.push(reason) },
      { deviceId: 101, capName: 'motion', slice: { detected: true } },
      1,
    )
    expect(inserted).toBe(0)
    expect(sink.rows).toHaveLength(0)
    expect(dropped).toEqual(['camera-native-cap'])
  })

  it('leaves the linked-device path untouched (a real sensor still maps to its cameras)', async () => {
    const sink = makeSink()
    let n = 0
    const inserted = await ingestSensorStateChange(
      { sink, cache: seededCache({ 10: [1, 2] }, [1, 2]), makeId: () => `id-${n++}` },
      { deviceId: 10, capName: 'contact', slice: { entryOpen: true } },
      7,
    )
    expect(inserted).toBe(2)
    expect(sink.rows.map((r) => [r.deviceId, r.sourceDeviceId])).toEqual([
      [1, 10],
      [2, 10],
    ])
  })

  it('reports WHY nothing was ingested for a device tied to no camera at all', async () => {
    const sink = makeSink()
    const dropped: string[] = []
    const inserted = await ingestSensorStateChange(
      { sink, cache: seededCache({}, [101]), onDropped: (reason) => dropped.push(reason) },
      { deviceId: 99, capName: 'contact', slice: {} },
      1,
    )
    expect(inserted).toBe(0)
    expect(dropped).toEqual(['no-camera'])
  })

  it('normalizes a non-object slice to a null value', async () => {
    const sink = makeSink()
    await ingestSensorStateChange(
      { sink, cache: seededCache({ 10: [1] }), makeId: () => 'x' },
      { deviceId: 10, capName: 'flood', slice: 'weird' },
      1,
    )
    expect(sink.rows[0]?.value).toBeNull()
    expect(sink.rows[0]?.kind).toBe('flood')
  })
})

describe('composeEventKinds — package kinds', () => {
  const baseDeps = {
    linkedDevices: makeLinkedClient({}),
    bindings: { getBindings: async () => ({ entries: [] }) },
    enabledMacroClasses: async () => [] as readonly string[],
    audioEnabled: async () => false,
  }

  it('surfaces package-delivered + package-picked-up when a package zone is enabled', async () => {
    const kinds = await composeEventKinds({ ...baseDeps, packageZonesEnabled: async () => true }, 1)
    const byKind = new Map(kinds.map((k) => [k.kind, k]))
    expect(byKind.get('package-delivered')?.category).toBe('package')
    expect(byKind.get('package-delivered')?.icon).toBe('package')
    expect(byKind.get('package-picked-up')?.category).toBe('package')
  })

  it('omits package kinds when no package zone is enabled', async () => {
    const kinds = await composeEventKinds(
      { ...baseDeps, packageZonesEnabled: async () => false },
      1,
    )
    expect(kinds.some((k) => k.kind === 'package-delivered')).toBe(false)
  })

  it('omits package kinds when the gate dep is absent (back-compat)', async () => {
    const kinds = await composeEventKinds(baseDeps, 1)
    expect(kinds.some((k) => k.kind.startsWith('package-'))).toBe(false)
  })
})

/**
 * `listEventKinds` was measured at ~100 ms per camera on the live hub — an
 * order of magnitude slower than every other per-device query — and the viewer
 * calls it once per camera at boot. The cost is not compute: it is a chain of
 * cross-process round-trips awaited one after another, plus one `getBindings`
 * per linked device inside a `for`.
 *
 * These tests pin the CONCURRENCY, not the timing: a latency assertion would
 * be flaky, but "did the second call start before the first resolved" is exact.
 */
describe('composeEventKinds — round-trips run concurrently', () => {
  /** Resolves only once `expected` callers are waiting — so the test can only
   *  pass if they were all in flight at the same moment. */
  function makeBarrier(expected: number): { wait: () => Promise<void> } {
    let arrived = 0
    let release: () => void = () => {}
    const opened = new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      wait: async () => {
        arrived += 1
        if (arrived >= expected) release()
        await opened
      },
    }
  }

  it('starts the four independent config lookups together', async () => {
    // macros, audio, package zones and linked-devices depend on nothing from
    // each other; awaiting them in sequence paid four round-trips of latency
    // to build one answer.
    const barrier = makeBarrier(4)
    const kinds = await composeEventKinds(
      {
        linkedDevices: {
          getLinkedDevices: async () => {
            await barrier.wait()
            return { mode: 'auto' as const, devices: [] }
          },
        },
        bindings: { getBindings: async () => ({ entries: [] }) },
        enabledMacroClasses: async () => {
          await barrier.wait()
          return ['person']
        },
        audioEnabled: async () => {
          await barrier.wait()
          return true
        },
        packageZonesEnabled: async () => {
          await barrier.wait()
          return false
        },
      },
      1,
    )

    expect(kinds.map((k) => k.kind)).toContain('person')
    expect(kinds.map((k) => k.kind)).toContain('audio')
  })

  it('fetches the camera’s own bindings and every linked device’s together', async () => {
    // FOUR participants: the camera itself + its three linked devices. The
    // barrier only opens once all four have arrived, so a self-lookup awaited
    // before the linked batch would hang here instead of quietly costing a
    // round-trip.
    const barrier = makeBarrier(4)
    const kinds = await composeEventKinds(
      {
        linkedDevices: makeLinkedClient({ 1: [linked(10), linked(11), linked(12)] }),
        bindings: {
          getBindings: async ({ deviceId }) => {
            await barrier.wait()
            if (deviceId === 1) return { entries: [{ capName: 'doorbell' }] }
            return { entries: deviceId === 10 ? [{ capName: 'contact' }] : [{ capName: 'flood' }] }
          },
        },
        enabledMacroClasses: async () => [],
        audioEnabled: async () => false,
      },
      1,
    )

    // Order must survive the batching — the timeline lanes are rendered in it.
    // The camera's own kinds come first, then each linked device in order.
    expect(
      kinds
        .filter((k) => k.category === 'sensor' || k.category === 'control')
        .map((k) => k.source.deviceId),
    ).toEqual([1, 10, 11, 12])
  })

  it('still degrades one failing lookup instead of losing the whole answer', async () => {
    const scopes: string[] = []
    const kinds = await composeEventKinds(
      {
        ...NO_LINKS,
        enabledMacroClasses: async () => {
          throw new Error('orchestrator down')
        },
        audioEnabled: async () => true,
        onError: (scope) => scopes.push(scope),
      },
      1,
    )

    expect(scopes).toEqual(['enabledMacroClasses'])
    // Motion and audio survive a failed macro lookup — a camera whose
    // orchestrator hiccuped must not lose its timeline entirely.
    expect(kinds.map((k) => k.kind)).toContain('motion')
    expect(kinds.map((k) => k.kind)).toContain('audio')
  })
})

/**
 * The batch exists because composing ONE camera's vocabulary is the slowest
 * per-device query on the hub (~100 ms) and the viewer asks for it once per
 * camera at first paint. What the batch must not do is trade that latency for
 * an answer the caller cannot trust.
 */
describe('composeEventKindsForDevices', () => {
  it('answers for every id, in the order asked', async () => {
    const out = await composeEventKindsForDevices([3, 1, 2], async (deviceId) => [
      { kind: `k${String(deviceId)}` } as never,
    ])
    expect(out.map((r) => r.deviceId)).toEqual([3, 1, 2])
  })

  it('de-duplicates the requested ids', async () => {
    let calls = 0
    const out = await composeEventKindsForDevices([1, 1, 2], async () => {
      calls += 1
      return []
    })
    expect(out.map((r) => r.deviceId)).toEqual([1, 2])
    expect(calls).toBe(2)
  })

  it('keeps a FAILING camera in the response, with an empty vocabulary', async () => {
    // The invariant this function exists for: a caller that asked for three
    // and received two cannot tell which is missing, or that one is.
    const failures: number[] = []
    const out = await composeEventKindsForDevices(
      [1, 2, 3],
      async (deviceId) => {
        if (deviceId === 2) throw new Error('orchestrator down')
        return [{ kind: 'motion' } as never]
      },
      (deviceId) => failures.push(deviceId),
    )

    expect(out.map((r) => r.deviceId)).toEqual([1, 2, 3])
    expect(out[1]).toEqual({ deviceId: 2, kinds: [] })
    expect(out[0]!.kinds).toHaveLength(1)
    expect(failures).toEqual([2])
  })

  it('composes concurrently', async () => {
    // Serially this would be N times the per-device latency, which is the
    // cost the batch exists to remove.
    let arrived = 0
    let release: () => void = () => {}
    const opened = new Promise<void>((r) => {
      release = r
    })
    const out = await composeEventKindsForDevices([1, 2, 3], async () => {
      arrived += 1
      if (arrived >= 3) release()
      await opened
      return []
    })
    expect(out).toHaveLength(3)
  })

  it('reports the failure without throwing', async () => {
    await expect(
      composeEventKindsForDevices([1], async () => {
        throw new Error('boom')
      }),
    ).resolves.toEqual([{ deviceId: 1, kinds: [] }])
  })
})

/**
 * The rebuild is ONE device-manager call, not one per camera.
 *
 * Each `getLinkedDevices` runs a full fleet listing inside device-manager and
 * they QUEUE — thirty cameras is thirty sweeps of the whole fleet for an index
 * that changes when the operator edits a room. Live hub 2026-08-25: this
 * rebuild was ~31 of the ~38 full-fleet sweeps a minute behind 36 814
 * `query addon-device-settings` calls a minute.
 *
 * The batch is preferred and the loop stays as a FALLBACK, because this addon
 * deploys on its own and can be running against a hub whose closure predates
 * `getLinkedDevicesBatch`. A batch that rejects must degrade to the loop, not
 * to an empty index: a stale reverse index still routes sensor events, an
 * empty one silently routes none.
 */
describe('LinkedCamerasCache rebuild cost', () => {
  it('uses the batch and never asks per camera', async () => {
    let perCamera = 0
    let batchCalls = 0
    const cache = new LinkedCamerasCache({
      cameras: { listCameraIds: async () => [1, 2, 3] },
      linkedDevices: {
        getLinkedDevices: async () => {
          perCamera++
          return { mode: 'auto' as const, devices: [] }
        },
      },
      linkedDevicesBatch: {
        getLinkedDevicesBatch: async ({ deviceIds }) => {
          batchCalls++
          return deviceIds.map((deviceId) => ({ deviceId, devices: [linked(10)] }))
        },
      },
    })

    expect(await cache.camerasFor(10, 1_000)).toEqual([1, 2, 3])
    expect(batchCalls).toBe(1)
    expect(perCamera).toBe(0)
  })

  it('a batch that rejects degrades to the per-camera loop, not to an empty index', async () => {
    let perCamera = 0
    const cache = new LinkedCamerasCache({
      cameras: { listCameraIds: async () => [1, 2] },
      linkedDevices: {
        getLinkedDevices: async ({ deviceId }) => {
          perCamera++
          return { mode: 'auto' as const, devices: [linked(10 + deviceId)] }
        },
      },
      linkedDevicesBatch: {
        getLinkedDevicesBatch: async () => {
          throw new Error('no such procedure')
        },
      },
    })

    expect(await cache.camerasFor(11, 1_000)).toEqual([1])
    expect(await cache.camerasFor(12, 1_000)).toEqual([2])
    expect(perCamera).toBe(2)
  })
})

/**
 * ADR 0632 — the camera set a sensor NOTIFICATION shows is every camera that
 * links the sensor, opt-in or not. Timeline rows keep the opt-in.
 */
describe('sensor notification camera set (ADR 0632)', () => {
  function linked(deviceId: number, producesTrackedEvents: boolean): LinkedDeviceEntry {
    return {
      deviceId,
      name: `dev-${deviceId}`,
      location: null,
      features: [],
      producesTrackedEvents,
    }
  }

  function depsFor(
    map: Readonly<Record<number, readonly LinkedDeviceEntry[]>>,
  ): LinkedCamerasCacheDeps {
    const cameraIds = Object.keys(map).map(Number)
    return {
      cameras: { listCameraIds: async () => cameraIds },
      linkedDevices: makeLinkedClient(map),
      linkedDevicesBatch: {
        getLinkedDevicesBatch: async ({ deviceIds }) =>
          deviceIds.map((deviceId) => ({ deviceId, devices: map[deviceId] ?? [] })),
      },
    }
  }

  describe('LinkedCamerasCache — every linking camera, opt-in or not', () => {
    it('allCamerasFor ignores producesTrackedEvents; camerasFor keeps honouring it', async () => {
      const cache = new LinkedCamerasCache({
        cameras: { listCameraIds: async () => [101, 102] },
        linkedDevices: { getLinkedDevices: async () => ({ mode: 'auto' as const, devices: [] }) },
        linkedDevicesBatch: {
          getLinkedDevicesBatch: async () => [
            { deviceId: 101, devices: [linked(3243, true)] },
            { deviceId: 102, devices: [linked(3243, false)] },
          ],
        },
      })
      expect(await cache.camerasFor(3243)).toEqual([101])
      expect(await cache.allCamerasFor(3243)).toEqual([101, 102])
    })
  })

  describe('resolveLinkedMediaCameras', () => {
    it('puts a self-emitting camera first, then every linking camera, without duplicates', async () => {
      const cache = new LinkedCamerasCache(
        depsFor({ 101: [linked(101, false)], 102: [linked(101, false)] }),
      )
      expect(
        await resolveLinkedMediaCameras(cache, { deviceId: 101, capName: 'doorbell' }),
      ).toEqual([101, 102])
    })

    it('answers [] for a sensor no camera links', async () => {
      const cache = new LinkedCamerasCache(depsFor({ 101: [] }))
      expect(
        await resolveLinkedMediaCameras(cache, { deviceId: 3243, capName: 'contact' }),
      ).toEqual([])
    })
  })
})
