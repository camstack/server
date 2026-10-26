// packages/system/src/builtins/composer/__tests__/source-deleted.spec.ts
/**
 * Spec §2 "Source deleted": the field becomes UNAVAILABLE (never 0 or a
 * plausible number, D393), the block goes FAILED naming the missing source,
 * and ONLY the operator ends it. No timer, no silent re-pointing, no
 * auto-repair — the source reappearing changes nothing until the operator acts.
 * The composed device itself is NOT deleted by a source deletion.
 *
 * Drives the real `Composer` + `SourceTracker` + `CompositionRuntime`.
 */
import {
  type ComposerApplyInput,
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ComposedDeviceHandle } from '../composed-device.js'
import { Composer } from '../composer.js'
import { SourceTracker } from '../source-tracker.js'
import {
  FakeHub,
  FakeTarget,
  FakeTimer,
  LOOKUP_CAP,
  type RecordingLogger,
  recordingLogger,
} from './fixtures.js'

const ROOM = roomCompositionExample({
  temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
  occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
})
const SOFA = ROOM_EXAMPLE_TEMPERATURE_SOURCES[1]!
const SOFA_ID = 12
const SOFA_NEW_ID = 31
const COMPOSED_ID = 1901
const COMPOSED_STABLE_ID = 'composed-b1'

let hub: FakeHub
let target: FakeTarget
let log: RecordingLogger
let composer: Composer
let declared: string[][]
let decommissioned: number[]
let timers: FakeTimer[]

function input(updatedAt = 1, restartBlockIds: readonly string[] = []): ComposerApplyInput {
  return {
    integrationId: 'int_blocks',
    storeLoaded: true,
    blocks: [{ id: 'b1', name: 'Living room', enabled: true, updatedAt, composition: ROOM }],
    restartBlockIds: [...restartBlockIds],
    unreadableBlocks: [],
  }
}

function celsiusState(): unknown {
  return composer.getStates(['b1'])[0]?.fields.find((f) => f.path === 'celsius')
}

/** Every `celsius` value the composed device was asked to hold. */
function celsiusWrites(): readonly unknown[] {
  return target.writes.flatMap((w) =>
    w.cap === 'temperature-sensor' && 'celsius' in w.values ? [w.values['celsius']] : [],
  )
}

beforeEach(async () => {
  hub = new FakeHub()
  ROOM_EXAMPLE_TEMPERATURE_SOURCES.forEach((ref, i) =>
    hub.add(ref, 11 + i, {
      'temperature-sensor': { celsius: [21.0, 21.5, 21.4][i], lastFetchedAt: 990_000 + i },
    }),
  )
  ROOM_EXAMPLE_MOTION_SOURCES.forEach((ref, i) =>
    hub.add(ref, 21 + i, {
      motion: { detected: false, lastDetectedAt: null, autoClearAfterMs: null },
    }),
  )
  target = new FakeTarget(COMPOSED_ID)
  log = recordingLogger()
  declared = []
  decommissioned = []
  timers = []
  composer = new Composer({
    logger: log.logger,
    tracker: new SourceTracker(hub.ports(log.logger)),
    lookupCap: LOOKUP_CAP,
    // The composed row already exists (a hub that ran this block before): the seed is trusted at once.
    readPersisted: async () => [{ id: COMPOSED_ID, stableId: COMPOSED_STABLE_ID }],
    declare: async (_integrationId, devices) => {
      declared.push(devices.map((d) => d.stableId))
      return {
        devices: new Map<string, ComposedDeviceHandle>(
          devices.some((d) => d.stableId === COMPOSED_STABLE_ID)
            ? [[COMPOSED_STABLE_ID, target]]
            : [],
        ),
      }
    },
    devices: {
      setName: async () => undefined,
      decommission: async (id) => {
        decommissioned.push(id)
      },
      applyDerivedSpec: async () => undefined,
    },
    claims: hub.claimsApi(),
    events: { emit: () => undefined },
    readExistingTargetCap: async (deviceId, capName) => hub.effective(deviceId, capName) ?? null,
    describeTarget: hub.ports(log.logger).readBoundCaps,
    now: () => 1_000_000,
    newTimer: () => {
      const timer = new FakeTimer()
      timers.push(timer)
      return timer
    },
  })
  const boot = await composer.apply(input())
  // Precondition: the block really runs before anything is deleted.
  expect(boot.blocks[0]).toEqual({ blockId: 'b1', status: 'running' })
  expect(celsiusState()).toMatchObject({ state: 'fresh', value: 21.3 })
})

it('a single failed confirmation changes nothing (D49)', async () => {
  // The first index read misses the sofa; the confirming read still finds it under its id.
  hub.scriptedLists.set(SOFA.addonId, [{ kind: 'rows', rows: [] }])
  await composer.onDeviceUnregistered(SOFA_ID)
  expect(hub.scriptedLists.get(SOFA.addonId)).toEqual([])
  expect((await composer.apply(input())).blocks[0]).toEqual({ blockId: 'b1', status: 'running' })
  expect(celsiusState()).toMatchObject({ state: 'fresh', value: 21.3 })
  expect(target.availability.at(-1)).toBe(true)
})

