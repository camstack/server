/**
 * The tracker is fed by events. It reads the hub only to HYDRATE and to
 * CONFIRM a destructive verdict, and a verdict that would destroy work needs
 * two reads to agree (D49). Every entry point runs on ONE promise chain, so an
 * event never loses to a hydration in flight (R3).
 */
import { compositionSliceKey, ROOM_EXAMPLE_TEMPERATURE_SOURCES } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { SourceTracker } from '../source-tracker.js'
import { FakeHub, type RecordingLogger, recordingLogger } from './fixtures.js'

const T1 = ROOM_EXAMPLE_TEMPERATURE_SOURCES[0]!
const SOFA = ROOM_EXAMPLE_TEMPERATURE_SOURCES[1]!
const CELSIUS = { source: T1, cap: 'temperature-sensor', fieldPath: 'celsius' }
const REQUEST = [{ ref: T1, caps: ['temperature-sensor'] }]

let hub: FakeHub
let tracker: SourceTracker
let log: RecordingLogger

beforeEach(() => {
  hub = new FakeHub()
  hub.add(T1, 11, {
    'temperature-sensor': { celsius: 21, lastFetchedAt: 1 },
    'device-status': { online: true, lastChangedAt: 1 },
  })
  log = recordingLogger()
  tracker = new SourceTracker(hub.ports(log.logger))
})

describe('hydration', () => {
  it('reads each source once and serves the value fresh', async () => {
    const changed = await tracker.sync(REQUEST, new Set())
    expect(changed).toEqual(new Set([compositionSliceKey(T1, 'temperature-sensor')]))
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 21 })
  })

  it('reads NOTHING on an event: no polling', async () => {
    await tracker.sync(REQUEST, new Set())
    const before = hub.calls.length
    await tracker.onStateChanged(11, 'temperature-sensor', { celsius: 22, lastFetchedAt: 2 })
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 22 })
    expect(hub.calls.length).toBe(before)
  })

  it('a source that never reported is unavailable, not fatal', async () => {
    hub.setSlice(11, 'temperature-sensor', {})
    await tracker.sync(REQUEST, new Set())
    expect(tracker.read(CELSIUS)).toMatchObject({ state: 'unavailable', fatal: false })
  })

  it('a resolved source is NOT re-read on the next sync — a value it has not reported yet arrives by event (R7c)', async () => {
    hub.clearSlice(11, 'temperature-sensor') // bound, but it has never reported
    await tracker.sync(REQUEST, new Set())
    expect(tracker.read(CELSIUS)).toMatchObject({
      state: 'unavailable',
      fatal: false,
      reason: expect.stringContaining('has not reported'),
    })
    const before = hub.calls.length
    await tracker.sync(REQUEST, new Set())
    expect(hub.calls.length).toBe(before)
    await tracker.onStateChanged(11, 'temperature-sensor', { celsius: 22, lastFetchedAt: 2 })
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 22 })
  })
})

describe('stale keeps the last value (D49)', () => {
  it('an offline device makes the reading stale, value kept', async () => {
    await tracker.sync(REQUEST, new Set())
    await tracker.onStateChanged(11, 'device-status', { online: false, lastChangedAt: 2 })
    expect(tracker.read(CELSIUS)).toEqual({
      state: 'stale',
      value: 21,
      reason: expect.stringContaining('offline'),
    })
  })
})

