// packages/system/src/builtins/composer/__tests__/composer.spec.ts
import {
  type ComposerApplyInput,
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
} from '@camstack/types'
import type { DeviceDeclaration } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ComposedDeviceHandle } from '../composed-device.js'
import { ComposedPlaceholderDevice } from '../composed-device.js'
import type { PersistedComposedRow } from '../composition-declarations.js'
import { Composer, type ComposerDeclareResult } from '../composer.js'
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

function seedHub(hub: FakeHub): void {
  ROOM_EXAMPLE_TEMPERATURE_SOURCES.forEach((ref, i) =>
    hub.add(ref, 11 + i, {
      'temperature-sensor': { celsius: [21.0, 21.5, 21.4][i], lastFetchedAt: 990_000 + i },
      'device-status': { online: true, lastChangedAt: 1 },
    }),
  )
  ROOM_EXAMPLE_MOTION_SOURCES.forEach((ref, i) =>
    hub.add(ref, 21 + i, {
      motion: { detected: false, lastDetectedAt: null, autoClearAfterMs: null },
    }),
  )
}

let hub: FakeHub
let targets: Map<string, FakeTarget>
let declared: string[][]
let declarations: DeviceDeclaration[][]
let persisted: PersistedComposedRow[]
let persistedReads: number
let persistedFails: number
/** Answers for the NEXT persisted-row reads, consumed in order before `persisted`. */
let persistedScript: PersistedComposedRow[][]
let decommissionFails: number
let minted: number
let named: Array<readonly [number, string]>
let decommissioned: number[]
let composer: Composer
let log: RecordingLogger
let tracker: SourceTracker
/** Stable ids whose device `declare` does not build — a device that never came up. */
let unbuilt: Set<string>

function input(over: Partial<ComposerApplyInput> = {}): ComposerApplyInput {
  return {
    integrationId: 'int_blocks',
    storeLoaded: true,
    blocks: [{ id: 'b1', name: 'Living room', enabled: true, updatedAt: 1, composition: ROOM }],
    restartBlockIds: [],
    unreadableBlocks: [],
    ...over,
  }
}

function makeComposer(): Composer {
  log = recordingLogger()
  tracker = new SourceTracker(hub.ports(log.logger))
  return new Composer({
    logger: log.logger,
    tracker,
    lookupCap: LOOKUP_CAP,
    readPersisted: async () => {
      persistedReads += 1
      if (persistedFails > 0) {
        persistedFails -= 1
        throw new Error('registry cold')
      }
      return persistedScript.shift() ?? persisted
    },
    declare: async (_integrationId, devices): Promise<ComposerDeclareResult> => {
      declared.push(devices.map((d) => d.stableId))
      declarations.push([...devices])
      const handles = new Map<string, ComposedDeviceHandle>()
      for (const d of devices) {
        if (unbuilt.has(d.stableId)) continue
        const existing = targets.get(d.stableId) ?? new FakeTarget(1900 + minted++, d.name)
        targets.set(d.stableId, existing)
        handles.set(d.stableId, existing)
      }
      return { devices: handles }
    },
    devices: {
      setName: async (id, name) => {
        named.push([id, name])
      },
      decommission: async (id) => {
        if (decommissionFails > 0) {
          decommissionFails -= 1
          throw new Error('decommission refused')
        }
        decommissioned.push(id)
        for (const [stableId, t] of targets) if (t.id === id) targets.delete(stableId)
      },
      applyDerivedSpec: async () => undefined,
    },
    claims: hub.claimsApi(),
    events: { emit: () => undefined },
    readExistingTargetCap: async (deviceId, capName) => hub.effective(deviceId, capName) ?? null,
    describeTarget: hub.ports(log.logger).readBoundCaps,
    now: () => 1_000_000,
    newTimer: () => new FakeTimer(),
  })
}

beforeEach(async () => {
  hub = new FakeHub()
  seedHub(hub)
  targets = new Map()
  declared = []
  declarations = []
  persisted = []
  persistedReads = 0
  persistedFails = 0
  minted = 0
  named = []
  decommissioned = []
  persistedScript = []
  decommissionFails = 0
  unbuilt = new Set()
  composer = makeComposer()
  // A fresh hub: its own rows read `[]`, which one read does not confirm (D49).
  // This apply declares nothing; the next one's `[]` agrees and seeds.
  await composer.apply(input({ blocks: [] }))
  persistedReads = 0
})

