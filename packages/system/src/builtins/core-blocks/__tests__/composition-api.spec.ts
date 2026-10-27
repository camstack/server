import {
  ALL_CAPABILITY_DEFINITIONS,
  buildCapabilityLookup,
  type Composition,
  type CompositionBlockState,
  type CompositionListRead,
  type CompositionSourceRef,
  type CompositionView,
  type CoreBlock,
  CompositionSchema,
  composedDeviceRef,
  composedDeviceStableId,
  DeviceType,
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { recordingLogger } from '../../composer/__tests__/fixtures.js'
import { buildCompositionApi, type CompositionApiDeps } from '../composition-api.js'
import {
  type BoundCapView,
  describeCompositionSources,
  type SourceRowView,
} from '../composition-sources.js'

const ROOM = roomCompositionExample({
  temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
  occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
})
const CALLER = { userId: 'admin-1', isAdmin: true }
const NOT_LOADED = 'core_blocks has not loaded yet'

let stored: CoreBlock[]
let converged: number
let loaded: boolean
let rows: Map<string, SourceRowView[]>
let bindings: Map<number, BoundCapView[]>

const HA = 'provider-homeassistant'
const FEEDER = { addonId: HA, stableId: 'ha:b:dev:8dec' }
const FEEDER_ID = 50
const OTHER = { addonId: HA, stableId: 'ha:b:dev:other' }
/** The ROOM's sources bind these; a device with no entry in `bindings` reads as them. */
const ROOM_SOURCE_BINDINGS: readonly BoundCapView[] = [
  { capName: 'temperature-sensor', nativeAddonId: HA },
  { capName: 'motion', nativeAddonId: HA },
]

/**
 * Battery ADDED to a sensor that already has native `binary` and lacks battery
 * (D944: Customize only adds a capability the device does not provide).
 * `level` reads that device's own native `binary.on` — a self-read of a
 * field this composition does not write, so it is not a graph edge (D663 rule 5).
 */
function addBattery(expr = 'on ? 100 : 0', device = FEEDER): Composition {
  return CompositionSchema.parse({
    target: { kind: 'existing', device },
    features: [
      {
        kind: 'fields',
        cap: 'battery',
        fields: {
          level: {
            kind: 'expression',
            expr,
            bindings: { on: { kind: 'from', source: device, cap: 'binary', fieldPath: 'on' } },
          },
          charging: { kind: 'expression', expr: '"unknown"', bindings: {} },
          sleeping: { kind: 'expression', expr: 'false', bindings: {} },
          lastUpdated: { kind: 'expression', expr: 'now', bindings: {} },
        },
      },
    ],
  })
}

/**
 * Replaces the feeder's native `binary`. D944 refuses this before it can be
 * stored, so a self-read of the field a customization replaces is unreachable
 * through the API (`planComposition` never emits mode `replace`).
 */
function invertFeeder(device = FEEDER): Composition {
  return CompositionSchema.parse({
    target: { kind: 'existing', device },
    features: [
      {
        kind: 'fields',
        cap: 'binary',
        fields: {
          on: {
            kind: 'expression',
            expr: '!on',
            bindings: { on: { kind: 'from', source: device, cap: 'binary', fieldPath: 'on' } },
          },
        },
      },
    ],
  })
}

/** The ROOM, with its temperature read from another device instead of its sensors. */
function celsiusFrom(source: CompositionSourceRef): Composition {
  return {
    ...ROOM,
    features: ROOM.features.map((f) =>
      f.kind === 'fields' && f.cap === 'temperature-sensor'
        ? {
            ...f,
            fields: {
              ...f.fields,
              temperature: {
                kind: 'from' as const,
                source,
                cap: 'temperature-sensor',
                fieldPath: 'temperature',
              },
            },
          }
        : f,
    ),
  }
}

function compositionBlock(id: string, composition: Composition, updatedAt = 1): CoreBlock {
  return {
    id,
    name: `Room ${id}`,
    code: '',
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt,
    createdBy: 'u',
    status: 'stopped',
    lastChangedAt: 1,
    source: { kind: 'composition', composition },
  }
}

function loadedViews(read: CompositionListRead): readonly CompositionView[] {
  if (read.state !== 'loaded') throw new Error(`expected a loaded list, got ${read.reason}`)
  return read.views
}

function deps(over: Partial<CompositionApiDeps> = {}): CompositionApiDeps {
  return {
    store: {
      isLoaded: () => loaded,
      list: () => stored,
      get: (id) => stored.find((b) => b.id === id) ?? null,
      createComposition: async (input, by) => {
        const block: CoreBlock = {
          ...compositionBlock(`b${stored.length + 1}`, input.composition),
          name: input.name,
          enabled: input.enabled,
          createdBy: by,
        }
        stored = [...stored, block]
        return block
      },
      // Persists like the real store: the patch lands and `updatedAt` moves forward.
      updateComposition: async (id, patch) => {
        const found = stored.find((b) => b.id === id)
        if (found === undefined) throw new Error(`core block not found: ${id}`)
        const updated: CoreBlock = {
          ...found,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.composition === undefined
            ? {}
            : { source: { kind: 'composition', composition: patch.composition } }),
          updatedAt: found.updatedAt + 1,
        }
        stored = stored.map((b) => (b.id === id ? updated : b))
        return updated
      },
    },
    describe: (sources, targets) =>
      describeCompositionSources(
        {
          listByAddon: async (addonId) => rows.get(addonId) ?? [],
          bindings: async (deviceId) => bindings.get(deviceId) ?? ROOM_SOURCE_BINDINGS,
        },
        sources,
        targets,
      ),
    lookupCap: buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS),
    composerStates: async (ids): Promise<readonly CompositionBlockState[]> =>
      ids.map((blockId) => ({ blockId, deviceId: 1901, status: 'running', fields: [] })),
    convergeSoon: () => {
      converged += 1
    },
    convergeForClaims: async () => {
      converged += 1
      return []
    },
    logger: recordingLogger().logger,
    capabilityDefinitions: ALL_CAPABILITY_DEFINITIONS,
    ...over,
  }
}