describe('a cap removed at runtime is UNAVAILABLE, never a stale number (spec §2, D393, R7b)', () => {
  it('a provider unregistering the cap makes it unavailable, not fatal — CONFIRMED by one bindings re-read; re-registering reads it fresh', async () => {
    await tracker.sync(REQUEST, new Set())
    hub.unbind(11, 'temperature-sensor')
    const before = hub.calls.length
    await tracker.onBindingsChanged(11, 'temperature-sensor', 'native-unregistered')
    expect(hub.calls.slice(before)).toEqual(['bindings:11'])
    expect(tracker.read(CELSIUS)).toMatchObject({
      state: 'unavailable',
      fatal: false,
      confirmed: true,
      reason: expect.stringContaining('unregistered `temperature-sensor`'),
    })
    hub.bind(11, 'temperature-sensor')
    hub.setSlice(11, 'temperature-sensor', { celsius: 23, lastFetchedAt: 3 })
    await tracker.onBindingsChanged(11, 'temperature-sensor', 'native-registered')
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 23 })
  })

  it('an unregistration the bindings re-read could NOT confirm: no value, and NOT confirmed (D49) — nothing may be released on it', async () => {
    await tracker.sync(REQUEST, new Set())
    hub.failBindings(11)
    await tracker.onBindingsChanged(11, 'temperature-sensor', 'native-unregistered')
    const reading = tracker.read(CELSIUS)
    expect(reading).toMatchObject({ state: 'unavailable', fatal: false, confirmed: false })
  })

  it('an unregistration the bindings re-read CONTRADICTS (still bound): the event is stale, the value is re-read', async () => {
    await tracker.sync(REQUEST, new Set())
    hub.setSlice(11, 'temperature-sensor', { celsius: 24, lastFetchedAt: 4 })
    await tracker.onBindingsChanged(11, 'temperature-sensor', 'native-unregistered')
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 24 })
  })

  it('first reads are never an answer: a cap not bound yet, an empty read, a failed read are all unconfirmed', async () => {
    hub.unbind(11, 'temperature-sensor')
    await tracker.sync(REQUEST, new Set())
    expect(tracker.read(CELSIUS)).toMatchObject({ state: 'unavailable', confirmed: false })
    const empty = new SourceTracker(hub.ports(log.logger))
    hub.bind(11, 'temperature-sensor')
    hub.clearSlice(11, 'temperature-sensor')
    await empty.sync(REQUEST, new Set())
    expect(empty.read(CELSIUS)).toMatchObject({ state: 'unavailable', confirmed: false })
    const failed = new SourceTracker(hub.ports(log.logger))
    hub.failSlice(11, 'temperature-sensor')
    await failed.sync(REQUEST, new Set())
    expect(failed.read(CELSIUS)).toMatchObject({ state: 'unavailable', confirmed: false })
  })
})

describe('one promise chain: an event never loses to a hydration in flight (R3)', () => {
  it('a state event that arrives during a slow sync survives it', async () => {
    await tracker.sync(REQUEST, new Set())
    let release: () => void = () => undefined
    hub.slowRead = new Promise<void>((resolve) => {
      release = resolve
    })
    hub.add(SOFA, 12, { 'temperature-sensor': { celsius: 19, lastFetchedAt: 1 } })
    const syncing = tracker.sync(
      [...REQUEST, { ref: SOFA, caps: ['temperature-sensor'] }],
      new Set(),
    )
    const event = tracker.onStateChanged(11, 'temperature-sensor', {
      celsius: 25,
      lastFetchedAt: 5,
    })
    release()
    await syncing
    await event
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 25 })
    expect(tracker.read({ source: SOFA, cap: 'temperature-sensor', fieldPath: 'celsius' })).toEqual(
      { state: 'fresh', value: 19 },
    )
  })
})

describe('gone needs two reads to agree (D49), and then it is sticky', () => {
  it('ONE absent read then present: nothing changes', async () => {
    await tracker.sync(REQUEST, new Set())
    hub.scriptedLists.set(T1.addonId, [{ kind: 'rows', rows: [] }])
    await tracker.onDeviceUnregistered(11)
    expect(tracker.read(CELSIUS).state).toBe('fresh')
  })

  it('an UNREADABLE index changes nothing', async () => {
    await tracker.sync(REQUEST, new Set())
    hub.scriptedLists.set(T1.addonId, [{ kind: 'unreadable', error: 'timeout' }])
    await tracker.onDeviceUnregistered(11)
    expect(tracker.read(CELSIUS).state).toBe('fresh')
  })

  it('two absent reads: fatal, naming the source — and it stays so when the device returns', async () => {
    await tracker.sync(REQUEST, new Set())
    hub.remove(T1)
    await tracker.onDeviceUnregistered(11)
    expect(tracker.read(CELSIUS)).toEqual({
      state: 'unavailable',
      fatal: true,
      reason: expect.stringContaining('sensor.living_room_temperature'),
    })
    hub.add(T1, 12, { 'temperature-sensor': { celsius: 20, lastFetchedAt: 4 } })
    await tracker.sync(REQUEST, new Set())
    expect(tracker.read(CELSIUS)).toMatchObject({ state: 'unavailable', fatal: true })
  })

  it('an operator reset re-resolves it', async () => {
    await tracker.sync(REQUEST, new Set())
    hub.remove(T1)
    await tracker.onDeviceUnregistered(11)
    hub.add(T1, 12, { 'temperature-sensor': { celsius: 20, lastFetchedAt: 4 } })
    await tracker.sync(REQUEST, new Set(['provider-homeassistant/sensor.living_room_temperature']))
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 20 })
  })
})

