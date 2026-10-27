/**
 * A composition on an EXISTING device (D663, D944): a missing cap is ADDED and
 * its fields are CLAIMED on the hub under the block's id, released through the
 * D49 gate. A stored feature that would replace a native capability is refused
 * by name. A target row gone on two agreeing reads fails the block by name.
 * Driven through `Composer.apply` over the `FakeHub`.
 */
import {
  COMPOSER_ADDON_ID,
  type ComposerApplyInput,
  type Composition,
  type CompositionSourceRef,
  CompositionSchema,
  DeviceType,
  EventCategory,
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
  type SystemEvent,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ComposedDeviceHandle } from '../composed-device.js'
import { Composer, type ComposerDeclareResult } from '../composer.js'
import { type ComposerGraftPorts, TARGET_GONE_UNGRAFT_REASON } from '../existing-target.js'
import type { GraftOutcome } from '../graft-host.js'
import { SourceTracker } from '../source-tracker.js'
import {
  FakeHub,
  FakeTarget,
  FakeTimer,
  LOOKUP_CAP,
  type RecordingLogger,
  recordingLogger,
} from './fixtures.js'

const HA = 'provider-homeassistant'
/** The target of the "Invert state" and "from another device" cases: a sensor with a native `binary`. */
const FOOD: CompositionSourceRef = { addonId: HA, stableId: 'ha:food' }
/** Another sensor whose `binary.on` feeds FOOD's replaced field. */
const X: CompositionSourceRef = { addonId: HA, stableId: 'ha:x' }
/** A container with a native `binary` and NO battery: the ADD case. */
const FEEDER: CompositionSourceRef = { addonId: HA, stableId: 'ha:feeder' }
/** A camera with a native battery, read by the ADD case. */
const CAM: CompositionSourceRef = { addonId: HA, stableId: 'ha:cam' }
const FOOD_ID = 51
const X_ID = 61
const FEEDER_ID = 50
const CAM_ID = 52

function from(source: CompositionSourceRef, cap: string, fieldPath: string) {
  return { kind: 'from', source, cap, fieldPath } as const
}

/** "Invert state": FOOD's `binary.on` becomes `!on`, reading its own NATIVE `on`. */
const INVERT: Composition = CompositionSchema.parse({
  target: { kind: 'existing', device: FOOD },
  features: [
    {
      kind: 'fields',
      cap: 'binary',
      fields: {
        on: { kind: 'expression', expr: '!on', bindings: { on: from(FOOD, 'binary', 'on') } },
      },
    },
  ],
})

/** `battery` ADDED to FEEDER: `level` from FEEDER's own native `binary.on`, `charging` from CAM. */
const ADD_BATTERY: Composition = CompositionSchema.parse({
  target: { kind: 'existing', device: FEEDER },
  features: [
    {
      kind: 'fields',
      cap: 'battery',
      fields: {
        level: {
          kind: 'expression',
          expr: 'on ? 100 : 0',
          bindings: { on: from(FEEDER, 'binary', 'on') },
        },
        charging: from(CAM, 'battery', 'charging'),
        sleeping: { kind: 'expression', expr: 'false', bindings: {} },
        lastUpdated: { kind: 'expression', expr: 'now', bindings: {} },
      },
    },
  ],
})

const DOORBELL: Composition = CompositionSchema.parse({
  target: { kind: 'existing', device: CAM },
  features: [
    {
      kind: 'fields',
      cap: 'doorbell',
      fields: {
        lastPressedAt: {
          kind: 'expression',
          expr: 'rose(active, changedAt)',
          bindings: {
            active: from(FOOD, 'binary', 'on'),
            changedAt: from(FOOD, 'binary', 'lastChangedAt'),
          },
        },
        pressCountSinceStart: {
          kind: 'expression',
          expr: 'count(changedAt)',
          bindings: { changedAt: from(FOOD, 'binary', 'lastChangedAt') },
        },
      },
    },
  ],
})

const DISABLED_DOORBELL: Composition = CompositionSchema.parse({
  ...DOORBELL,
  features: DOORBELL.features.map((feature) => ({ ...feature, enabled: false })),
})

const ROOM = roomCompositionExample({
  temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
  occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
})

function seedHub(hub: FakeHub): void {
  hub.add(FOOD, FOOD_ID, { binary: { on: false, lastChangedAt: 10 } })
  hub.add(X, X_ID, { binary: { on: true, lastChangedAt: 20 } })
  hub.add(FEEDER, FEEDER_ID, { binary: { on: false, lastChangedAt: 5 } }, DeviceType.Container)
  hub.add(
    CAM,
    CAM_ID,
    {
      battery: { level: 80, charging: 'dc', sleeping: false, lastUpdated: 7 },
    },
    DeviceType.Camera,
  )
  ROOM_EXAMPLE_TEMPERATURE_SOURCES.forEach((ref, i) =>
    hub.add(ref, 11 + i, {
      'temperature-sensor': { temperature: [21.0, 21.5, 21.4][i], lastFetchedAt: 990_000 + i },
    }),
  )
  ROOM_EXAMPLE_MOTION_SOURCES.forEach((ref, i) =>
    hub.add(ref, 21 + i, {
      motion: { detected: false, lastDetectedAt: null, autoClearAfterMs: null },
    }),
  )
}

interface Ungraft {
  readonly deviceId: number
  readonly capName: string
  readonly reason: string
}

/** The composer's `GraftHost` seam, recorded: grafted state is kept so `grafted()` answers as the real host. */
class RecordingGrafts implements ComposerGraftPorts {
  readonly grafts: string[] = []
  readonly ungrafts: Ungraft[] = []
  readonly retracts: Ungraft[] = []
  /** Caps the host refuses, with the reason it gives. */
  readonly refusing = new Map<string, string>()
  private held = new Map<number, ReadonlySet<string>>()

  /** `retracted` is what the hub does with a retract: the composer's binding goes. */
  constructor(
    private readonly retracted: (deviceId: number, capName: string) => void,
    private readonly onGraft: (deviceId: number, capName: string) => void = () => undefined,
  ) {}

  graft(deviceId: number, stableId: string, capName: string): GraftOutcome {
    this.onGraft(deviceId, capName)
    if (this.grafted(deviceId).has(capName)) return { kind: 'already' }
    const refusal = this.refusing.get(capName)
    if (refusal !== undefined) return { kind: 'refused', reason: refusal }
    this.grafts.push(`${deviceId}#${capName}@${stableId}`)
    this.held = new Map([...this.held, [deviceId, new Set([...this.grafted(deviceId), capName])]])
    return { kind: 'grafted' }
  }