beforeEach(() => {
  stored = []
  converged = 0
  loaded = true
  const sensor = DeviceType.Sensor
  rows = new Map([
    [
      HA,
      [
        ...ROOM_EXAMPLE_TEMPERATURE_SOURCES.map((r, i) => ({
          id: 11 + i,
          stableId: r.stableId,
          type: sensor,
        })),
        ...ROOM_EXAMPLE_MOTION_SOURCES.map((r, i) => ({
          id: 21 + i,
          stableId: r.stableId,
          type: sensor,
        })),
        { id: FEEDER_ID, stableId: FEEDER.stableId, type: sensor },
        { id: 60, stableId: OTHER.stableId, type: sensor },
      ],
    ],
  ])
  bindings = new Map([
    [FEEDER_ID, [{ capName: 'binary', nativeAddonId: HA }]],
    [60, [{ capName: 'binary', nativeAddonId: HA }]],
  ])
})

describe('createComposition', () => {
  it('stores a valid room and converges at once', async () => {
    const { block } = await buildCompositionApi(deps()).createComposition({
      block: { name: 'Room', enabled: true, composition: ROOM },
      caller: CALLER,
    })
    expect(block.source?.kind).toBe('composition')
    expect(converged).toBe(1)
  })

  it('refuses a missing source BY NAME and stores nothing', async () => {
    rows.set('provider-homeassistant', [])
    await expect(
      buildCompositionApi(deps()).createComposition({
        block: { name: 'Room', enabled: true, composition: ROOM },
        caller: CALLER,
      }),
    ).rejects.toThrow('sensor.living_room_temperature` does not exist')
    expect(stored).toEqual([])
    expect(converged).toBe(0)
  })

  it('refuses when the owning addon cannot be listed — unreadable, never stored unchecked (D49)', async () => {
    const api = buildCompositionApi(
      deps({
        describe: (sources, targets) =>
          describeCompositionSources(
            {
              listByAddon: async () => {
                throw new Error('ETIMEDOUT')
              },
              bindings: async () => [],
            },
            sources,
            targets,
          ),
      }),
    )
    await expect(
      api.createComposition({
        block: { name: 'Room', enabled: true, composition: ROOM },
        caller: CALLER,
      }),
    ).rejects.toThrow('ETIMEDOUT')
    expect(stored).toEqual([])
  })

  it("surfaces the store's not-loaded refusal by name rather than validating against an empty table", async () => {
    loaded = false
    await expect(
      buildCompositionApi(deps()).createComposition({
        block: { name: 'Room', enabled: true, composition: ROOM },
        caller: CALLER,
      }),
    ).rejects.toThrow(NOT_LOADED)
    expect(stored).toEqual([])
  })
})