describe('a (re)registration re-reads the source: a dropped event is reconciled, no timer (R7c, D8)', () => {
  it('a state event the bus dropped is reconciled when the provider re-registers the cap', async () => {
    await tracker.sync(REQUEST, new Set())
    hub.setSlice(11, 'temperature-sensor', { celsius: 24, lastFetchedAt: 6 }) // the event never arrived
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 21 })
    const changed = await tracker.onBindingsChanged(11, 'temperature-sensor', 'native-registered')
    expect(changed).toEqual(new Set([compositionSliceKey(T1, 'temperature-sensor')]))
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 24 })
  })

  it('a dropped offline event is reconciled when `device-status` re-registers', async () => {
    await tracker.sync(REQUEST, new Set())
    hub.setSlice(11, 'device-status', { online: false, lastChangedAt: 6 }) // the event never arrived
    await tracker.onBindingsChanged(11, 'device-status', 'native-registered')
    expect(tracker.read(CELSIUS)).toEqual({
      state: 'stale',
      value: 21,
      reason: expect.stringContaining('offline'),
    })
  })

  it('a source found under a NEW id after an unregister is re-read at once', async () => {
    await tracker.sync(REQUEST, new Set())
    hub.remove(T1)
    hub.add(T1, 12, {
      'temperature-sensor': { celsius: 30, lastFetchedAt: 7 },
      'device-status': { online: true, lastChangedAt: 7 },
    })
    await tracker.onDeviceUnregistered(11)
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 30 })
    await tracker.onStateChanged(12, 'temperature-sensor', { celsius: 31, lastFetchedAt: 8 })
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 31 })
  })

  it('a registration of a device the tracker does not follow reads nothing', async () => {
    await tracker.sync(REQUEST, new Set())
    const before = hub.calls.length
    await tracker.onBindingsChanged(99, 'temperature-sensor', 'native-registered')
    expect(hub.calls.length).toBe(before)
  })
})

describe('logs about a device carry its numeric id', () => {
  it('the removal verdict is tagged with the device id', async () => {
    await tracker.sync(REQUEST, new Set())
    hub.remove(T1)
    await tracker.onDeviceUnregistered(11)
    const removal = log.lines.find((l) => l.message.includes('composition source removed'))
    expect(removal?.extras?.tags).toEqual({ deviceId: 11 })
  })
})

describe('an UNBOUND cap on a device that exists is not a gone source (D49, R7b)', () => {
  it('is unavailable NON-fatal, and `native-registered` serves it', async () => {
    hub.add(T1, 11, { battery: { percentage: 50 } }) // the row exists; the cap is not bound yet
    await tracker.sync(REQUEST, new Set())
    expect(tracker.read(CELSIUS)).toMatchObject({
      state: 'unavailable',
      fatal: false,
      reason: expect.stringContaining('not bound'),
    })
    hub.setSlice(11, 'temperature-sensor', { celsius: 26, lastFetchedAt: 9 })
    await tracker.onBindingsChanged(11, 'temperature-sensor', 'native-registered')
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 26 })
  })

  it('logs the transition into unbound ONCE, tagged with the source device, and logs the heal (D391)', async () => {
    hub.add(T1, 11, { battery: { percentage: 50 } })
    await tracker.sync(REQUEST, new Set())
    await tracker.sync(REQUEST, new Set())
    for (let i = 0; i < 3; i++) tracker.read(CELSIUS)
    const unbound = log.lines.filter((l) => l.message.includes('not bound'))
    expect(unbound).toHaveLength(1)
    expect(unbound[0]).toMatchObject({
      level: 'warn',
      extras: { tags: { deviceId: 11 }, meta: { cap: 'temperature-sensor' } },
    })
    expect(unbound[0]?.extras?.meta?.['reason']).toEqual(
      expect.stringContaining('waiting for `native-registered`'),
    )
    hub.setSlice(11, 'temperature-sensor', { celsius: 26, lastFetchedAt: 9 })
    await tracker.onBindingsChanged(11, 'temperature-sensor', 'native-registered')
    const healed = log.lines.filter((l) => l.message.includes('served again'))
    expect(healed).toHaveLength(1)
    expect(healed[0]).toMatchObject({
      level: 'info',
      extras: {
        tags: { deviceId: 11 },
        meta: { cap: 'temperature-sensor', via: 'native-registered' },
      },
    })
  })
})