describe('apply', () => {
  it('waits, by name, for the shared integration', async () => {
    const result = await composer.apply(input({ integrationId: null }))
    expect(result.blocks).toEqual([
      { blockId: 'b1', status: 'starting', reason: expect.stringContaining('Blocks integration') },
    ])
    expect(declared).toEqual([])
  })

  it('declares the room, runs it, and reports running', async () => {
    const result = await composer.apply(input())
    expect(declared).toEqual([['composed-b1']])
    expect(result.blocks).toEqual([{ blockId: 'b1', status: 'running' }])
    expect(result.acted).toBe(true)
    expect(targets.get('composed-b1')?.writes[0]).toMatchObject({
      cap: 'temperature-sensor',
      values: { celsius: 21.3 },
    })
  })

  it('does not re-declare on an unchanged apply', async () => {
    await composer.apply(input())
    await composer.apply(input())
    expect(declared).toHaveLength(1)
  })

  it('a disabled block keeps its device, offline, and reports stopped', async () => {
    const result = await composer.apply(
      input({
        blocks: [
          { id: 'b1', name: 'Living room', enabled: false, updatedAt: 1, composition: ROOM },
        ],
      }),
    )
    expect(result.blocks[0]).toMatchObject({ status: 'stopped' })
    expect(targets.get('composed-b1')?.availability.at(-1)).toBe(false)
  })

  it('the block name is the device name', async () => {
    await composer.apply(input())
    await composer.apply(
      input({
        blocks: [{ id: 'b1', name: 'Salotto', enabled: true, updatedAt: 2, composition: ROOM }],
      }),
    )
    expect(named).toEqual([[1900, 'Salotto']])
  })

  it('a block deleted is withdrawn only on the second apply that omits it (D49)', async () => {
    await composer.apply(input())
    await composer.apply(input({ blocks: [] }))
    expect(declared.at(-1)).toEqual(['composed-b1'])
    await composer.apply(input({ blocks: [] }))
    expect(declared.at(-1)).toEqual([])
  })

  it('declares and withdraws NOTHING while the store has not loaded — an empty boot apply would sweep every composed device (D49, R2)', async () => {
    // A composer that knows no device: `core_blocks` failed to read, the supervisor still owes its boot apply with zero blocks.
    const empty = await composer.apply(input({ storeLoaded: false, blocks: [] }))
    expect(empty.blocks).toEqual([])
    expect(declared).toEqual([])
    // The same read failure with a block in memory: named, not applied.
    const withBlock = await composer.apply(input({ storeLoaded: false }))
    expect(withBlock.blocks).toEqual([
      { blockId: 'b1', status: 'starting', reason: expect.stringContaining('has not loaded') },
    ])
    expect(declared).toEqual([])
    expect(named).toEqual([])
    // And once it has loaded, the omitted-twice rule starts from zero misses.
    await composer.apply(input())
    expect(declared).toEqual([['composed-b1']])
  })

  it('says the store has not loaded ONCE per transition, not on every apply', async () => {
    await composer.apply(input({ storeLoaded: false }))
    await composer.apply(input({ storeLoaded: false }))
    await composer.apply(input({ storeLoaded: false }))
    const waits = () =>
      log.lines.filter((l) => l.level === 'warn' && l.message.includes('has not loaded'))
    expect(waits()).toHaveLength(1)
    await composer.apply(input())
    const back = log.lines.filter((l) => l.level === 'info' && l.message.includes('has loaded'))
    expect(back).toHaveLength(1)
    expect(back[0]?.extras?.meta).toMatchObject({ appliesRefused: 3 })
    await composer.apply(input({ storeLoaded: false }))
    expect(waits()).toHaveLength(2)
  })

  it('says the Blocks integration is missing ONCE per transition, not on every apply', async () => {
    await composer.apply(input({ integrationId: null }))
    await composer.apply(input({ integrationId: null }))
    await composer.apply(input({ integrationId: null }))
    const waits = () =>
      log.lines.filter((l) => l.level === 'warn' && l.message.includes('Blocks integration'))
    expect(waits()).toHaveLength(1)
    await composer.apply(input())
    const back = log.lines.filter(
      (l) => l.level === 'info' && l.message.includes('Blocks integration has reconciled'),
    )
    expect(back).toHaveLength(1)
    expect(back[0]?.extras?.meta).toMatchObject({ appliesRefused: 3 })
    await composer.apply(input({ integrationId: null }))
    expect(waits()).toHaveLength(2)
  })

  it('an UNREADABLE stored composition keeps its device as a placeholder and fails naming the parse error — never absent (D49)', async () => {
    await composer.apply(input())
    expect(declared.at(-1)).toEqual(['composed-b1'])
    const unreadable = input({
      blocks: [],
      unreadableBlocks: [
        { id: 'b1', name: 'Living room', error: 'source.composition.features: Invalid input' },
      ],
    })
    await composer.apply(unreadable)
    const second = await composer.apply(unreadable)
    await composer.apply(unreadable)
    // Omitted three times would have withdrawn it; unreadable is not omitted.
    expect(declared.at(-1)).toEqual(['composed-b1'])
    expect(decommissioned.length).toBeLessThanOrEqual(1) // the shape change to a placeholder, at most
    expect(second.blocks).toEqual([
      {
        blockId: 'b1',
        status: 'failed',
        reason: expect.stringContaining('source.composition.features: Invalid input'),
      },
    ])
    // Readable again: it plans and runs on the same row.
    await composer.apply(input())
    expect(declared.at(-1)).toEqual(['composed-b1'])
  })

  it('after a RESTART, an unreadable composition with a persisted row is held, not swept', async () => {
    persisted = [{ id: 1950, stableId: 'composed-b1' }]
    composer = makeComposer()
    const unreadable = input({
      blocks: [],
      unreadableBlocks: [{ id: 'b1', name: null, error: 'bad row' }],
    })
    await composer.apply(unreadable)
    await composer.apply(unreadable)
    await composer.apply(unreadable)
    expect(declared.at(-1)).toEqual(['composed-b1'])
    expect(named).toEqual([]) // no readable name: the device keeps the one it has
  })

  it('getStates answers per field', async () => {
    await composer.apply(input())
    const [state] = composer.getStates(['b1'])
    expect(state).toMatchObject({ blockId: 'b1', deviceId: 1900, status: 'running' })
    expect(state?.fields.find((f) => f.path === 'celsius')).toMatchObject({
      state: 'fresh',
      value: 21.3,
    })
  })
})