describe('the sofa sensor is deleted', () => {
  let celsiusWritesBefore: readonly unknown[] = []

  beforeEach(async () => {
    celsiusWritesBefore = celsiusWrites()
    hub.remove(SOFA)
    await composer.onDeviceUnregistered(SOFA_ID)
  })

  it('celsius is unavailable — null in the state, never a number — and the device goes offline', () => {
    expect(celsiusState()).toMatchObject({ state: 'unavailable', value: null })
    expect(target.availability.at(-1)).toBe(false)
    // D944 §4 made `celsius` nullable: a refused sample is null (D393). The
    // composer therefore writes that null, so the device state cannot keep
    // the stale 21.3. One null, after the boot average — not a second number.
    expect(celsiusWritesBefore).toEqual([21.3])
    expect(celsiusWrites()).toEqual([21.3, null])
  })

  it('the block is FAILED and the reason names the source', async () => {
    const result = await composer.apply(input())
    expect(result.blocks[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('sensor.sofa_temperature'),
    })
    expect(composer.getStates(['b1'])[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('sensor.sofa_temperature'),
    })
  })

  it('logs the failure with the composed device tag', () => {
    const line = log.lines.find(
      (l) => l.level === 'error' && l.message.includes('a source is gone'),
    )
    expect(line?.extras?.tags).toEqual({ deviceId: COMPOSED_ID })
  })

  it('the composed device is NOT deleted: it stays declared and is never decommissioned', async () => {
    await composer.apply(input())
    await composer.apply(input())
    expect(declared.every((d) => d.includes(COMPOSED_STABLE_ID))).toBe(true)
    expect(decommissioned).toEqual([])
    expect(composer.getStates(['b1'])[0]?.deviceId).toBe(COMPOSED_ID)
  })

  it('occupancy keeps flowing: unavailable is per field, never global', async () => {
    await composer.onStateChanged({
      deviceId: 21,
      capName: 'motion',
      slice: { detected: true, lastDetectedAt: 1_000_000, autoClearAfterMs: null },
    })
    expect(composer.getStates(['b1'])[0]?.fields.find((f) => f.path === 'on')).toMatchObject({
      state: 'fresh',
      value: true,
    })
  })

  it('no timer ends it: firing every armed deadline leaves the block failed', async () => {
    for (const t of timers) if (t.armedAt !== null) t.trigger()
    expect((await composer.apply(input())).blocks[0]?.status).toBe('failed')
    expect(celsiusState()).toMatchObject({ state: 'unavailable', value: null })
  })

  it('NO auto-repair: the source coming back — events included — leaves the block failed', async () => {
    hub.add(SOFA, SOFA_NEW_ID, { 'temperature-sensor': { celsius: 20, lastFetchedAt: 999_000 } })
    await composer.onBindingsChanged({
      deviceId: SOFA_NEW_ID,
      capName: 'temperature-sensor',
      reason: 'native-registered',
      addonId: 'provider-homeassistant',
    })
    await composer.onStateChanged({
      deviceId: SOFA_NEW_ID,
      capName: 'temperature-sensor',
      slice: { celsius: 20, lastFetchedAt: 999_000 },
    })
    const result = await composer.apply(input())
    expect(result.blocks[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('sensor.sofa_temperature'),
    })
    expect(celsiusState()).toMatchObject({ state: 'unavailable', value: null })
    expect(target.availability.at(-1)).toBe(false)
  })

  it('only the operator ends it: an edit (new updatedAt) re-resolves and runs again', async () => {
    hub.add(SOFA, SOFA_NEW_ID, { 'temperature-sensor': { celsius: 21.5, lastFetchedAt: 999_000 } })
    const result = await composer.apply(input(2))
    expect(result.blocks[0]).toEqual({ blockId: 'b1', status: 'running' })
    expect(celsiusState()).toMatchObject({ state: 'fresh', value: 21.3 })
    expect(target.availability.at(-1)).toBe(true)
  })

  it('…or a restart', async () => {
    hub.add(SOFA, SOFA_NEW_ID, { 'temperature-sensor': { celsius: 21.5, lastFetchedAt: 999_000 } })
    const result = await composer.apply(input(1, ['b1']))
    expect(result.blocks[0]).toEqual({ blockId: 'b1', status: 'running' })
    expect(celsiusState()).toMatchObject({ state: 'fresh', value: 21.3 })
  })

  it('an operator edit while the source is STILL gone keeps the block failed, naming it', async () => {
    const result = await composer.apply(input(2))
    expect(result.blocks[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('sensor.sofa_temperature'),
    })
  })
})