describe('a resolved source picks up a cap it was not asked for before', () => {
  it('reads the new cap only — the tracked one is not re-read', async () => {
    hub.add(T1, 11, {
      'temperature-sensor': { celsius: 21, lastFetchedAt: 1 },
      'device-status': { online: true, lastChangedAt: 1 },
      battery: { percentage: 50 },
    })
    await tracker.sync(REQUEST, new Set())
    const before = hub.calls.length
    const changed = await tracker.sync(
      [{ ref: T1, caps: ['temperature-sensor', 'battery'] }],
      new Set(),
    )
    expect(changed).toEqual(new Set([compositionSliceKey(T1, 'battery')]))
    expect(tracker.read({ source: T1, cap: 'battery', fieldPath: 'percentage' })).toEqual({
      state: 'fresh',
      value: 50,
    })
    expect(hub.calls.slice(before)).toEqual(['bindings:11', 'slice:11#battery'])
  })
})

describe('a re-read never destroys a held value on one empty answer (D49)', () => {
  it('a wrapper toggle whose re-read finds no report keeps the value, stale', async () => {
    await tracker.sync(REQUEST, new Set())
    hub.clearSlice(11, 'temperature-sensor')
    await tracker.onBindingsChanged(11, 'temperature-sensor', 'wrapper-activated')
    expect(tracker.read(CELSIUS)).toEqual({
      state: 'stale',
      value: 21,
      reason: expect.stringContaining('no `temperature-sensor` report'),
    })
    await tracker.onStateChanged(11, 'temperature-sensor', { celsius: 22, lastFetchedAt: 2 })
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 22 })
  })

  it('`wrapper-deactivated` re-reads the store, the authority', async () => {
    await tracker.sync(REQUEST, new Set())
    hub.setSlice(11, 'temperature-sensor', { celsius: 27, lastFetchedAt: 9 })
    await tracker.onBindingsChanged(11, 'temperature-sensor', 'wrapper-deactivated')
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 27 })
  })

  it('under a new id, an unreadable slice keeps the last value stale and an unknown `online` keeps the last one', async () => {
    await tracker.sync(REQUEST, new Set())
    await tracker.onStateChanged(11, 'device-status', { online: false, lastChangedAt: 2 })
    hub.remove(T1)
    hub.add(T1, 12, {})
    hub.failSlice(12, 'temperature-sensor')
    hub.failSlice(12, 'device-status')
    await tracker.onDeviceUnregistered(11)
    expect(tracker.read(CELSIUS)).toEqual({
      state: 'stale',
      value: 21,
      reason: expect.stringContaining('re-read failed'),
    })
    await tracker.onStateChanged(12, 'temperature-sensor', { celsius: 23, lastFetchedAt: 3 })
    expect(tracker.read(CELSIUS)).toEqual({
      state: 'stale',
      value: 23,
      reason: expect.stringContaining('offline'),
    })
  })
})

describe('no silent drop (D391)', () => {
  it('a hydration whose device index is unreadable says so', async () => {
    hub.scriptedLists.set(T1.addonId, [{ kind: 'unreadable', error: 'timeout' }])
    await tracker.sync(REQUEST, new Set())
    expect(tracker.read(CELSIUS)).toMatchObject({ state: 'unavailable', fatal: false })
    expect(
      log.lines.some(
        (l) =>
          l.level === 'warn' &&
          l.extras?.meta?.['source'] === 'provider-homeassistant/sensor.living_room_temperature',
      ),
    ).toBe(true)
  })
})