/** The room with its temperature cap renamed — what a release that renames a cap leaves behind. */
function renamedCapRoom(): ComposerApplyInput['blocks'][number]['composition'] {
  return {
    ...ROOM,
    features: ROOM.features.map((f, i) => (i === 0 ? { ...f, cap: 'temperature-sensor-v2' } : f)),
  }
}

describe('persisted rows and placeholders', () => {
  it('seeds the gate from the persisted rows ONCE, before the first withdrawal decision', async () => {
    persisted = [{ id: 1950, stableId: 'composed-gone' }]
    composer = makeComposer()
    await composer.apply(input())
    // A restart is not the first miss: the row nobody planned is held, not swept.
    expect(declared.at(-1)).toEqual(['composed-b1', 'composed-gone'])
    expect(declarations.at(-1)?.[1]?.DeviceClass).toBe(ComposedPlaceholderDevice)
    await composer.apply(input())
    expect(declared.at(-1)).toEqual(['composed-b1'])
    expect(persistedReads).toBe(1)
  })

  it('a failed read of its own rows declares and withdraws nothing, and is retried', async () => {
    persisted = [{ id: 1950, stableId: 'composed-b1' }]
    persistedFails = 1
    composer = makeComposer()
    const first = await composer.apply(input())
    expect(first.blocks).toEqual([
      { blockId: 'b1', status: 'starting', reason: expect.stringContaining('could not be read') },
    ])
    // Store loaded, integration known — and still refused: the caller must not count it.
    expect(first.acted).toBe(false)
    expect(declared).toEqual([])
    await composer.apply(input())
    expect(declared).toEqual([['composed-b1']])
    expect(persistedReads).toBe(2)
  })

  it('a block whose row exists but whose composition no longer plans keeps its device as a placeholder, and fails by name', async () => {
    persisted = [{ id: 1950, stableId: 'composed-b1' }]
    composer = makeComposer()
    const result = await composer.apply(
      input({
        blocks: [
          {
            id: 'b1',
            name: 'Living room',
            enabled: true,
            updatedAt: 1,
            composition: renamedCapRoom(),
          },
        ],
      }),
    )
    expect(declared).toEqual([['composed-b1']])
    expect(declarations[0]?.[0]?.DeviceClass).toBe(ComposedPlaceholderDevice)
    expect(result.blocks[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('temperature-sensor-v2'),
    })
    expect(result.blocks[0]?.reason).toContain('kept offline')
    // No runtime ever runs on a placeholder: nothing is written to it.
    expect(targets.get('composed-b1')?.writes).toEqual([])
    expect(targets.get('composed-b1')?.availability).toEqual([])
    expect(composer.getStates(['b1'])[0]).toMatchObject({ status: 'failed', fields: [] })
  })

  it('a live block that stops planning is rebuilt as a placeholder, not withdrawn', async () => {
    await composer.apply(input())
    const result = await composer.apply(
      input({
        blocks: [
          {
            id: 'b1',
            name: 'Living room',
            enabled: true,
            updatedAt: 2,
            composition: renamedCapRoom(),
          },
        ],
      }),
    )
    expect(decommissioned).toEqual([1900])
    expect(declared.at(-1)).toEqual(['composed-b1'])
    expect(declarations.at(-1)?.[0]?.DeviceClass).toBe(ComposedPlaceholderDevice)
    expect(result.blocks[0]).toMatchObject({ status: 'failed' })
    expect(targets.get('composed-b1')?.writes).toEqual([])
  })

  it('a block that never planned and has no row declares nothing', async () => {
    const result = await composer.apply(
      input({
        blocks: [
          {
            id: 'b1',
            name: 'Living room',
            enabled: true,
            updatedAt: 1,
            composition: renamedCapRoom(),
          },
        ],
      }),
    )
    expect(declared).toEqual([[]])
    expect(result.blocks[0]).toMatchObject({ status: 'failed' })
    expect(result.blocks[0]?.reason).not.toContain('kept offline')
  })
})