  ungraft(deviceId: number, capName: string, reason: string): void {
    this.ungrafts.push({ deviceId, capName, reason })
    this.held = new Map([
      ...this.held,
      [deviceId, new Set([...this.grafted(deviceId)].filter((c) => c !== capName))],
    ])
  }

  grafted(deviceId: number): ReadonlySet<string> {
    return this.held.get(deviceId) ?? new Set()
  }

  retractStale(deviceId: number, capName: string, reason: string): void {
    this.retracts.push({ deviceId, capName, reason })
    this.retracted(deviceId, capName)
  }
}

let hub: FakeHub
let composer: Composer
let log: RecordingLogger
let tracker: SourceTracker
let declared: string[][]
let ungrafts: Ungraft[]
let grafts: RecordingGrafts
let targets: Map<string, FakeTarget>
/** Runs after a target description was read and before the plan uses it: the window a native can land in (I-2). */
let afterDescribe: ((deviceId: number) => void) | null
let seedReadFailure: string | null
let emitted: SystemEvent[]

type Block = ComposerApplyInput['blocks'][number]

function block(over: Partial<Block> & { composition: Composition }): Block {
  return { id: 'b1', name: 'customize:food', enabled: true, updatedAt: 1, ...over }
}

function input(
  blocks: readonly Block[],
  over: Partial<ComposerApplyInput> = {},
): ComposerApplyInput {
  return {
    integrationId: 'int_blocks',
    storeLoaded: true,
    blocks: [...blocks],
    restartBlockIds: [],
    unreadableBlocks: [],
    ...over,
  }
}