describe('the NATIVE view of a target device (D663, rule 6)', () => {
  const NATIVE_CELSIUS = { source: T1, cap: 'temperature-sensor', fieldPath: 'celsius' }
  const OWNED = [{ ref: T1, caps: [], nativeCaps: ['temperature-sensor'], nativeOwner: 'b1' }]

  it('a native-view cap is hydrated from the native shadow, not the merge', async () => {
    await tracker.sync(OWNED, new Set())
    expect(hub.calls).toContain('native:11#temperature-sensor')
    expect(hub.calls).not.toContain('slice:11#temperature-sensor')
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toEqual({ state: 'fresh', value: 21 })
  })

  it('a cap whose claim has LANDED ignores `device.state-changed` (its own merge) and takes `device.native-shadow-changed`', async () => {
    await tracker.sync(OWNED, new Set())
    await tracker.claimEvent(11, 'temperature-sensor', 'b1', 'held')
    const ignored = await tracker.onStateChanged(11, 'temperature-sensor', {
      celsius: 99,
      lastFetchedAt: 2,
    })
    expect(ignored).toEqual(new Set())
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toEqual({ state: 'fresh', value: 21 })
    const taken = await tracker.onNativeChanged(11, 'temperature-sensor', {
      celsius: 22,
      lastFetchedAt: 3,
    })
    expect(taken).toEqual(new Set([compositionSliceKey(T1, 'temperature-sensor')]))
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toEqual({ state: 'fresh', value: 22 })
  })

  it('a native-view cap the composition does NOT own takes `device.state-changed` as the native — no shadow ever comes for it', async () => {
    await tracker.sync([{ ref: T1, caps: [], nativeCaps: ['temperature-sensor'] }], new Set())
    await tracker.onStateChanged(11, 'temperature-sensor', { celsius: 23, lastFetchedAt: 2 })
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toEqual({ state: 'fresh', value: 23 })
  })

  it("held follows the block's OWN claim as the hub answers it (C-1, N-1, N-4)", async () => {
    await tracker.sync(OWNED, new Set())
    await tracker.onStateChanged(11, 'temperature-sensor', { celsius: 23, lastFetchedAt: 2 })
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toEqual({ state: 'fresh', value: 23 })
    // The claim RPC is in flight: the hub already merges, so state-changed is neither native nor composed (N-1).
    await tracker.claimEvent(11, 'temperature-sensor', 'b1', 'claiming')
    const during = await tracker.onStateChanged(11, 'temperature-sensor', {
      celsius: 99,
      lastFetchedAt: 3,
    })
    expect(during).toEqual(new Set())
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toEqual({ state: 'fresh', value: 23 })
    // The answer re-reads the native once.
    hub.setSlice(11, 'temperature-sensor', { celsius: 24, lastFetchedAt: 3 })
    const before = hub.calls.length
    const landed = await tracker.claimEvent(11, 'temperature-sensor', 'b1', 'held')
    expect(hub.calls.slice(before)).toEqual(['native:11#temperature-sensor'])
    expect(landed).toEqual(new Set([compositionSliceKey(T1, 'temperature-sensor')]))
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toEqual({ state: 'fresh', value: 24 })
    await tracker.onStateChanged(11, 'temperature-sensor', { celsius: 98, lastFetchedAt: 4 })
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toEqual({ state: 'fresh', value: 24 })
    // ANOTHER owner's claim never touches this block's readings (N-7).
    await tracker.claimEvent(11, 'temperature-sensor', 'b2', 'free')
    expect(hub.calls.slice(before)).toHaveLength(1)
    // Released: re-read once (N-4), then state-changed IS the native again.
    hub.setSlice(11, 'temperature-sensor', { celsius: 26, lastFetchedAt: 5 })
    await tracker.claimEvent(11, 'temperature-sensor', 'b1', 'free')
    expect(hub.calls.slice(before)).toHaveLength(2)
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toEqual({ state: 'fresh', value: 26 })
    await tracker.onStateChanged(11, 'temperature-sensor', { celsius: 25, lastFetchedAt: 6 })
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toEqual({ state: 'fresh', value: 25 })
  })

  it("another block's claim, or an `add` claim, in the boot seed never makes THIS block's cap held (N-7)", async () => {
    tracker.seedClaims([
      {
        deviceId: 11,
        capName: 'temperature-sensor',
        owner: 'other',
        mode: 'replace',
        fields: ['celsius'],
      },
      {
        deviceId: 11,
        capName: 'temperature-sensor',
        owner: 'b1',
        mode: 'add',
        fields: ['celsius'],
      },
    ])
    await tracker.sync(OWNED, new Set())
    await tracker.onStateChanged(11, 'temperature-sensor', { celsius: 30, lastFetchedAt: 7 })
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toEqual({ state: 'fresh', value: 30 })
  })

  it('a native read that FAILED is `unread` — unavailable, unconfirmed — and re-read by the next sync (D49)', async () => {
    hub.failSlice(11, 'temperature-sensor')
    await tracker.sync(OWNED, new Set())
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toMatchObject({
      state: 'unavailable',
      fatal: false,
      confirmed: false,
      reason: expect.stringContaining('could not be read'),
    })
    hub.healSlice(11, 'temperature-sensor')
    const changed = await tracker.sync(OWNED, new Set())
    expect(changed).toEqual(new Set([compositionSliceKey(T1, 'temperature-sensor')]))
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toEqual({ state: 'fresh', value: 21 })
  })

  it('a shadow for a cap tracked only in the effective view changes nothing', async () => {
    await tracker.sync(REQUEST, new Set())
    const changed = await tracker.onNativeChanged(11, 'temperature-sensor', {
      celsius: 40,
      lastFetchedAt: 9,
    })
    expect(changed).toEqual(new Set())
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 21 })
  })

  it('`native-registered` re-reads a native-view cap in its own view (R7c)', async () => {
    await tracker.sync(OWNED, new Set())
    hub.setSlice(11, 'temperature-sensor', { celsius: 25, lastFetchedAt: 6 })
    const before = hub.calls.length
    await tracker.onBindingsChanged(11, 'temperature-sensor', 'native-registered')
    expect(hub.calls.slice(before)).toEqual(['native:11#temperature-sensor'])
    expect(tracker.read(NATIVE_CELSIUS, 'native')).toEqual({ state: 'fresh', value: 25 })
  })
})