describe('events', () => {
  it('a state change reaches the runtime once onStateChanged resolves (R3)', async () => {
    await composer.apply(input())
    const target = targets.get('composed-b1')
    const before = target?.writes.length ?? 0
    const slice = { celsius: 24.0, lastFetchedAt: 995_000 }
    hub.setSlice(11, 'temperature-sensor', slice)
    await composer.onStateChanged({ deviceId: 11, capName: 'temperature-sensor', slice })
    expect(target?.writes.slice(before)).toContainEqual(
      expect.objectContaining({
        cap: 'temperature-sensor',
        values: expect.objectContaining({ celsius: 22.3 }),
      }),
    )
  })
})

describe('an empty seed needs a second read to agree (D49)', () => {
  it('a cold [] then a warm read with the row of a block that no longer plans keeps the device as a placeholder', async () => {
    persistedScript = [[], [{ id: 1950, stableId: 'composed-b1' }]]
    composer = makeComposer()
    const broken = input({
      blocks: [
        {
          id: 'b1',
          name: 'Living room',
          enabled: true,
          updatedAt: 1,
          composition: renamedCapRoom(),
        },
      ],
    })
    const cold = await composer.apply(broken)
    expect(cold.blocks).toEqual([
      { blockId: 'b1', status: 'starting', reason: expect.stringContaining('read empty') },
    ])
    expect(declared).toEqual([])
    await composer.apply(broken)
    expect(declared).toEqual([['composed-b1']])
    expect(declarations[0]?.[0]?.DeviceClass).toBe(ComposedPlaceholderDevice)
  })

  it('two agreeing [] reads seed normally', async () => {
    composer = makeComposer()
    const first = await composer.apply(input())
    expect(first.blocks[0]).toMatchObject({ status: 'starting' })
    expect(declared).toEqual([])
    const second = await composer.apply(input())
    expect(declared).toEqual([['composed-b1']])
    expect(second.blocks).toEqual([{ blockId: 'b1', status: 'running' }])
    expect(persistedReads).toBe(2)
  })

  it('a failed read between two [] breaks the agreement', async () => {
    composer = makeComposer()
    await composer.apply(input())
    persistedFails = 1
    await composer.apply(input())
    const third = await composer.apply(input())
    expect(third.blocks[0]).toMatchObject({
      status: 'starting',
      reason: expect.stringContaining('read empty'),
    })
    expect(declared).toEqual([])
  })
})