/** The claim-backed target's RPCs are enqueued: let them land. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function makeComposer(): Composer {
  log = recordingLogger()
  const ports = hub.ports(log.logger)
  tracker = new SourceTracker(ports)
  return new Composer({
    logger: log.logger,
    tracker,
    lookupCap: LOOKUP_CAP,
    readPersisted: async () => [],
    declare: async (_integrationId, devices): Promise<ComposerDeclareResult> => {
      declared.push(devices.map((d) => d.stableId))
      const handles = new Map<string, ComposedDeviceHandle>()
      for (const d of devices) {
        const existing = targets.get(d.stableId) ?? new FakeTarget(1900, d.name)
        targets.set(d.stableId, existing)
        handles.set(d.stableId, existing)
      }
      return { devices: handles }
    },
    devices: {
      setName: async () => undefined,
      decommission: async () => undefined,
      applyDerivedSpec: async () => undefined,
    },
    claims: hub.claimsApi(),
    events: {
      emit: (event) => {
        emitted.push(event)
        hub.calls.push(`event:${event.category}`)
      },
    },
    readExistingTargetCap: async (deviceId, capName) => {
      hub.calls.push(`seed:${deviceId}#${capName}`)
      if (seedReadFailure !== null) throw new Error(seedReadFailure)
      const read = await ports.readSlice(deviceId, capName, 'effective')
      if (read.kind === 'unreadable') throw new Error(read.error)
      return read.kind === 'slice' ? read.slice : null
    },
    // The same `getBindings` the tracker uses, counted apart: rule 1 is about THIS read.
    describeTarget: async (deviceId) => {
      hub.calls.push(`describe:${deviceId}`)
      const read = await ports.readBoundCaps(deviceId)
      afterDescribe?.(deviceId)
      return read
    },
    grafts,
    now: () => 1_000_000,
    newTimer: () => new FakeTimer(),
  })
}

const calls = (prefix: string) => hub.calls.filter((c) => c.startsWith(prefix))

beforeEach(async () => {
  hub = new FakeHub()
  seedHub(hub)
  declared = []
  grafts = new RecordingGrafts(
    (deviceId, capName) => hub.unbind(deviceId, capName),
    (deviceId, capName) => hub.calls.push(`graft:${deviceId}#${capName}`),
  )
  ungrafts = grafts.ungrafts
  afterDescribe = null
  seedReadFailure = null
  emitted = []
  targets = new Map()
  composer = makeComposer()
  // The composer's own rows read `[]` twice (D49): the second read seeds. Same for the claims.
  await composer.apply(input([]))
  await composer.apply(input([]))
  hub.calls.length = 0
})

describe('D670 — existing-target state is seeded before ownership', () => {
  it('reads every affected effective cap before graft planning or claims', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()

    const ownership = hub.calls.filter(
      (call) => call.startsWith('seed:') || call.startsWith('graft:') || call.startsWith('claim:'),
    )
    expect(ownership.filter((call) => call.startsWith('seed:'))).toEqual([
      `seed:${FEEDER_ID}#battery`,
    ])
    const lastSeed = Math.max(
      ...ownership.map((call, index) => (call.startsWith('seed:') ? index : -1)),
    )
    expect(ownership.findIndex((call) => call.startsWith('graft:'))).toBeGreaterThan(lastSeed)
    expect(ownership.findIndex((call) => call.startsWith('claim:'))).toBeGreaterThan(lastSeed)
  })

  it('performs zero side effects when an initial seed read fails', async () => {
    seedReadFailure = 'offline'

    const result = await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()

    expect(grafts.grafts).toEqual([])
    expect(calls('claim:')).toEqual([])
    expect(calls('patch:')).toEqual([])
    expect(result.blocks).toEqual([
      {
        blockId: 'b1',
        status: 'starting',
        reason: expect.stringContaining('state could not be read'),
      },
    ])
  })

  it('keeps the old runtime running when an edit seed read fails', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(hub.claim(FEEDER_ID, 'battery')?.values).toMatchObject({ level: 0 })

    seedReadFailure = 'offline'
    const patchesBefore = calls('patch:').length
    const edited = await composer.apply(input([block({ composition: ADD_BATTERY, updatedAt: 2 })]))
    await flush()
    expect(edited.blocks).toEqual([{ blockId: 'b1', status: 'running' }])

    const native = { on: true, lastChangedAt: 30 }
    hub.setSlice(FEEDER_ID, 'binary', native)
    await composer.onNativeChanged({ deviceId: FEEDER_ID, capName: 'binary', native })
    await flush()

    expect(calls('patch:')).toHaveLength(patchesBefore + 1)
    expect(hub.claim(FEEDER_ID, 'battery')?.values).toMatchObject({ level: 100 })
  })
})

describe('D670 — state-derived events precede owned-field RPCs', () => {
  it('emits a doorbell edge before its initial unresolved claim RPC', async () => {
    let resolveClaim = (): void => undefined
    const unresolved = new Promise<void>((resolve) => {
      resolveClaim = resolve
    })
    hub.beforeClaimReturns = async () => unresolved

    const timestamp = 1_000_100
    const source = { on: true, lastChangedAt: timestamp }
    hub.setSlice(FOOD_ID, 'binary', source)
    await composer.apply(input([block({ composition: DOORBELL })]))
    expect(calls(`claim:${CAM_ID}#doorbell`)).toHaveLength(1)

    expect(emitted).toEqual([
      expect.objectContaining({
        category: EventCategory.DoorbellOnPressed,
        source: { type: 'device', id: CAM_ID, deviceId: CAM_ID },
        data: { deviceId: CAM_ID, timestamp },
      }),
    ])
    const eventAt = hub.calls.findIndex(
      (call) => call === `event:${EventCategory.DoorbellOnPressed}`,
    )
    const claimAt = hub.calls.findIndex((call) => call === `claim:${CAM_ID}#doorbell`)
    expect(eventAt).toBeGreaterThanOrEqual(0)
    expect(claimAt).toBeGreaterThan(eventAt)

    resolveClaim()
    await flush()
  })
})

describe('review M3 — an added restored cap seeded from nothing is named', () => {
  const SEEDLESS = 'composed restored capability seeded from nothing'

  it('logs once, on the target, when the doorbell slice is absent', async () => {
    hub.setSlice(FOOD_ID, 'binary', { on: false, lastChangedAt: 1_000_000 })
    await composer.apply(input([block({ composition: DOORBELL })]))
    await flush()

    const lines = log.lines.filter((l) => l.message.includes(SEEDLESS))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.extras?.tags).toEqual({ deviceId: CAM_ID })
    expect(lines[0]?.extras?.meta).toMatchObject({ cap: 'doorbell', seededFrom: 'none' })
  })

  it('says nothing when the target had the slice', async () => {
    hub.setSlice(FOOD_ID, 'binary', { on: false, lastChangedAt: 1_000_000 })
    hub.setSlice(CAM_ID, 'doorbell', { lastPressedAt: 999_000, pressCountSinceStart: 2 })
    await composer.apply(input([block({ composition: DOORBELL })]))
    await flush()

    expect(log.lines.filter((l) => l.message.includes(SEEDLESS))).toEqual([])
  })
})

describe('D670 — disabled features produce no runtime work', () => {
  it('does not graft, seed, claim, patch, or emit for a disabled feature', async () => {
    const result = await composer.apply(input([block({ composition: DISABLED_DOORBELL })]))
    await flush()

    expect(result.blocks).toEqual([{ blockId: 'b1', status: 'running' }])
    expect(grafts.grafts).toEqual([])
    expect(calls('seed:')).toEqual([])
    expect(calls('claim:')).toEqual([])
    expect(calls('patch:')).toEqual([])
    expect(calls('event:')).toEqual([])
    expect(emitted).toEqual([])
  })
})

describe('rule 1 — the target is resolved and described once per plan change', () => {
  it('a described target plans, its fields are claimed under the block id, and unchanged applies read nothing more', async () => {
    const result = await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(result.blocks).toEqual([{ blockId: 'b1', status: 'running' }])
    expect(hub.claim(FEEDER_ID, 'battery')).toMatchObject({
      owner: 'b1',
      mode: 'add',
      fields: ['level', 'charging', 'sleeping', 'lastUpdated'],
    })
    // No device is declared for an existing target: the row is not the composer's (D663).
    expect(declared.at(-1)).toEqual([])
    expect(calls(`describe:${FEEDER_ID}`)).toHaveLength(1)
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    expect(calls(`describe:${FEEDER_ID}`)).toHaveLength(1)
    expect(calls('claim:')).toHaveLength(1)
  })

  it('an edit re-reads the description ONCE; a read that fails keeps the previous one', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(calls(`describe:${FEEDER_ID}`)).toHaveLength(1)
    hub.failBindings(FEEDER_ID)
    const edited = await composer.apply(input([block({ composition: ADD_BATTERY, updatedAt: 2 })]))
    await flush()
    expect(calls(`describe:${FEEDER_ID}`)).toHaveLength(2)
    expect(edited.blocks).toEqual([{ blockId: 'b1', status: 'running' }])
    expect(hub.claim(FEEDER_ID, 'battery')).toMatchObject({ owner: 'b1' })
  })

  it('with NO previous description the block is starting and nothing is claimed or released (D49)', async () => {
    hub.failBindings(FEEDER_ID)
    const first = await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(first.blocks).toEqual([
      { blockId: 'b1', status: 'starting', reason: expect.stringContaining('described') },
    ])
    expect(calls('claim:')).toEqual([])
    expect(calls('release:')).toEqual([])
    const waits = log.lines.filter((l) => l.message.includes('customization waits'))
    expect(waits).toHaveLength(1)
    expect(waits[0]?.extras?.tags).toEqual({ deviceId: FEEDER_ID })
    // The read heals: the block plans on the next apply and claims once.
    hub.healBindings(FEEDER_ID)
    const second = await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(second.blocks).toEqual([{ blockId: 'b1', status: 'running' }])
    expect(calls('claim:')).toHaveLength(1)
  })
})

describe('rule 2 — nothing is claimed while the claims index has not loaded', () => {
  it('an existing-target block waits by name; a new-target block in the same apply still runs', async () => {
    composer = makeComposer()
    hub.scriptedClaims.push({ state: 'not-loaded', reason: 'index blob unreadable' })
    const blocks = [
      block({ composition: ADD_BATTERY }),
      block({ id: 'room', name: 'Living room', composition: ROOM }),
    ]
    await composer.apply(input(blocks)) // the composer's rows read [] once: everything waits (D49)
    const waiting = await composer.apply(input(blocks)) // rows agree; the claims index is NOT loaded
    await flush()
    expect(waiting.blocks).toEqual([
      { blockId: 'b1', status: 'starting', reason: expect.stringContaining('claims') },
      { blockId: 'room', status: 'running' },
    ])
    expect(declared.at(-1)).toEqual(['composed-room'])
    expect(calls('claim:')).toEqual([])
    const notLoaded = log.lines.filter((l) => l.message.includes('claims index could not be read'))
    expect(notLoaded).toHaveLength(1)
    const cold = await composer.apply(input(blocks)) // the index loads EMPTY: one read is not proof
    expect(cold.blocks[0]).toMatchObject({ status: 'starting' })
    expect(calls('claim:')).toEqual([])
    const loaded = await composer.apply(input(blocks)) // the next read agrees
    await flush()
    expect(loaded.blocks[0]).toEqual({ blockId: 'b1', status: 'running' })
    expect(calls(`claim:${FEEDER_ID}#battery`)).toHaveLength(1)
  })
})

describe('rule 3 — a claim nobody wants is released only when two applies agree (D49)', () => {
  const ORPHAN = {
    owner: 'gone-block',
    mode: 'replace',
    fields: ['on'],
    values: { on: true },
  } as const

  it('a claim seeded from the hub whose block is gone: the first apply after a restart is not the first miss — released on the SECOND', async () => {
    hub.seedClaim(FOOD_ID, 'binary', ORPHAN)
    composer = makeComposer()
    await composer.apply(input([])) // rows [] once
    await composer.apply(input([])) // rows agree; the claims seed (one claim) is trusted at once — miss 1
    expect(hub.claim(FOOD_ID, 'binary')).toEqual(ORPHAN)
    expect(calls('release:')).toEqual([])
    await composer.apply(input([]))
    expect(calls('release:')).toEqual([`release:${FOOD_ID}#binary`])
    expect(hub.claim(FOOD_ID, 'binary')).toBeUndefined()
  })

  it('a failed listClaims at boot followed by an apply that no longer wants a claim releases NOTHING — and claims nothing either', async () => {
    hub.seedClaim(FOOD_ID, 'binary', ORPHAN)
    composer = makeComposer()
    hub.scriptedClaims.push({ state: 'not-loaded', reason: 'index blob unreadable' })
    hub.scriptedClaims.push({ state: 'not-loaded', reason: 'index blob unreadable' })
    const feeder = block({ id: 'b2', composition: ADD_BATTERY })
    await composer.apply(input([feeder])) // rows [] once
    await composer.apply(input([feeder])) // rows agree; claims NOT loaded — nothing known, nothing released
    expect(calls('release:')).toEqual([])
    // A second unreadable read is not an agreement about anything (D315): still unknown, still nothing claimed.
    const still = await composer.apply(input([feeder]))
    await flush()
    expect(still.blocks[0]).toMatchObject({
      status: 'starting',
      reason: expect.stringContaining('claims'),
    })
    expect(calls('claim:')).toEqual([])
    expect(calls('release:')).toEqual([])
    await composer.apply(input([feeder])) // claims loaded now: the orphan's miss 1; the feeder claims
    await flush()
    expect(calls('claim:')).toEqual([`claim:${FEEDER_ID}#battery`])
    expect(calls('release:')).toEqual([])
    await composer.apply(input([feeder])) // miss 2
    expect(calls('release:')).toEqual([`release:${FOOD_ID}#binary`])
  })

  it('an EMPTY claims seed is trusted only when the next read agrees', async () => {
    hub.seedClaim(FOOD_ID, 'binary', ORPHAN)
    composer = makeComposer()
    hub.scriptedClaims.push({ state: 'loaded', claims: [] })
    await composer.apply(input([])) // rows [] once
    const cold = await composer.apply(input([block({ composition: ADD_BATTERY })])) // claims [] once: not trusted
    expect(cold.blocks[0]).toMatchObject({ status: 'starting' })
    expect(calls('claim:')).toEqual([])
    await composer.apply(input([])) // the warm read names the orphan: miss 1
    await composer.apply(input([])) // miss 2
    expect(calls('release:')).toEqual([`release:${FOOD_ID}#binary`])
  })

  it('a feature removed by an edit releases its claim before the apply returns', async () => {
    const cam2: CompositionSourceRef = { addonId: HA, stableId: 'ha:cam2' }
    const cam2Id = 71
    hub.add(cam2, cam2Id, {}, DeviceType.Camera)
    const both: Composition = CompositionSchema.parse({
      target: { kind: 'existing', device: cam2 },
      features: [...DOORBELL.features, ...ADD_BATTERY.features],
    })
    const batteryOnly: Composition = CompositionSchema.parse({
      target: { kind: 'existing', device: cam2 },
      features: ADD_BATTERY.features,
    })
    await composer.apply(input([block({ composition: both })]))
    await flush()
    expect(hub.claim(cam2Id, 'doorbell')).toMatchObject({ owner: 'b1', mode: 'add' })
    expect(hub.claim(cam2Id, 'battery')).toMatchObject({ owner: 'b1', mode: 'add' })
    await composer.apply(input([block({ composition: batteryOnly, updatedAt: 2 })]))
    expect(hub.claim(cam2Id, 'doorbell')).toBeUndefined()
    expect(hub.claim(cam2Id, 'battery')).toMatchObject({ owner: 'b1' })
  })
})

describe('rule 4 — a block whose row exists but whose plan fails keeps its claims (D659 placeholder rule)', () => {
  it('a cap renamed by a release: failed by name, claims kept, its fields reported stale at their last value', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    const renamed: Composition = {
      ...ADD_BATTERY,
      features: ADD_BATTERY.features.map((f) => ({ ...f, cap: 'battery-v2' })),
    }
    const broken = input([block({ composition: renamed, updatedAt: 2 })])
    const result = await composer.apply(broken)
    await composer.apply(broken)
    await composer.apply(broken)
    await flush()
    expect(result.blocks[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('battery-v2'),
    })
    expect(calls('release:')).toEqual([])
    expect(hub.claim(FEEDER_ID, 'battery')).toMatchObject({ owner: 'b1' })
    const [state] = composer.getStates(['b1'])
    expect(state?.fields.map((field) => field.path).sort()).toEqual([
      'charging',
      'lastUpdated',
      'level',
      'sleeping',
    ])
    expect(state?.fields.every((field) => field.state === 'stale' && field.cap === 'battery')).toBe(
      true,
    )
  })
})

describe('rule 5 — the target device gone on two agreeing reads', () => {
  it('fails the block naming the target, ungrafts every ADDED cap once, leaves the claims alone; no auto-repair', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(hub.claim(FEEDER_ID, 'battery')).toMatchObject({ owner: 'b1', mode: 'add' })
    hub.remove(FEEDER)
    await composer.onDeviceUnregistered(FEEDER_ID)
    expect(composer.getStates(['b1'])[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining(FEEDER.stableId),
    })
    expect(ungrafts).toEqual([
      { deviceId: FEEDER_ID, capName: 'battery', reason: TARGET_GONE_UNGRAFT_REASON },
    ])
    const failure = log.lines.find((l) => l.level === 'error' && l.message.includes('target'))
    expect(failure?.extras?.tags).toEqual({ deviceId: FEEDER_ID })
    // The row and its `$owned` die with the device: the gate never touches them.
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(calls('release:')).toEqual([])
    expect(ungrafts).toHaveLength(1)
    expect(composer.getStates(['b1'])[0]?.status).toBe('failed')
    // The device comes back under a new id, but nothing the OPERATOR did happened: it stays failed.
    hub.add(FEEDER, 70, { binary: { on: false, lastChangedAt: 5 } }, DeviceType.Container)
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    expect(composer.getStates(['b1'])[0]?.status).toBe('failed')
    // An operator restart re-resolves it.
    const restarted = await composer.apply(
      input([block({ composition: ADD_BATTERY })], { restartBlockIds: ['b1'] }),
    )
    await flush()
    expect(restarted.blocks[0]?.status).toBe('running')
    expect(hub.claim(70, 'battery')).toMatchObject({ owner: 'b1' })
  })

  it('found gone on the PLAN path (the unregister event was dropped, D8): an operator restart ungrafts exactly as the event path does', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    hub.remove(FEEDER)
    // No `onDeviceUnregistered`: the bus dropped it. The operator restarts the misbehaving block.
    const restarted = await composer.apply(
      input([block({ composition: ADD_BATTERY })], { restartBlockIds: ['b1'] }),
    )
    expect(restarted.blocks[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining(FEEDER.stableId),
    })
    expect(ungrafts).toEqual([
      { deviceId: FEEDER_ID, capName: 'battery', reason: TARGET_GONE_UNGRAFT_REASON },
    ])
    const removed = log.lines.find((l) => l.message.includes('grafts are removed'))
    expect(removed?.extras?.tags).toEqual({ deviceId: FEEDER_ID })
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await composer.apply(input([block({ composition: ADD_BATTERY })], { restartBlockIds: ['b1'] }))
    expect(ungrafts).toHaveLength(1)
  })

  it('ONE absent read then present: nothing changes', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    hub.scriptedLists.set(HA, [{ kind: 'rows', rows: [] }])
    await composer.onDeviceUnregistered(FEEDER_ID)
    expect(composer.getStates(['b1'])[0]?.status).toBe('running')
    expect(ungrafts).toEqual([])
  })

  it('a target already gone at boot fails the block by name and claims nothing', async () => {
    hub.remove(FEEDER)
    const result = await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(result.blocks[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining(FEEDER.stableId),
    })
    expect(calls('claim:')).toEqual([])
  })
})

describe('Task 10 — grafts: an ADDED cap gets a method-serving native, decided at PLAN time only', () => {
  const nativeAppeared = (addonId: string) =>
    composer.onBindingsChanged({
      deviceId: FEEDER_ID,
      capName: 'battery',
      reason: 'native-registered',
      addonId,
    })

  it('the plan that ADDS battery grafts it once; a native replace is refused and grafts nothing', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(grafts.grafts).toEqual([`${FEEDER_ID}#battery@${FEEDER.stableId}`])
    const refused = await composer.apply(input([block({ id: 'b2', composition: INVERT })]))
    await flush()
    expect(grafts.grafts).toHaveLength(1)
    expect(hub.claim(FOOD_ID, 'binary')).toBeUndefined()
    expect(refused.blocks.find((row) => row.blockId === 'b2')).toMatchObject({ status: 'failed' })
    const warned = log.lines.filter(
      (line) =>
        line.level === 'warn' &&
        line.message === 'stored customization b2 replaces a native capability — refused' &&
        line.extras?.tags?.deviceId === FOOD_ID,
    )
    expect(warned).toHaveLength(1)
    expect(warned[0]?.extras?.meta).toMatchObject({ blockId: 'b2' })
  })

  it('a disabled block grafts nothing', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY, enabled: false })]))
    expect(grafts.grafts).toEqual([])
  })

  it('native-registered by ANOTHER addon → ungrafted by name, the claim untouched; its own registration is not a foreign native', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    await nativeAppeared(COMPOSER_ADDON_ID)
    expect(ungrafts).toEqual([])
    hub.bind(FEEDER_ID, 'battery')
    await nativeAppeared(HA)
    await flush()
    expect(ungrafts).toEqual([
      { deviceId: FEEDER_ID, capName: 'battery', reason: 'a native provider appeared' },
    ])
    expect(hub.claim(FEEDER_ID, 'battery')).toMatchObject({ owner: 'b1', mode: 'add' })
    const line = log.lines.find((l) => l.message.includes('a native provider appeared'))
    expect(line?.extras?.tags).toEqual({ deviceId: FEEDER_ID })
  })

  it('native-unregistered by the other addon → NEVER re-grafted (a restart looks like a removal, D659); only the operator re-plans', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    hub.bind(FEEDER_ID, 'battery')
    await nativeAppeared(HA)
    hub.unbind(FEEDER_ID, 'battery')
    await composer.onBindingsChanged({
      deviceId: FEEDER_ID,
      capName: 'battery',
      reason: 'native-unregistered',
      addonId: HA,
    })
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(grafts.grafts).toHaveLength(1)
    // The operator restarts: the target is described again, battery is not bound — grafted again.
    await composer.apply(input([block({ composition: ADD_BATTERY })], { restartBlockIds: ['b1'] }))
    expect(grafts.grafts).toHaveLength(2)
  })

  it('the foreign-native event was DROPPED (D8): the next re-plan finds battery native and ungrafts it', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    hub.bind(FEEDER_ID, 'battery')
    await composer.apply(input([block({ composition: ADD_BATTERY, updatedAt: 2 })]))
    expect(ungrafts).toEqual([
      { deviceId: FEEDER_ID, capName: 'battery', reason: 'a native provider appeared' },
    ])
    expect(grafts.grafts).toHaveLength(1)
  })

  it("the composer's OWN graft listed by getBindings is not a native: a re-plan keeps battery an ADD", async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    hub.bindAs(FEEDER_ID, 'battery', COMPOSER_ADDON_ID)
    const edited = await composer.apply(input([block({ composition: ADD_BATTERY, updatedAt: 2 })]))
    await flush()
    expect(edited.blocks).toEqual([{ blockId: 'b1', status: 'running' }])
    expect(ungrafts).toEqual([])
    expect(grafts.grafted(FEEDER_ID)).toEqual(new Set(['battery']))
    expect(hub.claim(FEEDER_ID, 'battery')).toMatchObject({ owner: 'b1', mode: 'add' })
  })

  it('deleted: the add claim released by the D49 gate takes its graft with it', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    await composer.apply(input([]))
    expect(ungrafts).toEqual([])
    await composer.apply(input([]))
    expect(hub.claim(FEEDER_ID, 'battery')).toBeUndefined()
    expect(ungrafts).toEqual([
      { deviceId: FEEDER_ID, capName: 'battery', reason: 'the block no longer adds this cap' },
    ])
  })
})

describe('Task 10 fix round 1 — an unserved add is named (I-1), native always wins (I-2), a previous process leaves nothing (I-3)', () => {
  it('I-1: every added cap refused → failed naming the cap and the refusal', async () => {
    grafts.refusing.set('battery', 'registerNativeCap threw — boom')
    const result = await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(result.blocks[0]).toMatchObject({ status: 'failed' })
    expect(result.blocks[0]?.reason).toContain(
      'battery: graft refused: registerNativeCap threw — boom',
    )
  })

  it('I-1: a refused add beside a served add → degraded, naming it; the next edit that grafts clears it', async () => {
    const cam2: CompositionSourceRef = { addonId: HA, stableId: 'ha:cam2' }
    hub.add(cam2, 71, {}, DeviceType.Camera)
    const both: Composition = CompositionSchema.parse({
      target: { kind: 'existing', device: cam2 },
      features: [...DOORBELL.features, ...ADD_BATTERY.features],
    })
    grafts.refusing.set('battery', 'no composed answer')
    await composer.apply(input([block({ composition: both })]))
    await flush()
    const [state] = composer.getStates(['b1'])
    expect(state).toMatchObject({ status: 'degraded' })
    expect(state?.reason).toContain('battery: graft refused: no composed answer')
    grafts.refusing.clear()
    await composer.apply(input([block({ composition: both, updatedAt: 2 })]))
    await flush()
    expect(composer.getStates(['b1'])[0]?.status).toBe('running')
  })

  it('I-2: a native registered between the description read and the graft is never grafted over — degraded naming it', async () => {
    afterDescribe = (deviceId) => {
      if (deviceId !== FEEDER_ID) return
      afterDescribe = null
      hub.bind(FEEDER_ID, 'battery')
      void composer.onBindingsChanged({
        deviceId: FEEDER_ID,
        capName: 'battery',
        reason: 'native-registered',
        addonId: HA,
      })
    }
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(grafts.grafts).toEqual([])
    expect(grafts.grafted(FEEDER_ID).size).toBe(0)
    const [state] = composer.getStates(['b1'])
    expect(state).toMatchObject({ status: 'failed' })
    expect(state?.reason).toContain(
      `battery: a native provider (${HA}) registered while the block was planning`,
    )
    const skipped = log.lines.find((l) => l.message.includes('native always wins'))
    expect(skipped?.extras?.tags).toEqual({ deviceId: FEEDER_ID })
  })

  it('I-2: a native registered AFTER the graft ungrafts it and the block names it', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(grafts.grafted(FEEDER_ID)).toEqual(new Set(['battery']))
    hub.bind(FEEDER_ID, 'battery')
    await composer.onBindingsChanged({
      deviceId: FEEDER_ID,
      capName: 'battery',
      reason: 'native-registered',
      addonId: HA,
    })
    expect(grafts.grafted(FEEDER_ID).size).toBe(0)
    const [state] = composer.getStates(['b1'])
    expect(state).toMatchObject({ status: 'failed' })
    expect(state?.reason).toContain(`battery: a native provider (${HA}) appeared`)
  })

  it('I-3: after a respawn, the first plan retracts a graft the previous process left that the plan no longer adds', async () => {
    // The previous process grafted battery; the block was edited to stop adding it while the runner was down.
    hub.bindAs(FEEDER_ID, 'battery', COMPOSER_ADDON_ID)
    const stoppedAdding: Composition = CompositionSchema.parse({
      ...ADD_BATTERY,
      features: ADD_BATTERY.features.map((feature) => ({ ...feature, enabled: false })),
    })
    await composer.apply(input([block({ composition: stoppedAdding })]))
    await flush()
    expect(grafts.retracts).toEqual([
      {
        deviceId: FEEDER_ID,
        capName: 'battery',
        reason: 'a graft left by a previous composer process that no plan wants',
      },
    ])
    const bindings = await hub.ports(log.logger).readBoundCaps(FEEDER_ID)
    expect(bindings.kind === 'caps' ? [...bindings.caps.keys()] : null).toEqual(['binary'])
  })

  it('I-3: a block that still adds the cap keeps it — the new process grafts it again, nothing retracted', async () => {
    hub.bindAs(FEEDER_ID, 'battery', COMPOSER_ADDON_ID)
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(grafts.retracts).toEqual([])
    expect(grafts.grafted(FEEDER_ID)).toEqual(new Set(['battery']))
  })

  it("I-3: a block deleted while the composer was down — its add claim's gate release retracts the leftover graft, once read as the composer's", async () => {
    hub.bindAs(FEEDER_ID, 'battery', COMPOSER_ADDON_ID)
    hub.seedClaim(FEEDER_ID, 'battery', {
      owner: 'b-gone',
      mode: 'add',
      fields: ['level'],
      values: { level: 100 },
    })
    composer = makeComposer()
    await composer.apply(input([]))
    await composer.apply(input([]))
    await composer.apply(input([]))
    await flush()
    expect(hub.claim(FEEDER_ID, 'battery')).toBeUndefined()
    expect(grafts.retracts.map((r) => `${r.deviceId}#${r.capName}`)).toEqual([
      `${FEEDER_ID}#battery`,
    ])
  })
})

describe('rule 6 — self reads come from the NATIVE view, never the merge (no self-cycle)', () => {
  it('a stored override that replaces a native capability is refused by name (D944)', async () => {
    const result = await composer.apply(input([block({ composition: INVERT })]))
    await flush()
    expect(result.blocks[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('native-capability-replace'),
    })
    expect(result.blocks[0]?.reason).toContain(`device ${FOOD_ID}`)
    expect(hub.claim(FOOD_ID, 'binary')).toBeUndefined()
    expect(calls('patch:')).toEqual([])
    const warned = log.lines.filter(
      (line) =>
        line.level === 'warn' &&
        line.message === 'stored customization b1 replaces a native capability — refused',
    )
    expect(warned).toHaveLength(1)
    expect(warned[0]?.extras?.tags).toEqual({ deviceId: FOOD_ID })
    expect(warned[0]?.extras?.meta).toMatchObject({ blockId: 'b1' })
  })

  it('a native field the composition does NOT claim: `device.state-changed` IS the native (no shadow ever comes)', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(hub.claim(FEEDER_ID, 'battery')?.values).toMatchObject({ level: 0 })
    const slice = { on: true, lastChangedAt: 6 }
    hub.setSlice(FEEDER_ID, 'binary', slice)
    await composer.onStateChanged({ deviceId: FEEDER_ID, capName: 'binary', slice })
    await flush()
    expect(hub.claim(FEEDER_ID, 'battery')?.values).toMatchObject({ level: 100 })
  })
})

describe('C-1 — what the tracker takes as the native follows the claim the hub HOLDS, never the plan', () => {
  const PERSISTED = {
    owner: 'b1',
    mode: 'add',
    fields: ['level', 'charging', 'sleeping', 'lastUpdated'],
    values: { level: 0, charging: 'dc', sleeping: false, lastUpdated: 1 },
  } as const

  it('boot with a persisted claim and a FAILING target-state read: ownership waits, the claim is held; the read recovers → the composed value', async () => {
    hub.seedClaim(FEEDER_ID, 'battery', PERSISTED)
    hub.failSlice(FEEDER_ID, 'battery')
    composer = makeComposer()
    await composer.apply(input([block({ composition: ADD_BATTERY })])) // rows [] once
    const booted = await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(calls('release:')).toEqual([])
    expect(hub.claim(FEEDER_ID, 'battery')).toEqual(PERSISTED)
    expect(booted.blocks[0]).toMatchObject({
      status: 'starting',
      reason: expect.stringContaining('state could not be read before ownership'),
    })
    expect(calls('claim:')).toEqual([])
    // Still failing on the next converge: still held, nothing released or claimed.
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(calls('release:')).toEqual([])
    expect(hub.claim(FEEDER_ID, 'battery')).toEqual(PERSISTED)
    // The read heals: the converge re-reads it and the runtime starts from the sources.
    hub.healSlice(FEEDER_ID, 'battery')
    const healed = await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(healed.blocks[0]).toEqual({ blockId: 'b1', status: 'running' })
    expect(hub.claim(FEEDER_ID, 'battery')).toMatchObject({
      owner: 'b1',
      values: { level: 0 },
    })
    expect(calls('release:')).toEqual([])
    // Under the seeded claim the merged event is the composer's own: ignored.
    await composer.onStateChanged({
      deviceId: FEEDER_ID,
      capName: 'battery',
      slice: hub.effective(FEEDER_ID, 'battery') ?? {},
    })
    await flush()
    expect(hub.claim(FEEDER_ID, 'battery')?.values).toMatchObject({ level: 0 })
  })

  it('a composition that also replaces a native cap is refused and claims nothing (D944)', async () => {
    const both: Composition = CompositionSchema.parse({
      target: { kind: 'existing', device: FOOD },
      features: [
        ...ADD_BATTERY.features,
        { kind: 'fields', cap: 'binary', fields: { on: from(X, 'binary', 'on') } },
      ],
    })
    const result = await composer.apply(input([block({ composition: both })]))
    await flush()
    expect(result.blocks[0]).toMatchObject({ status: 'failed' })
    expect(result.blocks[0]?.reason).toContain('native-capability-replace')
    expect(hub.claim(FOOD_ID, 'binary')).toBeUndefined()
    expect(hub.claim(FOOD_ID, 'battery')).toBeUndefined()
  })
})

describe('fix round 2 — only a CONFIRMED unavailability releases (N-2), the claim window (N-1), a fresh runtime waits for its sync (N-5)', () => {
  const PERSISTED_CAM = {
    owner: 'b1',
    mode: 'add',
    fields: ['level', 'charging', 'sleeping', 'lastUpdated'],
    values: { level: 0, charging: 'dc', sleeping: false, lastUpdated: 1 },
  } as const

  it('N-2: a failed source read and an unconfirmed unregistration release nothing', async () => {
    hub.seedClaim(FEEDER_ID, 'battery', PERSISTED_CAM)
    hub.failSlice(CAM_ID, 'battery')
    composer = makeComposer()
    await composer.apply(input([block({ composition: ADD_BATTERY })])) // rows [] once
    const booted = await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(calls('release:')).toEqual([])
    expect(hub.claim(FEEDER_ID, 'battery')).toMatchObject({ owner: 'b1', mode: 'add' })
    expect(booted.blocks[0]?.status === 'starting' || booted.blocks[0]?.status === 'running').toBe(
      true,
    )
    // An unregistration the bindings re-read could not confirm is still no answer.
    hub.failBindings(CAM_ID)
    await composer.onBindingsChanged({
      deviceId: CAM_ID,
      capName: 'battery',
      reason: 'native-unregistered',
      addonId: HA,
    })
    await flush()
    expect(calls('release:')).toEqual([])
    expect(hub.claim(FEEDER_ID, 'battery')).toMatchObject({ owner: 'b1' })
  })

  it("N-1: the hub's merged `state-changed` arriving BEFORE the claim reply is not taken as the native — no flip-back write", async () => {
    let merged = false
    hub.beforeClaimReturns = async (input) => {
      if (merged) return
      merged = true
      await composer.onStateChanged({
        deviceId: input.deviceId,
        capName: input.capName,
        slice: hub.effective(input.deviceId, input.capName) ?? {},
      })
    }
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(merged).toBe(true)
    expect(hub.claim(FEEDER_ID, 'battery')?.values).toMatchObject({ level: 0 })
    expect(calls('patch:')).toEqual([])
  })

  it("N-5 (slice 1 unchanged): a new-target runtime built by an apply is not started by an event before that apply's sync", async () => {
    const BATTERY_ROOM: Composition = CompositionSchema.parse({
      target: { kind: 'new', type: DeviceType.Sensor },
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: {
            level: from(CAM, 'battery', 'level'),
            charging: from(CAM, 'battery', 'charging'),
            sleeping: { kind: 'expression', expr: 'false', bindings: {} },
            lastUpdated: { kind: 'expression', expr: 'now', bindings: {} },
          },
        },
      ],
    })
    await composer.apply(input([block({ id: 'room', name: 'Living room', composition: ROOM })]))
    let open: () => void = () => undefined
    hub.slowRead = new Promise<void>((resolve) => {
      open = resolve
    })
    // An event that reads the hub is on the tracker chain first; the apply's sync queues behind it.
    const event = composer.onBindingsChanged({
      deviceId: 11,
      capName: 'temperature-sensor',
      reason: 'native-registered',
      addonId: HA,
    })
    hub.setSlice(11, 'temperature-sensor', { temperature: 25, lastFetchedAt: 990_100 })
    const applied = composer.apply(
      input([
        block({ id: 'room', name: 'Living room', composition: ROOM }),
        block({ id: 'bat', name: 'Battery', composition: BATTERY_ROOM }),
      ]),
    )
    for (let i = 0; i < 20; i++) await Promise.resolve()
    hub.slowRead = null
    open()
    await event
    await applied
    const battery = targets.get('composed-bat')
    expect(battery?.availability).toEqual([true])
  })
})

describe('rule 7 — disabling or deleting a block releases its claims, healed by the gate', () => {
  it('disabled: an added cap stops; the claim stays until a later apply agrees it is unwanted (D49)', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    const off = await composer.apply(input([block({ composition: ADD_BATTERY, enabled: false })]))
    await flush()
    expect(off.blocks[0]).toMatchObject({ status: 'stopped' })
    expect(hub.claim(FEEDER_ID, 'battery')).toMatchObject({ owner: 'b1' })
    await composer.apply(input([block({ composition: ADD_BATTERY, enabled: false })]))
    await flush()
    expect(calls('release:')).toEqual([`release:${FEEDER_ID}#battery`])
    expect(hub.claim(FEEDER_ID, 'battery')).toBeUndefined()
  })

  it('deleted: released on the second apply that omits it', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    await composer.apply(input([]))
    expect(hub.claim(FEEDER_ID, 'battery')).toMatchObject({ owner: 'b1' })
    await composer.apply(input([]))
    expect(hub.claim(FEEDER_ID, 'battery')).toBeUndefined()
  })

  it('delete then create on the same device: the replacement runs', async () => {
    hub.setSlice(FOOD_ID, 'binary', { on: false, lastChangedAt: 1_000_000 })
    await composer.apply(
      input([block({ id: 'old', name: 'customize:old', composition: DOORBELL })]),
    )
    await flush()
    expect(hub.claim(CAM_ID, 'doorbell')?.owner).toBe('old')

    const created = await composer.apply(
      input([block({ id: 'fresh', name: 'customize:fresh', composition: DOORBELL })], {
        retiredBlockIds: ['old'],
      }),
    )
    await flush()

    expect(created.blocks).toEqual([{ blockId: 'fresh', status: 'running' }])
    expect(hub.claim(CAM_ID, 'doorbell')?.owner).toBe('fresh')
  })

  it('an edit that drops a claimed cap releases it before the apply returns', async () => {
    hub.setSlice(FOOD_ID, 'binary', { on: false, lastChangedAt: 1_000_000 })
    await composer.apply(input([block({ composition: DOORBELL })]))
    await flush()
    expect(hub.claim(CAM_ID, 'doorbell')?.owner).toBe('b1')

    await composer.apply(input([block({ composition: DISABLED_DOORBELL, updatedAt: 2 })]))

    expect(hub.claim(CAM_ID, 'doorbell')).toBeUndefined()
  })

  it('a retired claim whose release fails is reported with the device', async () => {
    hub.setSlice(FOOD_ID, 'binary', { on: false, lastChangedAt: 1_000_000 })
    await composer.apply(
      input([block({ id: 'old', name: 'customize:old', composition: DOORBELL })]),
    )
    await flush()
    hub.failReleases = 1

    const created = await composer.apply(input([], { retiredBlockIds: ['old'] }))

    expect(created.unreleasedClaims).toEqual([
      expect.objectContaining({
        deviceId: CAM_ID,
        capName: 'doorbell',
        owner: 'old',
        error: 'hub unreachable',
      }),
    ])
    expect(hub.claim(CAM_ID, 'doorbell')?.owner).toBe('old')
    const warned = log.lines.filter(
      (line) =>
        line.level === 'warn' &&
        line.message.includes('claim release did not land') &&
        line.extras?.tags?.deviceId === CAM_ID,
    )
    expect(warned).toHaveLength(1)
  })
})

describe('rule 8 — a released field makes the block degraded (S1b), and it is the runtime that releases, not the gate', () => {
  it('an added field whose source unregisters says unknown and keeps the claim', async () => {
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(hub.claim(FEEDER_ID, 'battery')?.values).toMatchObject({ charging: 'dc' })
    hub.unbind(CAM_ID, 'battery')
    await composer.onBindingsChanged({
      deviceId: CAM_ID,
      capName: 'battery',
      reason: 'native-unregistered',
      addonId: HA,
    })
    await flush()
    // ONE event, no apply in between: the native value already shows (D393 — never a composed value whose source is gone).
    // An added field that can say 'unknown' stays claimed: there is no native charging to hand back.
    expect(calls('release:')).toEqual([])
    expect(hub.claim(FEEDER_ID, 'battery')).toMatchObject({
      owner: 'b1',
      values: { charging: 'unknown' },
    })
    expect(composer.getStates(['b1'])[0]).toMatchObject({ status: 'running' })
  })
})

describe('the target description is refreshed after `device.bindings-changed`', () => {
  it('a block waiting on an unreadable description re-reads it; a settled block is re-planned only by the operator', async () => {
    hub.failBindings(FEEDER_ID)
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    hub.healBindings(FEEDER_ID)
    await composer.onBindingsChanged({
      deviceId: FEEDER_ID,
      capName: 'binary',
      reason: 'native-registered',
      addonId: HA,
    })
    const healed = await composer.apply(input([block({ composition: ADD_BATTERY })]))
    await flush()
    expect(healed.blocks[0]).toEqual({ blockId: 'b1', status: 'running' })
    const reads = calls(`describe:${FEEDER_ID}`).length
    await composer.onBindingsChanged({
      deviceId: FEEDER_ID,
      capName: 'binary',
      reason: 'native-registered',
      addonId: HA,
    })
    await composer.apply(input([block({ composition: ADD_BATTERY })]))
    expect(calls(`describe:${FEEDER_ID}`).length).toBe(reads)
  })
})

describe('declarations', () => {
  it('an existing target never reaches DeclaredDevices — the owner filter stays load-bearing', async () => {
    await composer.apply(
      input([
        block({ composition: ADD_BATTERY }),
        block({ id: 'room', name: 'Living room', composition: ROOM }),
      ]),
    )
    expect(declared.at(-1)).toEqual(['composed-room'])
  })
})