describe('updateComposition', () => {
  it('validates a changed composition exactly as create does', async () => {
    const api = buildCompositionApi(deps())
    const { block } = await api.createComposition({
      block: { name: 'Room', enabled: true, composition: ROOM },
      caller: CALLER,
    })
    rows.set('provider-homeassistant', [])
    await expect(
      api.updateComposition({
        blockId: block.id,
        expectedUpdatedAt: block.updatedAt,
        block: { composition: ROOM },
        caller: CALLER,
      }),
    ).rejects.toThrow('does not exist')
    expect(converged).toBe(1)
  })

  it("surfaces the store's own refusal (unknown block) unchanged", async () => {
    await expect(
      buildCompositionApi(deps()).updateComposition({
        blockId: 'nope',
        expectedUpdatedAt: 1,
        block: { name: 'x' },
        caller: CALLER,
      }),
    ).rejects.toThrow('core block not found: nope')
  })

  it('refuses an edit made against a version that has since changed — BY NAME, never last-write-wins', async () => {
    const api = buildCompositionApi(deps())
    const { block } = await api.createComposition({
      block: { name: 'Room', enabled: true, composition: ROOM },
      caller: CALLER,
    })
    const read = block.updatedAt
    await api.updateComposition({
      blockId: block.id,
      expectedUpdatedAt: read,
      block: { name: 'Lounge' },
      caller: CALLER,
    })
    await expect(
      api.updateComposition({
        blockId: block.id,
        expectedUpdatedAt: read,
        block: { name: 'Den' },
        caller: CALLER,
      }),
    ).rejects.toThrow(`changed since you read it: stored updatedAt ${read + 1}, yours ${read}`)
    expect(stored[0]?.name).toBe('Lounge')
  })

  it('two concurrent updates that would close a cycle: the second is judged AFTER the first lands, and refused naming the cycle', async () => {
    stored = [compositionBlock('b1', ROOM), compositionBlock('b2', ROOM)]
    rows.set('composer', [
      { id: 1901, stableId: composedDeviceStableId('b1'), type: DeviceType.Sensor },
      { id: 1902, stableId: composedDeviceStableId('b2'), type: DeviceType.Sensor },
    ])
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let reads = 0
    const base = deps()
    const api = buildCompositionApi(
      deps({
        // The FIRST source read stalls: the window in which an unserialized
        // second save would be judged against a store without the first.
        describe: async (sources, targets) => {
          reads += 1
          if (reads === 1) await gate
          return base.describe(sources, targets)
        },
      }),
    )
    const aReadsB = api.updateComposition({
      blockId: 'b1',
      expectedUpdatedAt: 1,
      block: { composition: celsiusFrom(composedDeviceRef('b2')) },
      caller: CALLER,
    })
    const bReadsA = api.updateComposition({
      blockId: 'b2',
      expectedUpdatedAt: 1,
      block: { composition: celsiusFrom(composedDeviceRef('b1')) },
      caller: CALLER,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    const [first, second] = await Promise.allSettled([aReadsB, bReadsA])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
    if (second.status === 'rejected') expect(String(second.reason)).toContain('[cycle]')
  })

  it('judges the candidate IN PLACE of its stored version — an edge it drops is no longer a cycle', async () => {
    // Stored: A reads B, B reads A (a loop an earlier release let through).
    stored = [
      compositionBlock('b1', celsiusFrom(composedDeviceRef('b2'))),
      compositionBlock('b2', celsiusFrom(composedDeviceRef('b1'))),
    ]
    rows.set('composer', [
      { id: 1902, stableId: composedDeviceStableId('b2'), type: DeviceType.Sensor },
    ])
    const { block } = await buildCompositionApi(deps()).updateComposition({
      blockId: 'b1',
      expectedUpdatedAt: 1,
      block: { composition: ROOM },
      caller: CALLER,
    })
    expect(block.updatedAt).toBe(2)
  })
})

describe('validateComposition', () => {
  it('reports a cycle through a stored composition', async () => {
    const api = buildCompositionApi(deps())
    const { block } = await api.createComposition({
      block: { name: 'Room', enabled: true, composition: ROOM },
      caller: CALLER,
    })
    const loop = celsiusFrom(composedDeviceRef(block.id))
    const result = await api.validateComposition({ composition: loop, blockId: block.id })
    expect(result.ok).toBe(false)
    expect(result.problems.map((p) => p.code)).toContain('cycle')
    // No unreadable device in the loop: the plain message, unchanged.
    expect(result.problems.find((p) => p.code === 'cycle')?.message).toMatch(
      /^a field reads itself: composer\/composed-b1#temperature-sensor\.temperature → /,
    )
    expect(stored).toHaveLength(1)
  })

  it('returns every refusal with its code and path, and writes nothing', async () => {
    rows.set('provider-homeassistant', [])
    const result = await buildCompositionApi(deps()).validateComposition({ composition: ROOM })
    expect(result.ok).toBe(false)
    expect(result.problems.every((p) => p.code === 'source-missing')).toBe(true)
    expect(result.problems.map((p) => p.path)).toContain('features[0].fields.temperature')
    expect(stored).toEqual([])
    expect(converged).toBe(0)
  })

  it('refuses to judge before the table has loaded — an empty peer set would hide a cycle', async () => {
    loaded = false
    await expect(
      buildCompositionApi(deps()).validateComposition({ composition: ROOM }),
    ).rejects.toThrow(NOT_LOADED)
  })
})

describe('get / list', () => {
  it('say UNREACHABLE — not absent — when the composer cannot answer (D315)', async () => {
    const api = buildCompositionApi(
      deps({
        composerStates: async () => {
          throw new Error('ECONNREFUSED')
        },
      }),
    )
    await api.createComposition({
      block: { name: 'Room', enabled: true, composition: ROOM },
      caller: CALLER,
    })
    const views = loadedViews(await api.listCompositions({}))
    expect(views[0]?.state).toEqual({ kind: 'unreachable', error: 'ECONNREFUSED' })
  })

  it('answer the composer state per block', async () => {
    const api = buildCompositionApi(deps())
    const { block } = await api.createComposition({
      block: { name: 'Room', enabled: true, composition: ROOM },
      caller: CALLER,
    })
    const read = await api.getComposition({ blockId: block.id })
    if (read.state !== 'loaded') throw new Error(read.reason)
    expect(read.view?.state).toMatchObject({
      kind: 'answered',
      state: { status: 'running', deviceId: 1901 },
    })
  })

  it('answer null for a composer that has no state for the block, and list only compositions', async () => {
    const code: CoreBlock = {
      id: 'c1',
      name: 'Code',
      code: 'export default 0',
      enabled: true,
      placement: 'hub',
      createdAt: 1,
      updatedAt: 1,
      createdBy: 'x',
      status: 'running',
      lastChangedAt: 1,
    }
    stored = [code]
    const api = buildCompositionApi(deps({ composerStates: async () => [] }))
    await api.createComposition({
      block: { name: 'Room', enabled: true, composition: ROOM },
      caller: CALLER,
    })
    const views = loadedViews(await api.listCompositions({}))
    expect(views.map((v) => v.block.name)).toEqual(['Room'])
    expect(views[0]?.state).toEqual({ kind: 'answered', state: null })
    expect(await api.getComposition({ blockId: 'c1' })).toEqual({ state: 'loaded', view: null })
  })

  it('answer NOT-LOADED — never "none" — before the table has been read (D315)', async () => {
    stored = [compositionBlock('b1', ROOM)]
    loaded = false
    const api = buildCompositionApi(deps())
    expect(await api.listCompositions({})).toEqual({ state: 'not-loaded', reason: NOT_LOADED })
    expect(await api.getComposition({ blockId: 'b1' })).toEqual({
      state: 'not-loaded',
      reason: NOT_LOADED,
    })
  })
})

describe('customizing an existing device (D663, D944)', () => {
  const customize = (composition = addBattery()) => ({
    block: { enabled: true, composition },
    caller: CALLER,
  })

  it('getCustomization answers NOT-LOADED — never null — before the table has been read (D315)', async () => {
    loaded = false
    expect(await buildCompositionApi(deps()).getCustomization(FEEDER)).toEqual({
      state: 'not-loaded',
      reason: NOT_LOADED,
    })
  })

  it('a client-sent name on a customization is refused BY NAME, and nothing is stored', async () => {
    await expect(
      buildCompositionApi(deps()).createComposition({
        block: { name: 'Feeder', enabled: true, composition: addBattery() },
        caller: CALLER,
      }),
    ).rejects.toThrow(
      "a customization has no name of its own — the device's name is shown; omit `name`",
    )
    expect(stored).toEqual([])
    expect(converged).toBe(0)
  })

  it('the refusal line is tagged with the device the customization targets (final review M-8, D391)', async () => {
    const log = recordingLogger()
    await expect(
      buildCompositionApi(deps({ logger: log.logger })).createComposition({
        block: { name: 'Feeder', enabled: true, composition: addBattery() },
        caller: CALLER,
      }),
    ).rejects.toThrow('a customization has no name of its own')
    const refusals = log.lines.filter((l) => l.message === 'composition save refused')
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.extras).toMatchObject({ tags: { deviceId: FEEDER_ID } })
  })

  it('without a name, the server stores the DERIVED name (S2)', async () => {
    const { block } = await buildCompositionApi(deps()).createComposition(customize())
    expect(block.name).toBe('customize:provider-homeassistant/ha:b:dev:8dec')
    expect(stored.map((b) => b.name)).toEqual(['customize:provider-homeassistant/ha:b:dev:8dec'])
  })

  it('a NEW device without a name is refused by name', async () => {
    await expect(
      buildCompositionApi(deps()).createComposition({
        block: { enabled: true, composition: ROOM },
        caller: CALLER,
      }),
    ).rejects.toThrow('a new device needs a name')
    expect(stored).toEqual([])
  })

  it('a second customization of the same device is refused as duplicate-target naming the first block; the first block edits itself freely', async () => {
    const api = buildCompositionApi(deps())
    const { block: a } = await api.createComposition(customize())
    const second = api.createComposition(customize(addBattery('on ? 0 : 100')))
    await expect(second).rejects.toThrow('[duplicate-target]')
    await expect(second).rejects.toThrow(`block \`${a.id}\``)
    expect(stored).toHaveLength(1)
    const { block: edited } = await api.updateComposition({
      blockId: a.id,
      expectedUpdatedAt: a.updatedAt,
      block: { composition: addBattery('on ? 0 : 100') },
      caller: CALLER,
    })
    expect(edited.updatedAt).toBe(a.updatedAt + 1)
  })

  it('a customization that replaces a native capability is refused (D944) — a self-read of the replaced field can no longer be stored', async () => {
    // D663 rule 5 stored a replace whose self-read was the native value, so it
    // was not a cycle. That save is unreachable: the override is refused by name
    // and nothing is stored.
    await expect(
      buildCompositionApi(deps()).createComposition(customize(invertFeeder())),
    ).rejects.toThrow('[native-capability-replace]')
    await expect(
      buildCompositionApi(deps()).createComposition(customize(invertFeeder())),
    ).rejects.toThrow('binary')
    expect(stored).toEqual([])
    expect(converged).toBe(0)
  })

  it("a stored customization's self-read of a native field it does not compose is not a cycle — an unrelated save is not refused", async () => {
    const api = buildCompositionApi(deps())
    await api.createComposition(customize())
    const { block } = await api.createComposition({
      block: { name: 'Room', enabled: true, composition: ROOM },
      caller: CALLER,
    })
    expect(block.name).toBe('Room')
  })

  /** The FEEDER's bindings do not read; every other device reads as a ROOM source. */
  const feederUnreadable = () =>
    deps({
      describe: (sources, targets) =>
        describeCompositionSources(
          {
            listByAddon: async (addonId) => rows.get(addonId) ?? [],
            bindings: async (deviceId) => {
              if (deviceId === FEEDER_ID) throw new Error('EHOSTDOWN')
              return ROOM_SOURCE_BINDINGS
            },
          },
          sources,
          targets,
        ),
    })

  it("another customization's UNREADABLE device never blocks an unrelated save — its self-reads are over-approximated, not refused", async () => {
    await buildCompositionApi(deps()).createComposition(customize())
    const { block } = await buildCompositionApi(feederUnreadable()).createComposition({
      block: { name: 'Room', enabled: true, composition: ROOM },
      caller: CALLER,
    })
    expect(block.name).toBe('Room')
    expect(stored).toHaveLength(2)
  })

  it('a save that would cycle through an unreadable customized device is refused NAMING that device', async () => {
    // b1 (the candidate) → q1 → FEEDER → b1: q1 reads the feeder, whose stored
    // customization reads b1; the feeder's bindings do not read.
    const feederReadsRoom = CompositionSchema.parse({
      target: { kind: 'existing', device: FEEDER },
      features: [
        {
          kind: 'fields',
          cap: 'temperature-sensor',
          fields: {
            temperature: {
              kind: 'from',
              source: composedDeviceRef('b1'),
              cap: 'temperature-sensor',
              fieldPath: 'temperature',
            },
          },
        },
      ],
    })
    stored = [
      compositionBlock('b1', ROOM),
      compositionBlock('q1', celsiusFrom(FEEDER)),
      compositionBlock('p1', feederReadsRoom),
    ]
    rows.set('composer', [
      { id: 1901, stableId: composedDeviceStableId('q1'), type: DeviceType.Sensor },
    ])
    await expect(
      buildCompositionApi(feederUnreadable()).updateComposition({
        blockId: 'b1',
        expectedUpdatedAt: 1,
        block: { composition: celsiusFrom(composedDeviceRef('q1')) },
        caller: CALLER,
      }),
    ).rejects.toThrow(
      'possible cycle through `provider-homeassistant/ha:b:dev:8dec` — its state could not be read (EHOSTDOWN)',
    )
    expect(stored[0]?.updatedAt).toBe(1)
  })

  it('C-1: a real cycle through the candidate and an unreadable device is refused even when the DFS names only the artefact loop', async () => {
    // FEEDER's customization p1 (stored FIRST, so its nodes are walked first)
    // ADDS battery — the device has no native battery (D944). Unread, so nothing
    // is replaced and every self-read of a field it writes is an edge:
    //   level reads charging (own output) and b1's temperature;
    //   charging reads level (own output).
    // q1 relays FEEDER charging; the candidate b1 reads q1.
    // Real cycle: b1 → q1 → FEEDER.charging → FEEDER.level → b1.
    // Artefact: FEEDER.level ↔ FEEDER.charging.
    const room = composedDeviceRef('b1')
    const feeder = CompositionSchema.parse({
      target: { kind: 'existing', device: FEEDER },
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: {
            level: {
              kind: 'expression',
              expr: 'charging ? c : 0',
              bindings: {
                charging: { kind: 'from', source: FEEDER, cap: 'battery', fieldPath: 'charging' },
                c: {
                  kind: 'from',
                  source: room,
                  cap: 'temperature-sensor',
                  fieldPath: 'temperature',
                },
              },
            },
            charging: {
              kind: 'expression',
              expr: 'level > 0 ? "dc" : "unknown"',
              bindings: {
                level: {
                  kind: 'from',
                  source: FEEDER,
                  cap: 'battery',
                  fieldPath: 'level',
                },
              },
            },
            sleeping: { kind: 'expression', expr: 'false', bindings: {} },
            lastUpdated: { kind: 'expression', expr: 'now', bindings: {} },
          },
        },
      ],
    })
    const relay = CompositionSchema.parse({
      ...ROOM,
      features: ROOM.features.map((f) =>
        f.kind === 'fields' && f.cap === 'temperature-sensor'
          ? {
              ...f,
              fields: {
                ...f.fields,
                temperature: {
                  kind: 'from',
                  source: FEEDER,
                  cap: 'battery',
                  fieldPath: 'charging',
                },
              },
            }
          : f,
      ),
    })
    stored = [
      compositionBlock('p1', feeder),
      compositionBlock('q1', relay),
      compositionBlock('b1', ROOM),
    ]
    rows.set('composer', [
      { id: 1901, stableId: composedDeviceStableId('q1'), type: DeviceType.Sensor },
    ])
    await expect(
      buildCompositionApi(feederUnreadable()).updateComposition({
        blockId: 'b1',
        expectedUpdatedAt: 1,
        block: { composition: celsiusFrom(composedDeviceRef('q1')) },
        caller: CALLER,
      }),
    ).rejects.toThrow(
      'possible cycle through `provider-homeassistant/ha:b:dev:8dec` — its state could not be read (EHOSTDOWN)',
    )
    expect(stored.find((b) => b.id === 'b1')?.updatedAt).toBe(1)
  })

  it('updateComposition cannot move a customization to another device, nor give it a name', async () => {
    const api = buildCompositionApi(deps())
    const { block: a } = await api.createComposition(customize())
    await expect(
      api.updateComposition({
        blockId: a.id,
        expectedUpdatedAt: a.updatedAt,
        block: { composition: addBattery('on ? 100 : 0', OTHER) },
        caller: CALLER,
      }),
    ).rejects.toThrow(
      "a customization's device cannot be changed — delete it and customize the other device",
    )
    await expect(
      api.updateComposition({
        blockId: a.id,
        expectedUpdatedAt: a.updatedAt,
        block: { name: 'Feeder' },
        caller: CALLER,
      }),
    ).rejects.toThrow('a customization has no name of its own')
    expect(stored[0]?.updatedAt).toBe(a.updatedAt)
  })

  it('a target whose bindings cannot be read refuses the save as target-unreadable, and nothing is stored', async () => {
    const api = buildCompositionApi(
      deps({
        describe: (sources, targets) =>
          describeCompositionSources(
            {
              listByAddon: async (addonId) => rows.get(addonId) ?? [],
              bindings: async () => {
                throw new Error('ETIMEDOUT')
              },
            },
            sources,
            targets,
          ),
      }),
    )
    await expect(api.createComposition(customize())).rejects.toThrow('[target-unreadable]')
    expect(stored).toEqual([])
  })

  it('getCustomization finds the block by its TARGET, and answers view null for a device with none', async () => {
    const api = buildCompositionApi(deps())
    const { block: a } = await api.createComposition(customize())
    const found = await api.getCustomization(FEEDER)
    if (found.state !== 'loaded') throw new Error(found.reason)
    expect(found.view?.block.id).toBe(a.id)
    expect(found.view?.state).toMatchObject({ kind: 'answered', state: { blockId: a.id } })
    expect(await api.getCustomization(OTHER)).toEqual({ state: 'loaded', view: null })
  })

  it('plans a camera doorbell as ADD when its binding names no native owner', async () => {
    const camera = { addonId: 'provider-hikvision', stableId: 'mac-40acbf-test' }
    rows.set('provider-hikvision', [
      { id: 101, stableId: camera.stableId, type: DeviceType.Camera },
    ])
    bindings.set(101, [{ capName: 'doorbell', nativeAddonId: '' }])
    const composition = CompositionSchema.parse({
      target: { kind: 'existing', device: camera },
      features: [
        {
          kind: 'fields',
          cap: 'doorbell',
          fields: {
            lastPressedAt: { kind: 'expression', expr: 'null', bindings: {} },
            pressCountSinceStart: { kind: 'expression', expr: '0', bindings: {} },
          },
        },
      ],
    })

    const verdict = await buildCompositionApi(deps()).validateComposition({ composition })

    expect(verdict.ok).toBe(true)
    expect(verdict.features).toEqual([{ featureIndex: 0, cap: 'doorbell', mode: 'add' }])
  })
})

describe('listComposableCaps (G2, D676)', () => {
  it('lists what a pet feeder can be given, from the same blockers the validator uses', async () => {
    const api = buildCompositionApi(deps())
    const { caps } = await api.listComposableCaps({ deviceType: DeviceType.PetFeeder })
    expect(caps.map((c) => c.cap)).toEqual(expect.arrayContaining(['battery', 'consumables']))
    expect(caps.map((c) => c.cap)).not.toContain('device-status')
  })
})