describe('hardening', () => {
  it('a failed rebuild keeps the old device, fails by name, and is retried on the next apply', async () => {
    await composer.apply(input())
    decommissionFails = 1
    const broken = input({
      blocks: [
        {
          id: 'b1',
          name: 'Living room',
          enabled: true,
          updatedAt: 2,
          composition: renamedCapRoom(),
        },
      ],
    })
    const failed = await composer.apply(broken)
    expect(failed.blocks[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('rebuilding'),
    })
    expect(decommissioned).toEqual([])
    const retried = await composer.apply(broken)
    expect(decommissioned).toEqual([1900])
    expect(retried.blocks[0]?.reason).toContain('kept offline')
  })

  it('an operator restart rebuilds the runtime and re-resolves its sources on an unchanged block', async () => {
    await composer.apply(input())
    const target = targets.get('composed-b1')
    const seeds = target?.writes.filter((w) => w.op === 'seed').length ?? 0
    const lists = hub.calls.filter((c) => c.startsWith('list:')).length
    await composer.apply(input({ restartBlockIds: ['b1'] }))
    expect(target?.writes.filter((w) => w.op === 'seed').length).toBeGreaterThan(seeds)
    expect(hub.calls.filter((c) => c.startsWith('list:')).length).toBeGreaterThan(lists)
  })

  it('a block whose device never built does not re-open a source it shares with a healthy block (D3, no auto-repair)', async () => {
    const [T1] = ROOM_EXAMPLE_TEMPERATURE_SOURCES
    const celsius = { source: T1!, cap: 'temperature-sensor', fieldPath: 'celsius' }
    hub.remove(T1!)
    unbuilt = new Set(['composed-b1'])
    const both = input({
      blocks: [
        { id: 'b1', name: 'Kitchen', enabled: true, updatedAt: 1, composition: ROOM },
        { id: 'b2', name: 'Living room', enabled: true, updatedAt: 1, composition: ROOM },
      ],
    })
    await composer.apply(both)
    expect(targets.has('composed-b1')).toBe(false)
    expect(tracker.read(celsius)).toMatchObject({ state: 'unavailable', fatal: true })
    // The source comes back, but nothing the OPERATOR did happened: it stays gone.
    hub.add(T1!, 11, {
      'temperature-sensor': { celsius: 21.0, lastFetchedAt: 990_000 },
      'device-status': { online: true, lastChangedAt: 1 },
    })
    const lists = hub.calls.filter((c) => c.startsWith('list:')).length
    await composer.apply(both)
    await composer.apply(both)
    await composer.apply(both)
    expect(hub.calls.filter((c) => c.startsWith('list:')).length).toBe(lists)
    expect(tracker.read(celsius)).toMatchObject({ state: 'unavailable', fatal: true })
    expect(composer.getStates(['b2'])[0]?.fields.find((f) => f.path === 'celsius')).toMatchObject({
      state: 'unavailable',
    })
    // An operator restart of the unbuilt block is what re-opens it.
    await composer.apply({ ...both, restartBlockIds: ['b1'] })
    expect(hub.calls.filter((c) => c.startsWith('list:')).length).toBeGreaterThan(lists)
    expect(tracker.read(celsius)).toMatchObject({ state: 'fresh', value: 21.0 })
  })

  it('overlapping applies are serialized: one declaration, not two', async () => {
    const [a, b] = await Promise.all([composer.apply(input()), composer.apply(input())])
    expect(declared).toEqual([['composed-b1']])
    expect(a.blocks).toEqual(b.blocks)
  })
})