describe('resolving a target row through the same path as a source (D663, rule 1/5)', () => {
  it('finds the row with its type, once; a second resolve reads nothing', async () => {
    expect(await tracker.resolve(T1, false)).toEqual({
      kind: 'found',
      deviceId: 11,
      type: 'sensor',
    })
    const before = hub.calls.length
    expect(await tracker.resolve(T1, false)).toMatchObject({ kind: 'found', deviceId: 11 })
    expect(hub.calls.length).toBe(before)
    expect(tracker.resolution(T1)).toMatchObject({ kind: 'found', deviceId: 11 })
  })

  it('an unreadable index is unknown, retried by the next resolve; two absent reads are missing, sticky until reset', async () => {
    hub.scriptedLists.set(T1.addonId, [{ kind: 'unreadable', error: 'timeout' }])
    expect(await tracker.resolve(T1, false)).toMatchObject({ kind: 'unknown' })
    expect(await tracker.resolve(T1, false)).toMatchObject({ kind: 'found', deviceId: 11 })
    hub.remove(T1)
    await tracker.onDeviceUnregistered(11)
    expect(tracker.resolution(T1)).toMatchObject({ kind: 'missing' })
    hub.add(T1, 12, { 'temperature-sensor': { celsius: 20, lastFetchedAt: 4 } })
    expect(await tracker.resolve(T1, false)).toMatchObject({ kind: 'missing' })
    expect(await tracker.resolve(T1, true)).toMatchObject({ kind: 'found', deviceId: 12 })
  })

  it('an operator reset re-resolves the row WITHOUT dropping what is held for the same id (M-2): no bare entry mid-apply', async () => {
    await tracker.sync(REQUEST, new Set())
    await tracker.resolve(T1, true)
    expect(tracker.read(CELSIUS)).toEqual({ state: 'fresh', value: 21 })
  })

  it('a ref never resolved is unknown, by name', () => {
    expect(tracker.resolution(SOFA)).toMatchObject({ kind: 'unknown' })
  })
})
